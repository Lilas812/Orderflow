// ダミーREST入力。製品entrypoint・HistoryClient・Objectsは起動しない。
import "./offline.ts";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import inspector from "node:inspector";
import { performance, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { historyColumns, historyTrades } from "../../src/history/decode.ts";
import { Metrics } from "../../src/ingest/metrics.ts";
import { coverageSegments } from "../../src/vp/trade-history.ts";
import { VolumeProfile } from "../../src/vp/state.ts";
import { MemoryMonitor } from "../../src/diagnostics/memory.ts";

const [out, mode, heap, repetition, sampling = "sampled"] = process.argv.slice(2);
assert.match(out ?? "", /^data\/history-investigation-[a-zA-Z0-9_-]+$/);
assert.ok(["idle", "decode", "vp", "combined", "json"].includes(mode));
assert.ok(["on", "off"].includes(heap));
assert.ok(["sampled", "control"].includes(sampling));
await fs.mkdir(out, { recursive: true });
const start = 1793275200, end = start + 60;
const book = Array.from({ length: 240 * 800 }, (_, i) => {
  const snapshot = Math.floor(i / 800), level = i % 400 + 1, bid = i % 800 < 400;
  return { ts: start * 1e6 + snapshot * 250000, side: bid ? "bid" : "ask", level,
    price: (bid ? 80000 - level : 80000 + level) / 4, size: 1 + (snapshot + level) % 50, flag: 0 };
});
const ticks = Array.from({ length: 1200 }, (_, i) => ({
  ts: start * 1e6 + i * 50000, price: (80000 + i % 200) / 4, size: 1 + i % 3, side: i % 2 ? "buy" : "sell",
}));
const fragmented = Array.from({ length: 450 }, (_, i): [number, number] => [start + i * 2, start + i * 2 + 1]);
const compact: [number, number][] = [[start, start + 900]];
const trades = historyTrades(ticks, start, end, new Metrics(() => {}), () => 1);
const input = { dummy: true, bookRows: book.length, snapshots: 240, columns: 60, depthPerSide: 400,
  seconds: 60, tickRows: ticks.length, coverageSeconds: 900, fragmentedIntervals: 450,
  bookJsonBytes: Buffer.byteLength(JSON.stringify(book)), bookGzipBytes: gzipSync(JSON.stringify(book)).length,
  tickJsonBytes: Buffer.byteLength(JSON.stringify(ticks)), tickGzipBytes: gzipSync(JSON.stringify(ticks)).length };
const bookText = mode === "json" ? JSON.stringify(book) : "";
const tickText = mode === "json" ? JSON.stringify(ticks) : "";
let sequence = 0;
function work() {
  if (mode === "json") {
    assert.equal(JSON.parse(bookText).length, 192000);
    assert.equal(JSON.parse(tickText).length, 1200);
  }
  if (mode === "decode" || mode === "combined") {
    const metrics = new Metrics(() => {});
    const columns = historyColumns(book, start, end, metrics);
    const decoded = historyTrades(ticks, start, end, metrics, () => ++sequence);
    assert.equal(columns.length, 60); assert.equal(decoded.length, 1200);
    assert.equal(columns[0].bids[0].size, 5); // last snapshot in second, level 1
  }
  if (mode === "vp" || mode === "combined") {
    const vp = new VolumeProfile(start);
    for (const t of trades) vp.add(t);
    assert.equal(vp.summary().total, 2400);
    assert.equal(vp.message().levels.length, 200);
    const segments = coverageSegments(fragmented, start, start + 900);
    assert.equal(segments.length, 900);
    assert.equal(coverageSegments(compact, start, start + 900).length, 1);
  }
}
work(); work(); // 2 passes warmup, not measured
const session = new inspector.Session(); session.connect();
const post = (method: string) => new Promise<any>((resolve, reject) =>
  session.post(method as any, (err, value) => err ? reject(err) : resolve(value)));
if (sampling === "sampled") {
  await post("Profiler.enable");
  await post("Profiler.start");
}
let gcCount = 0, gcMs = 0;
const gc = new PerformanceObserver(list => { for (const e of list.getEntries()) { gcCount++; gcMs += e.duration; } });
gc.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
const timerDelays: number[] = [], durations: number[] = [], logs: unknown[] = [];
let nextTimer = performance.now() + 10;
const timer = setInterval(() => {
  const now = performance.now(); timerDelays.push(Math.max(0, now - nextTimer)); nextTimer = now + 10;
}, 10);
const monitor = new MemoryMonitor((event, details) => { logs.push({ event, details }); }, () => ({ dummy: true, mode }));
// Redirect only the isolated instance's output, never the existing profiles directory.
(monitor as any).directory = path.resolve(out, "heap");
await delay(30); // arm timers BEFORE the first synchronous work
const memoryBefore = process.memoryUsage(), cpuBefore = process.cpuUsage(), began = performance.now();
if (heap === "on") monitor.start();
let batches = 0;
try {
  // One 60-second input per 5 seconds. 6th MemoryMonitor sample at t=25s includes actual JSON/write.
  for (let n = 0; n < 6; n++) {
    await delay(Math.max(0, began + n * 5000 - performance.now()));
    const t = performance.now(); work(); durations.push(performance.now() - t); batches++;
  }
  await delay(Math.max(0, began + 26500 - performance.now()));
  if (heap === "on") await monitor.stop();
  await delay(30); // capture the timer delayed by final work/profile JSON, not just pre-block samples
} finally { clearInterval(timer); loop.disable(); gc.disconnect(); }
const wallMs = performance.now() - began, cpu = process.cpuUsage(cpuBefore);
const profile = sampling === "sampled" ? (await post("Profiler.stop")).profile : { nodes:[], samples:[],timeDeltas:[] };
session.disconnect();
const label = `${mode}-${heap}-${repetition}${sampling === "control" ? "-control" : ""}`;
await fs.writeFile(path.join(out, label + ".cpuprofile"), JSON.stringify(profile));
await fs.writeFile(path.join(out, label + ".memory.json"), JSON.stringify(logs, null, 2));
const byId = new Map(profile.nodes.map((n: any) => [n.id, n]));
const stacks = new Map<string, number>();
profile.samples?.forEach((id: number, i: number) => {
  const n: any = byId.get(id), f = n.callFrame;
  const key = `${f.functionName || "(anonymous)"} ${f.url}:${f.lineNumber + 1}`;
  stacks.set(key, (stacks.get(key) ?? 0) + profile.timeDeltas[i]);
});
const quantile = (q: number) => timerDelays.slice().sort((a,b) => a-b)[Math.floor((timerDelays.length - 1) * q)] ?? 0;
const result = { label, pid: process.pid, input, warmup: 2, batches, wallMs, cpuMs: (cpu.user + cpu.system) / 1000,
  cores: (cpu.user + cpu.system) / (wallMs * 1000), cpu, durations,
  bookRowsPerSec: mode === "decode" || mode === "combined" ? batches * book.length / (wallMs / 1000) : 0,
  loopMs: { p50: loop.percentile(50)/1e6, p95: loop.percentile(95)/1e6, p99: loop.percentile(99)/1e6, max: loop.max/1e6 },
  timerLatenessMs: { p50: quantile(.5), p95: quantile(.95), p99: quantile(.99), max: Math.max(...timerDelays) },
  gc: { count: gcCount, ms: gcMs }, memoryBefore, memoryAfter: process.memoryUsage(),
  maxRssBytes: process.resourceUsage().maxRSS * 1024,
  stacksUs: [...stacks].sort((a,b) => b[1]-a[1]).slice(0, 25),
  environment: { node: process.version, os: os.release(), platform: os.platform(), cpu: os.cpus()[0].model,
    availableParallelism: os.availableParallelism(), cpuCount: os.cpus().length,
    cpuMax: await fs.readFile("/sys/fs/cgroup/cpu.max", "utf8").catch(() => "unavailable"),
    memoryMax: await fs.readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => "unavailable") } };
await fs.writeFile(path.join(out, label + ".json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ label, pid: process.pid, wallMs, cpuMs: result.cpuMs, cores: result.cores }));
