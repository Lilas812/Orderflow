import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hub, type Source, type Socket } from "../src/hub/hub.ts";
import { LocalStore } from "../src/store/local.ts";
import { Pipeline } from "../src/pipeline.ts";
import type { Trade } from "../src/types.ts";

class Peer extends EventEmitter implements Socket {
  readyState = 1; bufferedAmount = 0; output: (string | Buffer)[] = [];
  send(data: string | Buffer, cb?: (error?: Error) => void) { this.output.push(data); cb?.(); }
  close() { this.readyState = 3; this.emit("close", 1000); }
  terminate() { this.close(); }
  messages() { return this.output.filter(x => typeof x === "string").map(x => JSON.parse(x as string)); }
}
const now = 20_000;
const clock = { now: () => now * 1000, later: () => 0, cancel: () => {} };
const t = (seq: number): Trade => ({ tsUs: (now - 15) * 1e6, recvUs: now * 1e6 + seq,
  seq, price: 27000, size: 2, side: "buy", contract: "GCZ26" });
async function request(peer: Peer, fromSec = now - 30, toSec = now) {
  peer.emit("message", Buffer.from(JSON.stringify({ op: "range", reqId: 1, fromSec, toSec })), false);
  for (let i = 0; i < 50 && !peer.messages().some(m => m.type === "rangeDone" || m.type === "error"); i++)
    await new Promise(resolve => setTimeout(resolve, 1));
}
test("ダミー：FOOTPRINTは可視要求まで読まず板/VPなし、全約定・限月・世代を送る", async () => {
  let reads = 0, tradeReads = 0;
  const source: Source = {
    savedRange: () => null, status: () => ({ dummy: true }),
    read: async () => { reads++; return { columns: [], trades: [] }; },
    readTrades: async (_a, _b, visit) => {
      tradeReads++; visit(t(1)); visit(t(2));
      return { coverage: [[now - 30, now]], gaps: [], noData: [], quality: "recorded_not_guaranteed" };
    },
  };
  const hub = new Hub(source, () => {}, clock, "GC"), peer = new Peer();
  try {
    await hub.connect(peer, new URL("http://dummy/api/ws?view=footprint&symbol=GC"));
    assert.equal(reads, 0); assert.equal(tradeReads, 0);
    const hello = peer.messages()[0]; assert.equal(hello.symbol, "GC"); assert.equal(hello.tickSize, .1);
    assert.match(hello.generation, /^[a-f0-9-]{36}$/);
    hub.column({ tsSec: now, source: "live", bids: [], asks: [] });
    assert.equal(peer.output.filter(Buffer.isBuffer).length, 0);
    await request(peer);
    assert.equal(tradeReads, 1); assert.equal(reads, 0);
    const chunk = peer.messages().find(m => m.type === "rangeTrades");
    assert.deepEqual(chunk.trades, [t(1), t(2)]);
    assert.equal(peer.messages().find(m => m.type === "rangeDone").footprint.quality, "recorded_not_guaranteed");
    assert.equal(peer.output.filter(Buffer.isBuffer).length, 0);
  } finally { peer.close(); hub.stop(); }
});
test("ダミー：2時間外のFOOTPRINT要求を読まず拒否し、切断signalを解放", async () => {
  let signal: AbortSignal | undefined;
  const hub = new Hub({ savedRange: () => null, status: () => ({}), read: async () => ({ columns: [], trades: [] }),
    readTrades: async (_a, _b, _v, s) => { signal = s; return { coverage: [], gaps: [], noData: [], quality: "recorded_not_guaranteed" }; },
  }, () => {}, clock);
  const peer = new Peer();
  try {
    await hub.connect(peer, new URL("http://dummy/api/ws?view=footprint"));
    await request(peer, now - 7201, now - 7200);
    assert.equal(peer.messages().at(-1).code, "invalid_range"); assert.equal(signal, undefined);
    peer.output = []; await request(peer);
    assert.equal(signal!.aborted, false);
    peer.close(); assert.equal(signal!.aborted, true); assert.equal(hub.snapshot().connected, 0);
  } finally { peer.close(); hub.stop(); }
});
test("ダミー：Pipelineの約定専用読取はtail/store重複を除き、欠けと無約定を分離、板を読まない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "footprint-pipeline-"));
  const store = new LocalStore(root, () => now * 1000, undefined, "GC");
  const pipeline = new Pipeline("dummy", () => 10, () => {}, () => {}, store, "GC",
    async () => { throw Error("unexpected REST"); });
  try {
    await store.initialize();
    assert.equal(pipeline.ownsFootprintLive(t(1)), false);
    Object.assign(pipeline, { seam: now - 30 }); // dummy seam: do not start REST/backfill
    assert.equal(pipeline.ownsFootprintLive(t(1)), true);
    assert.equal(pipeline.ownsFootprintLive({ ...t(1), tsUs: (now - 31) * 1e6 }), false);
    await store.addTrades([t(1), t(2)]);
    pipeline.trade(t(1)); pipeline.trade(t(3));
    store.markCovered("tick", now - 30, now - 10);
    await store.flush();
    pipeline.backfill.status.noData.push({ kind: "tick", startSec: now - 30, endSec: now - 20, reason: "empty", attempts: 3 });
    const rows: Trade[] = [];
    const state = await pipeline.readFootprintRange(now - 30, now, row => rows.push(row), new AbortController().signal);
    assert.deepEqual(rows, [t(1), t(2), t(3)]);
    assert.deepEqual(state.coverage, [[now - 30, now - 10]]);
    assert.deepEqual(state.gaps, [{ startSec: now - 10, endSec: now, reason: "not_recorded" }]);
    assert.deepEqual(state.noData, [{ startSec: now - 30, endSec: now - 20 }]);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(pipeline.readFootprintRange(now - 30, now, () => {}, aborted.signal));
    const duringRead = new AbortController();
    await assert.rejects(pipeline.readFootprintRange(now - 30, now, () => duringRead.abort(), duringRead.signal));
    await store.addTrades([t(4)]); // read cancellation must not poison the live writer queue
    const again: Trade[] = [];
    await pipeline.readFootprintRange(now - 30, now, row => again.push(row), new AbortController().signal);
    assert.ok(again.some(row => row.seq === 4));
  } finally { await rm(root, { recursive: true, force: true }); }
});
