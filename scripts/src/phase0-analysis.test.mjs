import test from "node:test";
import assert from "node:assert/strict";
import { distribution, perSecondStats, timestampCandidates, inspectBook,
  halfOpen, splitWindow, compareOccurrences, analyzeHistory } from "./phase0-analysis.mjs";

test("ダミー: nearest-rank quantiles and zero-filled seconds", () => {
  assert.deepEqual(distribution([]), { count: 0 });
  assert.equal(distribution([3, 1, 2]).p99, 3);
  const result = perSecondStats(new Map([[0, 2], [2, 1]]), 3, 3_000_000);
  assert.equal(result.mean, 1);
  assert.deepEqual(result.histogram, { 0: 1, 1: 1, 2: 1 });
  assert.equal(result.averagePerActualSecond, 1);
});

test("ダミー: compare all time units without selecting or mutating ts", () => {
  const result = timestampCandidates(1_790_000_000, 1_790_000_000_123_000);
  assert.equal(result.digits, 10);
  assert.equal(result.seconds, 123_000);
  assert.equal(result.microseconds, 1_789_998_210_123_000);
});

test("ダミー: valid book, ratio, and multiple anomalies", () => {
  const valid = inspectBook({ bids: [[100, 3], [99.75, 1]], asks: [[100.25, 4]], imbalance: 0 });
  assert.deepEqual(valid.counts, {});
  assert.equal(valid.candidates.signedRatio, 0);
  assert.equal(valid.candidates.bestSignedRatio, -1 / 7);
  const bad = inspectBook({ bids: [[100, 0], [100, 2], [101, 1]],
    asks: [[100, 1], [99.9, -1]] });
  for (const kind of ["zeroSize", "duplicatePrice", "wrongOrder", "offTick",
    "negativeSize", "lockedOrCrossed", "priceGap"]) assert.ok(bad.counts[kind]);
  assert.equal(inspectBook({ bids: [], asks: null }).counts.missingSide, 1);
});

test("ダミー: half-open boundaries and safe subdivision", () => {
  const rows = [999999, 1000000, 1999999, 2000000].map((ts) => ({ ts }));
  assert.deepEqual(halfOpen(rows, 1, 2).map((r) => r.ts), [1000000, 1999999]);
  assert.deepEqual(splitWindow(0, 3), [[0, 1], [1, 3]]);
  assert.throws(() => splitWindow(0, 1), /cannot be subdivided/);
});

test("ダミー: occurrence comparison preserves legitimate duplicate rows", () => {
  const row = { ts: 1, side: "bid", level: 1, price: 100, size: 1, flag: 0 };
  assert.equal(compareOccurrences([row, row], [row]).leftOnly, 1);
  assert.equal(compareOccurrences([row, row], [row, row]).equalWithMultiplicity, true);
});

test("ダミー: 1600 rows detect identical and differing complete snapshots", () => {
  const snapshot = ["bid", "ask"].flatMap((side) =>
    Array.from({ length: 400 }, (_, i) => ({ ts: 123, side, level: i + 1,
      price: 100 + i * 0.25, size: 1, flag: 0 })));
  const same = analyzeHistory([...snapshot, ...snapshot]);
  assert.deepEqual(same.rowsPerTimestamp, { 1600: 1 });
  assert.equal(same.doubles[0].firstComplete800, true);
  assert.equal(same.doubles[0].secondComplete800, true);
  assert.equal(same.doubles[0].sameOrderedRows, true);
  const changed = snapshot.map((r) => ({ ...r, size: 2 }));
  const different = analyzeHistory([...snapshot, ...changed]);
  assert.equal(different.doubles[0].equalWithMultiplicity, false);
  assert.equal(different.doubles[0].leftOnly, 800);
});
