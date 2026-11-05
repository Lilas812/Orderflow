import test from "node:test";
import assert from "node:assert/strict";
import { Distribution, packed, overlap, bbo, counter, count, rates } from "./gc_board_metrics.mjs";
import { ColumnAggregator } from "../server/src/aggregate/columns.ts";
test("weighted nearest-rank percentiles and empty inputs", () => {
  const d = new Distribution(); assert.equal(d.result().quantiles, null);
  [0, 1, 1, 10].forEach(x => d.add(x));
  assert.equal(d.result().quantiles[.5], 1); assert.equal(d.result().quantiles[.95], 10);
  assert.throws(() => d.add(NaN));
});
test("top N intersection differs from quantity at same price and absent quantity is zero", () => {
  const a = [100, 2, 99, 4], b = [101, 8, 100, 6, 99, 2];
  assert.deepEqual(overlap(a, b, 2), { a: 2, b: 2, shared: 1, union: 3,
    ratios: [{ value: 3, sharedPrice: true }, { value: .5, sharedPrice: true }] });
  assert.deepEqual(overlap([98, 3], b, 1).ratios, [{ value: 0, sharedPrice: false }]);
});
test("empty BBO is excluded, not silently counted as a match", () => {
  const c = packed({ tsSec: 1, bids: [{price: 100, size: 2}], asks: [{price: 101, size: 3}] });
  const row = counter(); count(row, bbo(c, c)); count(row, bbo(c, {bids: [], asks: []}));
  assert.equal(row.seconds, 1); assert.equal(rates(row).bothRate, 1);
});
test("positive app timestamp shift means comparing app(t) with MBO(t+delta)", () => {
  const a = { bids: [100, 2], asks: [101, 2] };
  const map = new Map([[101, a], [99, { bids: [98, 2], asks: [99, 2] }]]);
  assert.equal(bbo(a, map.get(100 + 1)).both, true);
  assert.equal(bbo(a, map.get(100 - 1)).both, false);
});
test("actual ColumnAggregator keeps max timestamp, tie is last arrival, no empty-second filling", () => {
  const out = [], agg = new ColumnAggregator(c => out.push(c));
  const snap = (tsUs, price) => ({ tsUs, recvUs: tsUs, source: "history",
    bids: [{ price, size: 1 }], asks: [{ price: price + 1, size: 1 }] });
  agg.accept(snap(1100000, 10)); agg.accept(snap(1900000, 11));
  agg.accept(snap(1700000, 999)); agg.accept(snap(1900000, 12));
  agg.accept(snap(5200000, 15)); agg.finish();
  assert.deepEqual(out.map(c => [c.tsSec, c.bids[0].price]), [[1,12], [5,15]]);
  assert.equal(agg.accept(snap(1900000, 10)), false);
});
