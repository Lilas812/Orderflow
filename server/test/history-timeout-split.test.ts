import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HistoryClient, WindowSplitRequired, WindowUnavailableError, timeoutSplit } from "../src/history/client.ts";
import { readTradeRange, readRecordedTradeRange } from "../src/vp/trade-history.ts";
import { LocalStore } from "../src/store/local.ts";
import { Metrics } from "../src/ingest/metrics.ts";

test("timeout分割は1分以上の子だけを作り、元から短い不足区間を拡張しない", () => {
  assert.equal(timeoutSplit(0, 900), 420);
  assert.equal(timeoutSplit(0, 120), 60);
  assert.equal(timeoutSplit(0, 119), null);
  assert.equal(timeoutSplit(0, 1), null);
});
test("15分のnetwork_or_timeoutは同窓再試行なしで分割、1分の3回失敗だけgapにして次へ", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-split-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const start = 1793100000, end = start + 900, store = new LocalStore(root);
  await store.initialize();
  const requests: [number, number][] = [], logs: any[] = [], waits: number[] = [];
  const client = new HistoryClient("DUMMY-key", (event, details) => logs.push({ event, details }),
    async input => {
      const url = new URL(String(input)), a = Number(url.searchParams.get("start")), b = Number(url.searchParams.get("end"));
      requests.push([a, b]);
      if (b - a > 60 || a === start + 120) throw Error("DUMMY-timeout");
      return Response.json({ ticks: [{ ts: a * 1e6 + 1, price: 4000.1, size: 2, side: "buy" }], truncated: false });
    }, async ms => { waits.push(ms); }, "GC");
  let seq = 0, prints = 0;
  const result = await readTradeRange({ store, source: client, metrics: new Metrics(() => {}),
    nextSeq: () => ++seq, signal: new AbortController().signal, start, end, visit: () => { prints++; },
    schedule: { now: () => (end + 3600) * 1000, wait: async () => {} } });
  assert.deepEqual(requests[0], [start, end]);
  assert.equal(requests.filter(([a, b]) => a === start && b === end).length, 1);
  assert.equal(requests.filter(([a, b]) => a === start + 120 && b === start + 180).length, 3);
  assert.ok(requests.every(([a, b]) => b - a >= 60));
  assert.deepEqual(waits, [60000, 60000]);
  assert.deepEqual(result.gaps, [{ startSec: start + 120, endSec: start + 180, reason: "network_or_timeout" }]);
  assert.equal(prints, 14);
  assert.ok(!store.covered("tick", start + 120));
  assert.ok(store.covered("tick", start + 180));
  assert.ok(logs.filter(r => r.event === "history_request_failed").every(r =>
    r.details.symbol === "GC" && Number.isFinite(r.details.elapsedMs) && r.details.start < r.details.end));
  await store.flush();
});
test("response bodyの通信失敗も分割、abortは分割・再試行せず伝播", async () => {
  const client = new HistoryClient("DUMMY", () => {}, async () =>
    new Response(new ReadableStream({ start(c) { c.error(Error("DUMMY-body-timeout")); } })), async () => {});
  await assert.rejects(client.get("tick", 0, 900, new AbortController().signal), WindowSplitRequired);
  const abort = new AbortController();
  const aborted = new HistoryClient("DUMMY", () => {}, async () => {
    abort.abort(); throw Error("DUMMY-request-aborted");
  }, async () => { throw Error("must not retry"); });
  await assert.rejects(aborted.get("book", 0, 60, abort.signal),
    e => !(e instanceof WindowUnavailableError));
});
test("記録済み日次はcoverageのない区間の既存約定も数え、gapを消さず900秒以下で読む", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recorded-range-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root), start = 1793100000;
  await store.initialize();
  await store.addTrades([{ tsUs: (start + 30) * 1e6, recvUs: (start + 30) * 1e6,
    seq: 1, size: 3, side: "buy", price: 400 }]);
  await store.flush();
  // Simulate absent coverage alongside a persisted raw file.
  store.recordedTickCoverage = async () => [];
  const original = store.tradeReadSession.bind(store);
  const spans: number[] = [];
  store.tradeReadSession = signal => {
    const reader = original(signal);
    return { visit: async (a, b, visit) => { spans.push(b - a); await reader.visit(a, b, visit); },
      close: () => reader.close() };
  };
  let size = 0;
  const result = await readRecordedTradeRange({ store, start, end: start + 1800,
    signal: new AbortController().signal, visit: t => { size += t.size; } });
  assert.equal(size, 3);
  assert.equal(result.apiWindows, 0);
  assert.ok(result.gaps.length > 0);
  assert.ok(spans.every(n => n <= 900));
  assert.deepEqual(await store.recordedTickCoverage(), []);
});
