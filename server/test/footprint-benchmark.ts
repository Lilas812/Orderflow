/** Fixed-input isolation benchmark, NO network/upstream/cloud.
 * node --expose-gc server/test/footprint-benchmark.ts --mode=before|after|fp5|fp60
 * before imports an archived HEAD Hub from --baseline=/tmp/.../server/src/hub/hub.ts */
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hub, type Source } from "../src/hub/hub.ts";
import { TradeAggregator } from "../../artifacts/heatmap/src/data/trade-aggregate.ts";
import { FootprintStore } from "../../artifacts/heatmap/src/footprint/model.ts";
import type { Trade } from "../src/types.ts";

const mode = process.argv.find(a => a.startsWith("--mode="))?.slice(7) ?? "after";
const footprint = mode.startsWith("fp"), tf = mode === "fp60" ? 60 : 5;
const baseline = process.argv.find(a => a.startsWith("--baseline="))?.slice(11) ?? "/tmp/footprint-before/server/src/hub/hub.ts";
const HubClass: typeof Hub = mode === "before" ? (await import(pathToFileURL(baseline).href)).Hub : Hub;
class Clock {
  ms = 600000000; next = 0; jobs = new Map<number, { at: number; fn: () => void }>();
  now = () => this.ms;
  later = (fn: () => void, delay: number) => { const id = ++this.next; this.jobs.set(id, { at: this.ms + delay, fn }); return id; };
  cancel = (id: unknown) => { this.jobs.delete(id as number); };
  advance(ms: number) {
    const to = this.ms + ms;
    for (;;) {
      const item = [...this.jobs].filter(([, j]) => j.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break;
      this.jobs.delete(item[0]); this.ms = item[1].at; item[1].fn();
    }
    this.ms = to;
  }
}
const end = 600000, from = end - 120;
const rows = Array.from({ length: 14000 }, (_, i): Trade => ({
  tsUs: from * 1e6 + Math.floor(i / 100) * 1e6 + i % 100,
  recvUs: from * 1e6 + Math.floor(i / 100) * 1e6 + i % 100 + 1,
  seq: i + 1, price: 84000 + i % 17, size: 1 + i % 3,
  side: i % 2 ? "buy" : "sell", contract: "NQZ26",
}));
const book = { tsUs: end * 1e6, recvUs: end * 1e6, source: "live" as const,
  bids: Array.from({ length: 400 }, (_, i) => ({ price: 83999 - i, size: 1 + i % 9 })),
  asks: Array.from({ length: 400 }, (_, i) => ({ price: 84001 + i, size: 1 + i % 7 })) };
const clock = new Clock(), agg = new TradeAggregator(), fp = new FootprintStore();
fp.hello("dummy", from - 1); fp.setTimeframe(tf);
let bytes = 0, messages = 0, frames = 0, initialComplete = false, rangeReads = 0;
let peakRss = 0, peakHeap = 0, initialMs = 0;
const sample = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
class Peer extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  send(data: string | Buffer, cb?: (error?: Error) => void) {
    bytes += Buffer.byteLength(data); messages++;
    if (Buffer.isBuffer(data)) frames++;
    else {
      const m = JSON.parse(data);
      if (m.type === "rangeTrades") footprint ? fp.appendRange(m.reqId, m.trades) : agg.appendRangeChunk(m.reqId, m.trades);
      if (m.type === "rangeDone") {
        footprint ? fp.commitRange(m.reqId, m.footprint) : agg.commitRange(m.reqId);
        initialComplete = true;
      }
      if (m.type === "trades") footprint ? fp.appendLive(m.trades) : agg.appendLive(m.trades);
    }
    cb?.();
  }
  close() { this.readyState = 3; this.emit("close", 1000); }
  terminate() { this.close(); }
}
const source: Source = {
  savedRange: () => ({ fromSec: from, toSec: end }), status: () => ({ dummy: true }),
  read: async (a, b) => {
    rangeReads++;
    return { trades: rows.slice(0, 12000).filter(t => t.tsUs >= a * 1e6 && t.tsUs < b * 1e6),
      columns: Array.from({ length: Math.max(0, Math.min(b, end) - Math.max(a, from)) }, (_, i) => ({
        ...book, tsSec: Math.max(a, from) + i })) };
  },
  readTrades: async (a, b, visit) => {
    rangeReads++;
    for (const t of rows.slice(0, 12000)) if (t.tsUs >= a * 1e6 && t.tsUs < b * 1e6) visit(t);
    return { coverage: [[a, b]], gaps: [], noData: [], quality: "recorded_not_guaranteed" };
  },
};
global.gc?.();
const cpu = process.cpuUsage(), started = performance.now();
const hub = new HubClass(source, () => {}, clock), peer = new Peer();
try {
  if (!footprint) agg.beginRange(0, (end - 1800) * 1e6, end * 1e6);
  await hub.connect(peer, new URL(`http://dummy/api/ws${footprint ? "?view=footprint" : ""}`));
  if (footprint) {
    fp.beginRange(1, from, end);
    peer.emit("message", Buffer.from(JSON.stringify({ op: "range", reqId: 1, fromSec: from, toSec: end })), false);
    while (!initialComplete) await new Promise(resolve => setImmediate(resolve));
  }
  initialMs = performance.now() - started;
  const initialBytes = bytes; sample();
  const modelStarted = performance.now();
  for (let sec = 0; sec < 20; sec++) {
    for (const t of rows.slice(12000 + sec * 100, 12100 + sec * 100)) hub.trade(t);
    hub.book({ ...book, tsUs: (end + sec) * 1e6 });
    hub.column({ ...book, tsSec: end + sec });
    clock.advance(1000);
    if (footprint) fp.bars(from, end + sec + 1);
    else agg.cells(from * 1e6, (end + sec + 1) * 1e6);
    sample();
  }
  const aggregationMs = performance.now() - modelStarted;
  const cells = new Map<number, [number, number]>();
  if (footprint) for (const { group } of fp.bars(from, end + 20)) {
    const b = group.get("NQZ26"); if (!b) continue;
    b.prices.forEach((p, i) => { const c = cells.get(p) ?? [0, 0]; c[0] += b.buy[i]!; c[1] += b.sell[i]!; cells.set(p, c); });
  }
  else for (const c of agg.cells(from * 1e6, (end + 20) * 1e6)) {
    const v = cells.get(c.price) ?? [0, 0]; v[0] += c.buy; v[1] += c.sell; cells.set(c.price, v);
  }
  const usage = process.cpuUsage(cpu), cpuMs = (usage.user + usage.system) / 1000;
  console.info(JSON.stringify({ dummy: true, mode, timeframe: footprint ? tf : null, historyRows: 12000,
    liveRows: 2000, historySeconds: 120, updateSeconds: 20, depthLevels: 800,
    initialMs, wallMs: performance.now() - started, cpuMs, peakRss, peakHeap,
    initialBytes, steadyBytes: bytes - initialBytes, bytes, messages, frames, rangeReads, aggregationMs,
    count: footprint ? fp.tradeCount : agg.size, cells: [...cells].sort(([a], [b]) => a - b),
    quantitySha256: createHash("sha256").update(JSON.stringify([...cells].sort(([a], [b]) => a - b))).digest("hex") }));
} finally { peer.close(); hub.stop(); }
