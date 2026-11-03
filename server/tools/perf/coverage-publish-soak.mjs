// DUMMY feed only. Real receiver/pipeline/AppStore/status; all storage is local.
import * as fs from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { AppStore } from "../../src/store/app.ts";
import { Pipeline } from "../../src/pipeline.ts";
import { Receiver } from "../../src/ingest/receiver.ts";
import { MarketReceiver } from "../../src/ingest/markets.ts";
import { Upstream } from "../../src/upstream/connection.ts";
import { createStatusApp } from "../../src/status/app.ts";
import { MainThreadMonitor } from "../../src/diagnostics/main-thread.ts";
import { EventLoopMonitor } from "../../src/diagnostics/event-loop.ts";
import { digest } from "../../src/store/objects.ts";
const output = path.resolve(`data/dev/coverage-publish-soak/run-${Date.now()}-${process.pid}`);
const seconds = Number(process.argv[2] ?? 900);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) throw Error("invalid_dummy_duration");
await fs.mkdir(output, { recursive: true });
const eventCounts = {}, events = [], samples = [], expected = { NQ: 0, GC: 0 };
const log = (event, fields) => {
  eventCounts[event] = (eventCounts[event] ?? 0) + 1;
  if (/failed|error|stall|long_callback|compaction/.test(event)) events.push({ event, fields });
};
const files = new Map();
const sourceHashes = [];
const manifestFile = "data/dev/main-thread-snapshot/manifest.json";
const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
for (const f of manifest.files) files.set(f.source.replace(/^prod\//, "dev/"), f.file);
sourceHashes.push({ file: manifestFile, sha256: await digest(manifestFile) });
for (const [symbol, prefix] of [["NQ", "dev/"], ["GC", "dev/instruments/GC/"]]) {
  const source = `data/dev/main-thread-snapshot/${prefix}coverage.json`;
  files.set(prefix + "coverage.json", path.resolve(source));
  sourceHashes.push({ file: source, sha256: await digest(source) });
}
const objects = {
  async list(prefix) { return [...files.keys()].filter(k => k.startsWith(prefix)); },
  async exists(name) { return files.has(name); },
  async download(name, file) {
    const source = files.get(name); if (!source) throw Error("dummy_missing");
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.copyFile(source, file);
  },
  async upload(name, file) {
    if (!name.startsWith("dev/") || name.includes("..")) throw Error("nonisolated_write");
    const dst = path.join(output, "objects", name);
    await fs.mkdir(path.dirname(dst), { recursive: true }); await fs.copyFile(file, dst); files.set(name, dst);
  },
};
const markets = new Map();
const dummyRequest = async () => new Response('{"book":[],"ticks":[],"truncated":false}', {
  status: 200, headers: { "Content-Type": "application/json" } });
for (const [symbol, prefix] of [["NQ", "dev/"], ["GC", "dev/instruments/GC/"]]) {
  let receiver;
  const store = new AppStore(path.join(output, "working", symbol), objects, prefix, log, Date.now, symbol);
  const pipeline = new Pipeline("DUMMY-NOT-A-SECRET", () => receiver.nextSequence(), log, () => {},
    store, symbol, dummyRequest);
  receiver = new Receiver(log, { book: b => pipeline.book(b), trade: t => pipeline.trade(t) }, symbol);
  await pipeline.initialize();
  // Deliberately known-empty DUMMY startup history. Not mixed with real market files.
  const seam = Math.floor(Date.now() / 1000);
  store.markCovered("book", seam - 86400, seam);
  store.markCovered("tick", seam - 86400, seam);
  await store.maintenance(); await store.publicationSettled();
  markets.set(symbol, { receiver, pipeline, store });
}
// Explicit TEST opt-in to count >=200ms callbacks. Production default stays off.
const loop = new EventLoopMonitor(), monitor = new MainThreadMonitor(log, () => {}, true);
loop.start(); monitor.start();
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise(r => wss.once("listening", r));
const peers = new Set();
wss.on("connection", ws => {
  peers.add(ws); ws.once("close", () => peers.delete(ws));
  ws.send('{"type":"welcome","symbols":["NQ","GC"]}');
});
const nq = markets.get("NQ"), gc = markets.get("GC");
const upstream = new Upstream({ apiKey: "DUMMY-NOT-A-SECRET",
  receiver: new MarketReceiver(nq.receiver, gc.receiver), symbols: ["NQ", "GC"], log,
  createSocket: () => new WebSocket(`ws://127.0.0.1:${wss.address().port}`) });
const app = createStatusApp(upstream, nq.receiver, "DUMMY-NOT-A-SECRET", () => nq.pipeline.status(),
  undefined, () => ({ mainThread: monitor.snapshot() }), undefined, undefined, undefined, undefined,
  undefined, undefined, symbol => {
    const m = markets.get(symbol);
    return m ? { receiver: m.receiver, extra: () => m.pipeline.status(), delivery: () => ({}), longVp: null } : null;
  });
const server = app.listen(0, "127.0.0.1");
await new Promise(r => server.once("listening", r));
const started = performance.now(), cpu = process.cpuUsage(), beganUs = Date.now() * 1000;
const threadCpu = process.threadCpuUsage?.();
await fs.writeFile(path.join(output, "ready.json"), JSON.stringify({ pid: process.pid, beganUs, seconds,
  dummy: true, httpPort: server.address().port, fakeWsPort: wss.address().port }));
console.log(JSON.stringify({ event: "soak_ready", output, pid: process.pid, seconds }));
upstream.start();
let generated = 0, timer, sampler, terminating = false;
const send = frame => {
  const body = JSON.stringify(frame); for (const ws of peers) if (ws.readyState === 1) ws.send(body);
};
timer = setInterval(() => {
  generated++;
  const ts = Math.floor(Date.now() / 1000); // Actual provider contract: integer live seconds.
  for (const symbol of ["NQ", "GC"]) {
    const tick = symbol === "NQ" ? .25 : .1, price = symbol === "NQ" ? 120000 : 40000;
    const value = x => Number((x * tick).toFixed(symbol === "NQ" ? 2 : 1));
    send({ type: "book", symbol, ts,
      bids: Array.from({ length: 400 }, (_, i) => [value(price - i), i + 1]),
      asks: Array.from({ length: 400 }, (_, i) => [value(price + i + 1), i + 1]) });
    // 4*10=40 prints/s/symbol, quiet seconds every 10 seconds.
    if (Math.floor(ts) % 10) for (let i = 0; i < 10; i++) {
      send({ type: "tick", symbol, ts, price: value(price + i % 3),
        size: 1 + i % 3, side: i % 2 ? "sell" : "buy", contract: symbol === "GC" ? "GCZ6" : "NQZ6" });
      expected[symbol]++;
    }
  }
  if (generated % 40 === 0) send({ type: "ping" });
}, 250);
let sampling = false;
sampler = setInterval(async () => {
  if (sampling || terminating) return; sampling = true;
  try {
    const status = await fetch(`http://127.0.0.1:${server.address().port}/api/status`).then(r => r.json());
    samples.push({ atUs: Date.now() * 1000, mainThread: status.memory.mainThread,
      stores: [...markets].map(([symbol, m]) => ({ symbol, coverage: m.store.coverageIntervals })) });
    monitor.sample();
    await fs.writeFile(path.join(output, "samples.json"), JSON.stringify(samples));
  } finally { sampling = false; }
}, 5000);
let finish;
const done = new Promise(r => { finish = r; });
process.once("SIGTERM", () => { terminating = true; finish(); });
const deadline = setTimeout(finish, seconds * 1000);
try { await done; }
finally {
  clearTimeout(deadline); clearInterval(timer); clearInterval(sampler); terminating = true;
  const beforeStop = { wallSeconds: (performance.now() - started) / 1000, cpu: process.cpuUsage(cpu),
    mainThreadCpu: threadCpu ? process.threadCpuUsage(threadCpu) : null,
    eventLoop: loop.snapshot(), mainThread: monitor.snapshot(), expected,
    accepted: Object.fromEntries([...markets].map(([s, m]) => [s, m.receiver.metrics.counts.acceptedTrade])),
    stores: Object.fromEntries([...markets].map(([s, m]) => [s, m.store.coverageIntervals])),
    rss: process.memoryUsage().rss, eventCounts, upstream: upstream.receiveDiagnostics() };
  await upstream.stop();
  const cleanupErrors = [];
  for (const [symbol, m] of markets) {
    try { m.store.beginShutdown(AbortSignal.timeout(10000)); await m.pipeline.stop(); }
    catch { cleanupErrors.push({ symbol, reason: "isolated_pipeline_stop_failed" }); }
  }
  for (const peer of peers) peer.terminate();
  await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  monitor.stop(); loop.stop();
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ ...beforeStop, endedUs: Date.now() * 1000,
    dummy: true, events, asyncHookCountAvailable: monitor.snapshot().asyncHooksEnabled,
    cleanup: { upstreamState: upstream.status.state, fakePeers: peers.size, httpListening: server.listening, cleanupErrors,
      browserLaunched: false }, sourceHashes }, null, 2));
  console.log(JSON.stringify({ ...beforeStop, cleanup: { upstream: upstream.status.state, peers: peers.size } }));
  if (cleanupErrors.length) process.exitCode = 1;
}
