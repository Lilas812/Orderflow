// Read-only production-copy input, loopback dummy WS/REST, disposable stores.
// Usage: node server/tools/perf/receive-stall-benchmark.mjs matrix <baseline-sha>
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";
import { createHistogram } from "node:perf_hooks";

const here = new URL(import.meta.url).pathname;
const workspace = resolve(new URL("../../../", import.meta.url).pathname);
const fixture = join(workspace, "data/gpu-heatmap/production-input/replay.json");
const out = join(workspace, "data/receive-stall");
const percentile = (h, n) => h.count ? h.percentile(n) / 1e6 : null;
const wait = ms => new Promise(r => setTimeout(r, ms));

if (process.argv[2] === "fake") {
  const input = JSON.parse(await readFile(fixture, "utf8"));
  const seconds = Number(process.argv[3] ?? 600);
  const bySecond = Object.fromEntries(["NQ", "GC"].map(s => [s, new Map(input.boards[s].map(c => [c.tsSec - input.startSec, c]))]));
  // Choose once, deterministically: the GC-busiest recorded receive-time
  // 10-minute window (minute-aligned). No future line/price selection is involved.
  let offset = 0, mostGc = -1;
  for (let candidate = 0; candidate <= 3000; candidate += 60) {
    const count = input.trades.GC.filter(t => t.recvUs >= (input.startSec + candidate) * 1e6
      && t.recvUs < (input.startSec + candidate + 600) * 1e6).length;
    if (count > mostGc) { mostGc = count; offset = candidate; }
  }
  const sourceStartSec = input.startSec + offset;
  const trades = ["NQ", "GC"].flatMap(symbol => input.trades[symbol].map((trade, index) => ({ symbol, trade, index })))
    .filter(e => e.trade.recvUs >= sourceStartSec * 1e6 && e.trade.recvUs < (sourceStartSec + seconds) * 1e6)
    .sort((a, b) => a.trade.recvUs - b.trade.recvUs || a.symbol.localeCompare(b.symbol) || a.index - b.index);
  const expected = Object.fromEntries(["NQ", "GC"].map(s => [s, {
    count: trades.filter(e => e.symbol === s).length,
    quantity: trades.filter(e => e.symbol === s).reduce((sum, e) => sum + e.trade.size, 0),
  }]));
  const missing = Object.fromEntries(["NQ", "GC"].map(s => [s,
    Array.from({ length: seconds }, (_, i) => i).filter(i => !bySecond[s].has(offset + i))]));
  const subsetSha256 = createHash("sha256").update(JSON.stringify({ offset, seconds, trades,
    boards: Object.fromEntries(["NQ", "GC"].map(s => [s, Array.from({ length: seconds }, (_, i) => bySecond[s].get(offset + i) ?? null)])),
  })).digest("hex");
  let index = 0;
  const clients = new Set();
  const base = Math.ceil(Date.now() / 1000) + 4;
  const api = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const start = Number(url.searchParams.get("start")), end = Number(url.searchParams.get("end"));
    const symbol = url.searchParams.get("symbol") === "GC" ? "GC" : "NQ";
    const isBook = url.pathname.endsWith("/book");
    res.setHeader("Content-Type", "application/json");
    if (!isBook) { res.end('{"ticks":[],"truncated":false}'); return; }
    // 208 full snapshots (166,400 rows) per minute, generated in the dummy
    // server, not in the measured receiver process.
    const priceBase = symbol === "GC" ? 40000 : 118000, tick = symbol === "GC" ? .1 : .25;
    function* body() {
      yield '{"book":[';
      const snapshots = Math.max(1, Math.floor((end - start) * 208 / 60));
      for (let k = 0; k < snapshots; k++) {
        if (res.destroyed) return;
        const ts = start * 1e6 + Math.floor(k * (end - start) * 1e6 / snapshots);
        const rows = [];
        for (const side of ["bid", "ask"]) for (let level = 1; level <= 400; level++) {
          rows.push({ ts, side, level, flag: 0,
            price: (priceBase + (side === "bid" ? -level : level)) * tick, size: level });
        }
        yield (k ? "," : "") + JSON.stringify(rows).slice(1, -1);
      }
      yield '],"truncated":false}';
    }
    Readable.from(body()).on("error", () => res.destroy()).pipe(res);
  });
  await new Promise(r => api.listen(0, "127.0.0.1", r));
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(r => wss.once("listening", r));
  wss.on("connection", ws => {
    clients.add(ws); ws.once("close", () => clients.delete(ws));
    ws.send('{"type":"welcome","symbols":["NQ","GC"]}');
  });
  const send = frame => { const body = JSON.stringify(frame); for (const ws of clients) if (ws.readyState === 1) ws.send(body); };
  const boards = setInterval(() => {
    const sec = Math.floor(Date.now() / 1000) - base;
    if (sec < 0 || sec >= seconds) return;
    for (const symbol of ["NQ", "GC"]) {
      const column = bySecond[symbol].get(offset + sec), tick = symbol === "GC" ? .1 : .25;
      if (column) send({ type: "book", symbol, ts: base + sec,
        bids: column.bids.map(r => [r.price * tick, r.size]), asks: column.asks.map(r => [r.price * tick, r.size]) });
    }
  }, 1000 / 3.4);
  const drainTrades = elapsed => {
    if (elapsed < 0) return;
    while (index < trades.length) {
      const { symbol, trade: t } = trades[index], tick = symbol === "GC" ? .1 : .25;
      if ((t.recvUs - sourceStartSec * 1e6) / 1000 > elapsed) break;
      index++;
      send({ type: "tick", symbol, ts: (t.tsUs - sourceStartSec * 1e6) / 1e6 + base,
        price: t.price * tick, size: t.size, side: t.side });
    }
  };
  const ticks = setInterval(() => drainTrades(Date.now() - base * 1000), 1);
  const ping = setInterval(() => send({ type: "ping" }), 15000);
  const finish = setTimeout(() => {
    clearInterval(boards); clearInterval(ticks); clearInterval(ping);
    drainTrades(seconds * 1000);
    // Consumed by the measurement wrapper, never by the product receiver.
    // A TCP-ordered sentinel prevents the last buffered inputs being omitted.
    send({ type: "__benchmark_end" });
  }, Math.max(0, (base + seconds) * 1000 - Date.now()));
  process.send?.({ type: "ready", base, api: `http://127.0.0.1:${api.address().port}`,
    ws: `ws://127.0.0.1:${wss.address().port}`, fixtureStartSec: sourceStartSec,
    expected, missing, subsetSha256, offset });
  const stop = () => {
    clearInterval(boards); clearInterval(ticks); clearInterval(ping);
    clearTimeout(finish);
    for (const ws of clients) ws.terminate();
    wss.close(); api.closeAllConnections(); api.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop); process.on("disconnect", stop);
} else if (process.argv[2] === "run") {
  const root = process.argv[3], mode = process.argv[4], repeat = Number(process.argv[5]);
  const seconds = Number(process.argv[6] ?? 600);
  const load = async file => import(pathToFileURL(join(root, "server/src", file)).href);
  const { Pipeline } = await load("pipeline.ts"), { Receiver } = await load("ingest/receiver.ts");
  const { LocalStore } = await load("store/local.ts"), { Upstream } = await load("upstream/connection.ts");
  const { MarketReceiver } = await load("ingest/markets.ts");
  const { CpuPressure } = await import("../../src/diagnostics/cpu-pressure.ts");
  const { EventLoopMonitor } = await import("../../src/diagnostics/event-loop.ts");
  const pressure = new CpuPressure(), loop = new EventLoopMonitor(); loop.start();
  const fake = fork(here, ["fake", String(seconds)], { stdio: ["ignore", "ignore", "inherit", "ipc"], env: { PATH: process.env.PATH ?? "" } });
  const endpoints = await new Promise((resolve, reject) => {
    fake.once("message", resolve); fake.once("error", reject); fake.once("exit", () => reject(Error("fake_failed")));
  });
  const directory = await mkdtemp(join(tmpdir(), "heatmap-stall-"));
  const events = Object.create(null), timeline = [], raw = createHistogram(), accepted = createHistogram(),
    pong = createHistogram(), delays = createHistogram();
  const acceptedBySymbol = { NQ: createHistogram(), GC: createHistogram() };
  const quantities = { NQ: 0, GC: 0 }, lastAcceptedBySymbol = { NQ: null, GC: null };
  let lastAccepted = null, measurementStarted = false, completed;
  const complete = new Promise(resolve => { completed = resolve; });
  const observeAccepted = symbol => {
    if (!measurementStarted) return;
    const at = performance.now();
    if (lastAccepted !== null) accepted.record(Math.max(1, Math.round((at - lastAccepted) * 1e6)));
    if (lastAcceptedBySymbol[symbol] !== null) acceptedBySymbol[symbol]
      .record(Math.max(1, Math.round((at - lastAcceptedBySymbol[symbol]) * 1e6)));
    lastAccepted = at; lastAcceptedBySymbol[symbol] = at;
  };
  let lastReceive = null, lastPing = null, loopAt = performance.now(), pool = null;
  const log = (event, details) => { events[event] = (events[event] ?? 0) + 1; };
  const request = (input, init) => {
    const url = new URL(String(input)), origin = new URL(endpoints.api);
    url.protocol = origin.protocol; url.host = origin.host;
    return fetch(url, init);
  };
  if (mode === "after") {
    const { HistoryProcess } = await load("history/process.ts");
    pool = new HistoryProcess("dummy-only", log, () => ({
      loopP99Ms: loop.window(10000).p99Ms, throttledRatio: pressure.snapshot().throttledRatio,
    }), endpoints.api);
  }
  const receivers = {}, pipelines = {};
  for (const symbol of ["NQ", "GC"]) {
    const pipeline = new Pipeline("dummy-only", () => receivers[symbol].nextSequence(), log, () => {},
      new LocalStore(join(directory, symbol), Date.now, undefined, symbol), symbol, request, pool ?? undefined);
    const receiver = new Receiver(log, {
      book: b => { observeAccepted(symbol); pipeline.book(b); },
      trade: t => { observeAccepted(symbol); quantities[symbol] += t.size; pipeline.trade(t); },
    }, symbol);
    receivers[symbol] = receiver; pipelines[symbol] = pipeline;
    await pipeline.initialize();
  }
  const u = new Upstream({ apiKey: "dummy-only", receiver: new MarketReceiver(receivers.NQ, receivers.GC),
    symbols: ["NQ", "GC"], log, loopPauseMs: () => loop.window(30000).maxMs,
    createSocket: () => {
      const ws = new WebSocket(endpoints.ws);
      return { get readyState() { return ws.readyState; },
        addEventListener(type, fn) { ws.addEventListener(type, type !== "message" ? fn : e => {
          if (e.data === '{"type":"__benchmark_end"}') { completed(); return; }
          const at = performance.now();
          if (lastReceive !== null) raw.record(Math.max(1, Math.round((at - lastReceive) * 1e6)));
          lastReceive = at;
          if (typeof e.data === "string" && e.data.includes('"type":"ping"')) lastPing = at;
          fn(e);
        }); },
        send(body) { ws.send(body); if (body === '{"op":"pong"}' && lastPing !== null)
          pong.record(Math.max(1, Math.round((performance.now() - lastPing) * 1e6))); },
        close(code) { ws.close(code); } };
    } });
  const loopTimer = setInterval(() => {
    const at = performance.now(); delays.record(Math.max(1, Math.round((at - loopAt) * 1e6))); loopAt = at;
  }, 10);
  let sampler = null;
  try {
    u.start();
    await wait(Math.max(0, endpoints.base * 1000 - Date.now()));
    raw.reset(); delays.reset(); pong.reset(); lastReceive = null; measurementStarted = true;
    const begin = performance.now(), cpu = process.cpuUsage();
    await pressure.sample();
    sampler = setInterval(async () => {
      await pressure.sample();
      timeline.push({ elapsedSeconds: (performance.now() - begin) / 1000,
        pressure: pressure.snapshot(), loop: loop.window(10000), child: pool?.snapshot() ?? null });
    }, 5000);
    const timeout = setTimeout(() => completed("timeout"), (seconds + 35) * 1000);
    const reason = await complete; clearTimeout(timeout);
    if (reason === "timeout") throw Error("input_sentinel_timeout");
    measurementStarted = false;
    const elapsedSeconds = (performance.now() - begin) / 1000, usage = process.cpuUsage(cpu);
    if (sampler) clearInterval(sampler);
    const child = pool?.snapshot() ?? null;
    const symbols = Object.fromEntries(Object.entries(pipelines).map(([s, p]) => [s, {
      windows: p.backfill.status.completedWindows, windowsPerMinute: p.backfill.status.completedWindows / elapsedSeconds * 60,
      liveGaps: p.status().liveGaps, history: { ...p.client.stats }, metrics: { ...receivers[s].metrics.counts },
      accepted: { p99Ms: percentile(acceptedBySymbol[s], 99), maxMs: acceptedBySymbol[s].max / 1e6 },
      quantity: quantities[s], expected: endpoints.expected[s],
      unexpectedGapSeconds: p.status().liveGaps.reduce((sum, gap) => sum
        + Array.from({ length: gap.endSec === null ? 0 : gap.endSec - gap.startSec }, (_, i) => gap.startSec + i - endpoints.base)
          .filter(sec => sec >= 0 && sec < seconds - 1 && !endpoints.missing[s].includes(sec)).length, 0),
    }]));
    for (const s of ["NQ", "GC"]) {
      if (symbols[s].metrics.acceptedTrade !== endpoints.expected[s].count || quantities[s] !== endpoints.expected[s].quantity)
        throw Error(`input_quantity_mismatch_${s}`);
    }
    const result = { label: "ダミー", mode, repeat, baselineOrCandidateRoot: root, seconds, elapsedSeconds,
      input: { path: fixture, sha256: createHash("sha256").update(await readFile(fixture)).digest("hex"),
        sourceStartSec: endpoints.fixtureStartSec, timestampRebased: true, boardsPerSecondPerSymbol: 3.4,
        offset: endpoints.offset, expected: endpoints.expected, missing: endpoints.missing, subsetSha256: endpoints.subsetSha256,
        historyBookRowsPer60sWindow: 166400, historyTicks: "dummy_empty", receivedTrades: Object.fromEntries(
          Object.entries(receivers).map(([s, r]) => [s, r.metrics.counts.acceptedTrade])) },
      receive: { samples: raw.count, p99Ms: percentile(raw, 99), maxMs: raw.count ? raw.max / 1e6 : null },
      accepted: { samples: accepted.count, p99Ms: percentile(accepted, 99), maxMs: accepted.max / 1e6 },
      eventLoop: { samples: delays.count, p99Ms: percentile(delays, 99), maxMs: delays.max / 1e6 },
      pong: { samples: pong.count, p99Ms: percentile(pong, 99), maxMs: pong.count ? pong.max / 1e6 : null },
      parentCpuCores: (usage.user + usage.system) / 1e6 / elapsedSeconds,
      parentRss: process.memoryUsage().rss, child, events, timeline, symbols };
    await mkdir(out, { recursive: true });
    await writeFile(join(out, `${mode}-${repeat}-${seconds}s.json`), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ mode, repeat, seconds, parentCpuCores: result.parentCpuCores,
      receive: result.receive, eventLoop: result.eventLoop, pong: result.pong }));
  } finally {
    if (sampler) clearInterval(sampler);
    clearInterval(loopTimer); loop.stop();
    await u.stop();
    await Promise.all(Object.values(pipelines).map(p => p.stop()));
    await pool?.stop();
    const stopped = new Promise(r => fake.once("exit", r));
    fake.kill("SIGTERM"); await stopped;
    await rm(directory, { recursive: true, force: true });
  }
} else if (process.argv[2] === "matrix") {
  const sha = process.argv[3];
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw Error("baseline SHA required");
  const base = await mkdtemp(join(tmpdir(), "heatmap-stall-baseline-"));
  await mkdir(out, { recursive: true });
  try {
    const archive = execFileSync("git", ["archive", sha, "server/src", "server/package.json", "lib/market", "package.json"], { maxBuffer: 32 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", base], { input: archive });
    await symlink(join(workspace, "node_modules"), join(base, "node_modules"));
    await symlink(join(workspace, "server/node_modules"), join(base, "server/node_modules"));
    await writeFile(join(out, "baseline.json"), JSON.stringify({ sha, root: base, fixture, secondsPerRun: 600, repeats: 3 }));
    for (const mode of ["before", "after"]) for (let repeat = 0; repeat < 3; repeat++) {
      if (mode === "after") {
        // The caller must finish implementation/tests before allowing candidates.
        for (;;) { try { await readFile(join(out, "candidate-ready")); break; } catch { await wait(1000); } }
      }
      const child = fork(here, ["run", mode === "before" ? base : workspace, mode, String(repeat), "600"],
        { stdio: "inherit", env: { PATH: process.env.PATH ?? "" } });
      await new Promise((resolve, reject) => { child.once("exit", code => code === 0 ? resolve() : reject(Error(`run_failed_${code}`))); });
    }
  } finally { await rm(base, { recursive: true, force: true }); }
} else throw Error("Expected fake, run or matrix");
