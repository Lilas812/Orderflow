/** Read-only replay of an existing production copy. NO upstream/cloud/settings writes. */
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Hub, attachHub, type Source } from "../src/hub/hub.ts";
import { WindowedReplay } from "../src/hub/windowed-replay.ts";
import { columnFileRange, tradeFileRows } from "../src/store/records.ts";
import { defaults } from "../src/settings/schema.ts";
import { VolumeProfile } from "../src/vp/state.ts";
import { clipRanges, subtractRanges } from "../../artifacts/heatmap/src/footprint/model.ts";
import type { Trade } from "../src/types.ts";
import type { Column } from "../src/aggregate/columns.ts";
import type { MarketSymbol } from "../../lib/market/instruments.ts";
import express from "express";
import { LabelsStore } from "../src/labels/store.ts";
import { LabelsCloudFixture } from "./labels-cloud-fixture.ts";
import { labelsRouter } from "../src/labels/routes.ts";
import { LocalStore } from "../src/store/local.ts";
import { HistoryProcess } from "../src/history/process.ts";

const port = Number(process.argv.find(a => a.startsWith("--port="))?.slice(7) ?? 18885);
const frontRoot = path.resolve(process.argv.find(a => a.startsWith("--front-root="))?.slice(13) ?? "artifacts/heatmap/dist/public");
const manifestFile = "data/gpu-heatmap/production-input/manifest.json";
const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
const from = manifest.chosen.start, end = from + 3600;
const sources = new Map<MarketSymbol, { trades: Trade[]; columns: Column[]; coverage: [number, number][] }>();
const replayClockStart = Date.now();
const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
const replayWorkMax: Record<string, number> = {};
for (const name of ["advance", "window"]) {
  const proto = WindowedReplay.prototype as unknown as Record<string, (...args: unknown[]) => unknown>, original = proto[name]!;
  proto[name] = function (...args: unknown[]) {
    const at = performance.now();
    try { return original.apply(this,args); }
    finally { replayWorkMax[name] = Math.max(replayWorkMax[name] ?? 0, performance.now()-at); }
  };
}
let metricsCpu = process.cpuUsage(), metricsAt = performance.now();
const metricsSockets = new Set<{ _socket?: { bytesWritten: number } }>();
let metricsBytes = 0;
const inputs: { file: string; sha256: string }[] = [];
for (const symbol of ["NQ", "GC"] as const) {
  const prefix = symbol === "NQ" ? "prod/" : "prod/instruments/GC/";
  const data = { trades: [] as Trade[], columns: [] as Column[], coverage: [] as [number, number][] };
  for (const entry of manifest.copied) {
    if (!entry.name.startsWith(prefix)) continue;
    const isTick = entry.name.includes(`/trades/${symbol}/`);
    const isBook = entry.name.includes(`/columns/${symbol}/`);
    const isCoverage = entry.name === prefix + "coverage.json";
    if (!isTick && !isBook && !isCoverage) continue;
    if (!isCoverage) {
      const iso = new Date(from * 1000).toISOString();
      const stamp = entry.name.match(/(\d{4}-\d{2}-\d{2})\/(\d{2})\./);
      if (!stamp || stamp[1] !== iso.slice(0, 10) || ![iso.slice(11, 13), new Date(end * 1000).toISOString().slice(11, 13)].includes(stamp[2]!)) continue;
    }
    const hash = createHash("sha256").update(await fs.readFile(entry.local)).digest("hex");
    if (hash !== entry.sha256) throw Error("input_hash_changed");
    inputs.push({ file: entry.local, sha256: hash });
    if (isTick) for await (const t of tradeFileRows(entry.local)) {
      if (t.tsUs >= from * 1e6 && t.tsUs < end * 1e6) data.trades.push(t);
    }
    if (isBook) for await (const c of columnFileRange(entry.local, from, end)) data.columns.push(c);
    if (isCoverage) data.coverage = clipRanges(JSON.parse(await fs.readFile(entry.local, "utf8")).tick, from, end);
  }
  sources.set(symbol, data);
}
const log = (event: string, detail?: unknown) => {
  console.info(JSON.stringify({ isolatedReplay: true, noUpstream: true, event, detail }));
  if (event === "hub_connected" || event === "hub_closed") sampleReplayPeers();
};
const hubs = new Map<MarketSymbol, Hub>();
let maxReplayPeers = 0;
const sampleReplayPeers = () => {
  maxReplayPeers = Math.max(maxReplayPeers, [...hubs.values()].reduce((n, h) => n + h.snapshot().connected, 0));
};
for (const [symbol, data] of sources) {
  // Received-only partial profile, not a fabricated complete session.
  const vp = new VolumeProfile(end);
  for (const t of data.trades) vp.add(t);
  if (process.argv.includes("--partial-vp-ready")) vp.complete(vp.start);
  const source: Source = {
    vp: () => vp,
    savedRange: () => ({ fromSec: from, toSec: end }),
    read: async (a, b) => ({ trades: data.trades.filter(t => t.tsUs >= a * 1e6 && t.tsUs < b * 1e6), columns: data.columns.filter(c => c.tsSec >= a && c.tsSec < b) }),
    readTrades: async (a, b, visit, signal) => {
      for (const t of data.trades) { signal.throwIfAborted(); if (t.tsUs >= a * 1e6 && t.tsUs < b * 1e6) visit(t); }
      return { coverage: clipRanges(data.coverage, a, b), gaps: subtractRanges([[a, b]], data.coverage).map(([startSec, endSec]) => ({ startSec, endSec, reason: "recorded_coverage_gap" })), noData: [], quality: "recorded_not_guaranteed" };
    },
    status: () => ({ isolatedReplay: true, partialCopy: true, profileInput: { from, end } }),
    replayVp: async (cursor, alive) => {
      const profile = new VolumeProfile(cursor);
      for (const t of data.trades) if (alive() && t.tsUs >= profile.start * 1e6 && t.tsUs < cursor * 1e6) profile.add(t);
      profile.complete(profile.start);
      return profile;
    },
  };
  hubs.set(symbol, new Hub(source, log, { now: () => end * 1000 + (process.argv.includes("--moving-clock") ? Date.now() - replayClockStart : 0),
    later: (f, ms) => setTimeout(f, ms), cancel: id => clearTimeout(id as NodeJS.Timeout) }, symbol));
}
const labelsMode = process.argv.includes("--labels-test");
const labelCloud = new LabelsCloudFixture();
const labelsWorker = new HistoryProcess("ISOLATED-NO-API", log);
const labelsApp = express();
const labelStores = new Map((["NQ", "GC"] as const).map(symbol => [symbol,
  new LocalStore(path.resolve("data/gpu-heatmap/production-input/prod", symbol === "GC" ? "instruments/GC" : ""),
    Date.now, fs.rename, symbol)]));
