import assert from "node:assert/strict";
import test from "node:test";
import { TradeAggregator } from "../src/data/trade-aggregate.ts";
import { tradeGeometry, parseBubbleMin, bubbleRadius, BUBBLE_COLORS } from "../src/chart/trade-geometry.ts";
import type { Trade, Viewport } from "../src/domain.ts";
const U = 1_000_000;

test("known last price extends only to the data head, never through the future book margin", () => {
  const a = new TradeAggregator();
  a.appendLive([{ tsUs: 2 * U, recvUs: 3 * U, seq: 1, price: 100, size: 10, side: "buy" }]);
  const v = { startUs: 0, durationSec: 10, centerPriceTicks: 100, priceSpanTicks: 20 };
  const g = tradeGeometry(a, v, 100, 200, 1, 10, 8 * U);
  assert.equal(g.priceBins.at(-1)!.x, 80);
  assert.equal(g.priceBins.at(-1)!.last, 100);
  assert.ok(g.priceBins.every(p => p.x <= 80));
  assert.ok(g.bubbles.every(b => b.x < 80));
  assert.ok(g.priceBins[0]!.x > 0, "no line before first known price");
});
let seq = 10_000;
const row = (seconds: number, price: number, size: number, side: "buy" | "sell" = "buy"): Trade =>
  ({ tsUs: Math.round(seconds * U), recvUs: 1_000_000_000 + seq, seq: seq++, price, size, side });
const view: Viewport = { startUs: 10 * U, durationSec: 10, centerPriceTicks: 100, priceSpanTicks: 20 };

test("ダミー：閾値9は出さず10は半径3CSSpx、3色と濃い縁", () => {
  const a = new TradeAggregator();
  a.appendLive([row(10, 100, 9), row(11, 100, 10), row(12, 100, 10, "sell"), row(13, 100, 5), row(13, 100, 5, "sell")]);
  const { bubbles } = tradeGeometry(a, view, 100, 200, 2, 10);
  assert.deepEqual(bubbles.map(b => b.side), ["buy", "sell", "tie"]);
  assert.deepEqual(bubbles.map(b => b.radius), [3, 3, 3]);
  assert.deepEqual(bubbles.map(b => b.y), [100, 100, 100]);
  assert.equal(bubbles[0]!.x, 15, "center of second 11 in CSS pixels, independent of DPR");
  assert.deepEqual(BUBBLE_COLORS, {
    buy: { fill: "#3ddc84", edge: "#2a9a5c" }, sell: { fill: "#a64dff", edge: "#7436b3" },
    tie: { fill: "#d9d9d9", edge: "#989898" },
  });
});
test("ダミー：半径は平方根比例、上限14、DPR非依存", () => {
  assert.equal(bubbleRadius(10, 10), 3); assert.equal(bubbleRadius(40, 10), 6);
  assert.equal(bubbleRadius(100_000, 10), 14);
});
test("ダミー：物理1pxで秒を結合、秒ごとに閾値を適用後にsideと半径を再計算", () => {
  const a = new TradeAggregator();
  a.appendLive([row(10, 100, 6), row(11, 100, 6), row(12, 101, 10), row(13, 101, 30, "sell"), row(14, 102, 20)]);
  const result = tradeGeometry(a, view, 1, 200, 1, 10);
  assert.equal(result.bubbles.length, 2);
  assert.equal(result.bubbles[0]!.buy, 10); assert.equal(result.bubbles[0]!.sell, 30);
  assert.equal(result.bubbles[0]!.side, "sell"); assert.equal(result.bubbles[0]!.radius, 6);
  assert.equal(result.bubbles[0]!.x, 0.5);
  const highDpr = tradeGeometry(a, view, 5, 200, 2, 10);
  assert.equal(highDpr.downsampled, false); assert.equal(highDpr.bubbles.length, 3);
});
test("ダミー：縮小価格ラインはmin/maxとlast、既知価格前は描かない", () => {
  const a = new TradeAggregator();
  a.appendLive([row(12, 105, 10), row(13, 95, 10), row(14, 101, 10)]);
  const normal = tradeGeometry(a, view, 100, 200, 1, 10);
  assert.equal(normal.priceBins[0]!.x, 25); assert.equal(normal.priceBins[1]!.last, 95);
  const reduced = tradeGeometry(a, view, 1, 200, 1, 10);
  assert.equal(reduced.priceBins[0]!.min, 95); assert.equal(reduced.priceBins[0]!.max, 105);
  assert.equal(reduced.priceBins[0]!.last, 101);
});
test("ダミー：bubbleMin有効/無効、数値の上限なし", () => {
  assert.deepEqual(parseBubbleMin(""), { value: 10, invalid: false });
  for (const raw of ["abc", "", "0", "-1", "1.2", "NaN", "Infinity"]) {
    assert.deepEqual(parseBubbleMin(`?bubbleMin=${raw}`), { value: 10, invalid: true });
  }
  for (const value of [1, 5, 20, 1e100]) assert.deepEqual(parseBubbleMin(`?bubbleMin=${encodeURIComponent(value)}`), { value, invalid: false });
});
