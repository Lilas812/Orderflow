import { test } from "node:test";
import assert from "node:assert/strict";
import { Receiver } from "../src/ingest/receiver.ts";

const book = (extra: Record<string, unknown> = {}) => ({
  type: "book", symbol: "NQ", ts: 1_793_010_051,
  bids: [[100, 3], [99.75, 4]], asks: [[100.25, 5], [100.5, 6]],
  ...extra,
});
const tick = (extra: Record<string, unknown> = {}) => ({
  type: "tick", symbol: "NQ", ts: 1_793_010_051,
  price: 100.25, size: 2, side: "sell", ...extra,
});
const send = (receiver: Receiver, value: unknown) =>
  receiver.receive(JSON.stringify(value), 1_793_010_051_999_000, () => {});

test("ダミー：約定は秒→整数µs、価格→整数tick、sideを保持。同内容も消さない", () => {
  const r = new Receiver(() => {});
  send(r, tick());
  send(r, tick());
  assert.deepEqual(r.trades.latest(), [
    { tsUs: 1_793_010_051_000_000, recvUs: 1_793_010_051_999_000,
      seq: 1, price: 401, size: 2, side: "sell" },
    { tsUs: 1_793_010_051_000_000, recvUs: 1_793_010_051_999_000,
      seq: 2, price: 401, size: 2, side: "sell" },
  ]);
  send(r, tick({ side: "buy" }));
  assert.equal(r.trades.latest().at(-1)?.side, "buy");
  assert.equal(r.metrics.byType.tick, 3);
});

test("ダミー：板のサイズ0以下を段単位で除外、imbalanceは使わない", () => {
  const r = new Receiver(() => {});
  send(r, book({ bids: [[100, 0], [99.75, -1], [99.5, 7]], imbalance: 999 }));
  assert.deepEqual(r.book.latest?.bids, [{ price: 398, size: 7 }]);
  assert.equal(r.metrics.counts.nonPositiveBookLevels, 2);
  assert.equal(r.metrics.counts.acceptedBook, 1);
  assert.equal("imbalance" in r.book.latest!, false);
});

test("ダミー：交差、並び順違反、価格重複、ティック外は板全体を棄却・件数加算", () => {
  for (const [change, counter] of [
    [{ bids: [[100.25, 1]] }, "crossedBook"],
    [{ bids: [[99.75, 1], [100, 1]] }, "bookOrder"],
    [{ asks: [[100.5, 1], [100.25, 1]] }, "bookOrder"],
    [{ bids: [[100, 1], [100, 2]] }, "duplicatePrice"],
    [{ asks: [[100.25, 1], [100.25, 2]] }, "duplicatePrice"],
    [{ asks: [[100.26, 1]] }, "offTick"],
    [{ bids: [[100.01, 0]] }, "offTick"],
  ] as [Record<string, unknown>, string][]) {
    const r = new Receiver(() => {});
    send(r, book());
    const previous = r.book.latest;
    send(r, book(change));
    assert.equal(r.book.latest, previous);
    assert.ok(r.metrics.counts[counter] > 0, counter);
    assert.equal(r.metrics.counts.rejectedBook, 1);
  }
});

test("ダミー：正常な板で全量置換し、古い段を残さない", () => {
  const r = new Receiver(() => {});
  send(r, book());
  send(r, book({ bids: [[99, 1]], asks: [[101, 2]], ts: 1_793_010_052 }));
  assert.deepEqual(r.book.latest?.bids, [{ price: 396, size: 1 }]);
  assert.deepEqual(r.book.latest?.asks, [{ price: 404, size: 2 }]);
  assert.deepEqual(r.book.summary(), {
    tsUs: 1_793_010_052_000_000, recvUs: 1_793_010_051_999_000, source: "live",
    bestBid: { price: 396, size: 1 }, bestAsk: { price: 404, size: 2 },
    bidDepth: 1, askDepth: 1,
  });
});

test("ダミー：時刻巻き戻りは棄却、板と約定は別基準・同秒は許可", () => {
  const r = new Receiver(() => {});
  send(r, book({ ts: 100 }));
  const previous = r.book.latest;
  send(r, book({ ts: 99 }));
  send(r, tick({ ts: 50 }));
  send(r, tick({ ts: 49 }));
  send(r, tick({ ts: 50 }));
  assert.equal(r.book.latest, previous);
  assert.equal(r.trades.size, 2);
  assert.equal(r.metrics.counts.timestampRollback, 2);
});

test("ダミー：壊れた形式・不正約定は採用せず、時刻の単位も推測しない", () => {
  const r = new Receiver(() => {});
  r.receive("not-json", 1, () => {});
  send(r, []);
  send(r, { type: "mystery" });
  send(r, tick({ price: 100.1 }));
  send(r, tick({ size: 0 }));
  send(r, tick({ ts: 1_793_010_051_000_000 }));
  send(r, tick({ symbol: "ES" }));
  send(r, book({ bids: "invalid" }));
  send(r, book({ asks: [[100.25, "bad"]] }));
  assert.equal(r.trades.size, 0);
  assert.equal(r.book.latest, null);
  assert.equal(r.metrics.counts.invalidJson, 1);
  assert.equal(r.metrics.counts.unknownType, 1);
  assert.equal(r.metrics.counts.rejectedTrade, 4);
  assert.equal(r.metrics.counts.rejectedBook, 2);
});

test("ダミー：1,000件だけ受信順保持、棄却実例は種類ごとに5件まで", () => {
  const r = new Receiver(() => {});
  for (let i = 0; i < 1007; i++) send(r, tick());
  assert.equal(r.trades.size, 1000);
  assert.deepEqual(r.trades.latest(1000).map((t) => t.seq),
    Array.from({ length: 1000 }, (_, i) => i + 8));
  for (let i = 0; i < 10; i++) send(r, book({ bids: [[100, 0]] }));
  assert.equal(r.metrics.examples.nonPositiveBookLevels.length, 5);
  assert.equal(r.metrics.counts.nonPositiveBookLevels, 10);
});

test("ダミー：warning/feed/errorを件数とログに残し、欠落区間を捏造しない", () => {
  const events: { event: string; details: unknown }[] = [];
  const r = new Receiver((event, details) => events.push({ event, details }));
  send(r, tick());
  send(r, { type: "warning", code: "ticks_lagged", start: 50, end: 60 });
  send(r, { type: "feed", status: "recovering" });
  send(r, { type: "error", code: "upstream_error" });
  assert.equal(r.metrics.counts.warning, 1);
  assert.equal(r.metrics.counts.feed, 1);
  assert.equal(r.metrics.counts.error, 1);
  assert.equal(r.metrics.counts.ticksLagged, 1);
  assert.equal(r.trades.size, 1);
  assert.ok(events.some((e) => e.event === "ticks_lagged_interval"));
  assert.deepEqual(r.metrics.lagIntervals[0], {
    observedAtUs: 1_793_010_051_999_000, previousTradeUs: 1_793_010_051_000_000,
    sourceBounds: { start: 50, end: 60, from: null, to: null },
    sourceBoundsUnit: "unknown",
  });
});