// No initialize/flush/retention on these read-only source stores. Only request-owned copies are written.
if (labelsMode) labelsApp.use("/api/labels", labelsRouter({
  labels: new LabelsStore(labelCloud, "dev/"), history: labelsWorker, store: symbol => labelStores.get(symbol)!,
}));
const app = createServer(async (req, res) => {
  if (labelsMode && req.url?.startsWith("/api/labels")) { labelsApp(req, res); return; }
  if (labelsMode && req.url?.startsWith("/labels-test-status")) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "POST") {
      labelCloud.failRead = url.searchParams.get("readFail") === "1";
      labelCloud.failWrite = url.searchParams.get("writeFail") === "1";
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ isolated: true, pid: process.pid, cloudWrites: labelCloud.writes,
      worker: labelsWorker.snapshot(), failRead: labelCloud.failRead, noRealCloud: true, noUpstream: true })); return;
  }
  const u = new URL(req.url!, "http://127.0.0.1");
  if (u.pathname === "/__replay") {
    const totalBytes = () => {
      // attachHub uses handleUpgrade directly, without emitting wss "connection".
      for (const peer of ws.clients) metricsSockets.add(peer as unknown as { _socket?: { bytesWritten: number } });
      return [...metricsSockets].reduce((n,s) => n + (s._socket?.bytesWritten ?? 0), 0);
    };
    if (u.searchParams.has("reset")) { metricsCpu = process.cpuUsage(); metricsAt = performance.now(); eventLoop.reset(); metricsBytes = totalBytes(); maxReplayPeers = [...hubs.values()].reduce((n, h) => n + h.snapshot().connected, 0); for (const k of Object.keys(replayWorkMax)) replayWorkMax[k]=0; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ from, end, inputs,
      metrics: { elapsedMs: performance.now() - metricsAt, cpu: process.cpuUsage(metricsCpu), eventLoopMaxMs: eventLoop.max / 1e6,
        txWireBytes: totalBytes() - metricsBytes, rss: process.memoryUsage().rss, replayWorkMax },
      peers: [...hubs].map(([s, h]) => [s, h.snapshot().connected]), maxReplayPeers, pid: process.pid,
      symbols: [...sources].map(([s, d]) => {
        const last = d.trades.filter(t => t.tsUs >= (end-600)*1e6);
        return { symbol:s, trades:d.trades.length, quantity:d.trades.reduce((n,t)=>n+t.size,0), columns:d.columns.length,
          last600: { count:last.length, quantity:last.reduce((n,t)=>n+t.size,0), startHasData:d.columns.some(c=>c.tsSec===end-600)||last.some(t=>Math.floor(t.tsUs/1e6)===end-600),
            hash:createHash("sha256").update(last.map(t=>JSON.stringify(t)).sort().join("\n")).digest("hex") } };
      }) })); return;
  }
  if (u.pathname === "/api/settings") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ version: 4, updatedAt: null, values: defaults })); return; }
  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
  const file = path.resolve(frontRoot, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
  if (!file.startsWith(frontRoot + "/")) { res.writeHead(403); res.end(); return; }
  try {
    let body = await fs.readFile(file);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
    if (file.endsWith(".html")) body = Buffer.from(body.toString().replace("</body>", '<div style="position:fixed;bottom:0;left:0;z-index:999;color:#ffb873;background:#111;font:10px monospace">保存コピーの隔離リプレイ / NO UPSTREAM / 板・coverage欠けあり / VPは保存1時間のみの部分集計</div></body>'));
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
const ws = attachHub(app, hubs);
ws.on("connection", peer => metricsSockets.add(peer as unknown as { _socket?: { bytesWritten: number } }));
ws.on("connection", peer => { sampleReplayPeers(); peer.once("close", sampleReplayPeers); });
// Frozen representative saved book; original second/levels retained, no fabricated trade.
const seedBooks = () => { for (const [symbol, h] of hubs) {
  const c = sources.get(symbol)!.columns.at(-1);
  if (c) h.book({ tsUs: c.tsSec * 1e6, recvUs: c.tsSec * 1e6, bids: c.bids, asks: c.asks, source: "history" });
} };
seedBooks();
const bookTimer = setInterval(seedBooks, 1000);
app.listen(port, "127.0.0.1", () => log("replay_ready", { port, pid: process.pid, from, end }));
process.on("SIGTERM", () => {
  void labelsWorker.stop();
  eventLoop.disable();
  clearInterval(bookTimer);
  for (const h of hubs.values()) h.stop();
  for (const peer of ws.clients) peer.terminate();
  ws.close(); app.close(() => log("replay_stopped", { peers: ws.clients.size, noUpstream: true }));
});
