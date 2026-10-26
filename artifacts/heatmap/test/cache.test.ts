import assert from "node:assert/strict";
import test from "node:test";
test("ダミー: large trade batches avoid argument limits and only deduplicate transport IDs", () => {
  const cache = new ColumnCache();
  cache.addColumn(column(4_500));
  const trades = Array.from({ length: 150_000 }, (_, seq) => ({
    tsUs: 4_500_000_000, recvUs: 4_500_010_000, seq, price: 100, size: 1, side: "buy" as const,
  }));
  cache.addTrades(trades);
  cache.addTrades(trades.slice(0, 10));
  assert.equal(cache.trades.length, 150_000);
  cache.setRetentionAnchor(10_000_000_000, 11_000_000_000, true, 11_000_000_000);
  assert.equal(cache.trades.length, 150_000);
  cache.setRetentionAnchor(20_000_000_000, 21_000_000_000, true, 21_000_000_000);
  assert.equal(cache.trades.length, 0);
});
import { ColumnCache } from "../src/data/cache.ts";
import { US_PER_SECOND } from "../src/domain.ts";
import { column } from "./helpers.ts";

test("cache remains bounded to two hours and follows latest only when follow is active", () => {
  const cache = new ColumnCache();
  for (let batch = 0; batch < 75; batch += 1) {
    const start = 100_000 + batch * 100;
    for (let offset = 0; offset < 100; offset += 1) cache.addColumn(column(start + offset));
    const latest = (start + 99) * US_PER_SECOND;
    cache.setRetentionAnchor(latest - 7_200 * US_PER_SECOND, latest, true, latest);
  }
  assert.ok(cache.size <= 7_200);
  assert.equal(cache.latestTimeUs, 107_499 * US_PER_SECOND);
  assert.ok(cache.orderedSeconds[0]! >= 100_300);

  const oldFrom = 101_000 * US_PER_SECOND;
  cache.setRetentionAnchor(oldFrom, oldFrom + 600 * US_PER_SECOND, false, cache.latestTimeUs);
  cache.addColumn(column(108_000));
  assert.ok(cache.columns.some((item) => item.timeUs === 101_000 * US_PER_SECOND));
  assert.equal(cache.latestTimeUs, 108_000 * US_PER_SECOND);
  assert.ok(cache.columns.every((item) => item.timeUs < 104_900 * US_PER_SECOND));
});

test("coverage includes known empty ranges, chunks requests at one hour, and does not loop on holes", () => {
  const cache = new ColumnCache();
  cache.setRetentionAnchor(1_000 * US_PER_SECOND, 2_000 * US_PER_SECOND, false, null);
  cache.markCovered(1_100, 1_300);
  const missing = cache.planMissingRanges(1_000, 2_000, 3_600);
  assert.deepEqual(missing, [
    { fromSec: 1_000, toSec: 1_100 },
    { fromSec: 1_300, toSec: 2_000 },
  ]);
  cache.markCovered(1_000, 1_100);
  assert.deepEqual(cache.planMissingRanges(1_000, 2_000), [
    { fromSec: 1_300, toSec: 2_000 },
  ]);
  cache.markCovered(1_300, 2_000);
  assert.deepEqual(cache.planMissingRanges(1_000, 2_000), []);
  cache.removeCoverage(1_300, 2_000);
  assert.deepEqual(cache.planMissingRanges(1_000, 5_000, 3_600), [
    { fromSec: 1_300, toSec: 4_900 },
    { fromSec: 4_900, toSec: 5_000 },
  ]);
});

test("browsing an old interval is retained when live columns arrive", () => {
  const cache = new ColumnCache();
  cache.addColumn(column(50_000));
  cache.setRetentionAnchor(50_000 * US_PER_SECOND, 50_600 * US_PER_SECOND, false, 50_000 * US_PER_SECOND);
  cache.addColumn(column(60_000));
  assert.equal(cache.columns.length, 1);
  assert.equal(cache.columns[0]?.timeUs, 50_000 * US_PER_SECOND);
  assert.equal(cache.latestTimeUs, 60_000 * US_PER_SECOND);
});
