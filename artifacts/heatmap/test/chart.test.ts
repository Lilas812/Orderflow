import assert from "node:assert/strict";
import test from "node:test";
import { viewportPositiveP99 } from "../src/chart/scale.ts";

test("ダミー: P99 excludes cells that only touch a viewport edge and columns before it", () => {
  const columns = [
    column(99, { bids: [[101, 4000]] }),
    column(100, { bids: [[100, 1000], [101, 1], [102, 2], [103, 2000]] }),
  ];
  assert.equal(viewportPositiveP99(columns, { startUs: 100_000_000, durationSec: 1, centerPriceTicks: 101.5, priceSpanTicks: 2 }), 2);
});
import { computePixelMax } from "../src/chart/aggregate.ts";
import { priceTicksToY, timeUsToX, xToTimeUs, yToPriceTicks } from "../src/chart/coordinates.ts";
import { resolveColumnForDrawing } from "../src/chart/gaps.ts";
import { heatColor, positiveNearestRank } from "../src/chart/scale.ts";
import { formatTimeUs, zoneFromSearch } from "../src/chart/timezone.ts";
import type { Viewport } from "../src/domain.ts";
import { column } from "./helpers.ts";

test("positive nearest-rank P99 excludes zeros and clamps the highest one percent", () => {
  const values = [0, 0, ...Array.from({ length: 99 }, (_value, index) => index + 1), 9_000];
  assert.equal(positiveNearestRank(values), 99);
  assert.equal(positiveNearestRank([0, 0]), 1);
  assert.deepEqual(heatColor(0, 10), [0, 0, 0]);
  assert.deepEqual(heatColor(100, 10), [255, 59, 48]);
});

test("physical pixel aggregation takes the maximum over both time and price axes", () => {
  const grid = computePixelMax([
    column(100, { bids: [[10, 5]], asks: [[11, 12]] }),
    column(101, { bids: [[10, 99]], asks: [[11, 14]] }),
  ], {
    startUs: 100_000_000,
    durationSec: 2,
    centerPriceTicks: 10,
    priceSpanTicks: 4,
  }, 1, 1);
  assert.equal(grid.width, 1);
  assert.equal(grid.height, 1);
  assert.equal(grid.values[0], 99);
});

test("only complete one- and two-second missing runs use the prior real column", () => {
  const oneGap = [column(10), column(12)];
  const twoGaps = [column(10), column(13)];
  const longGap = [column(10), column(14)];
  const mapOf = (items: ReturnType<typeof column>[]) => new Map(items.map((item) => [item.timeUs / 1_000_000, item]));
  assert.equal(resolveColumnForDrawing(11, mapOf(oneGap), [10, 12]), oneGap[0]);
  assert.equal(resolveColumnForDrawing(11, mapOf(twoGaps), [10, 13]), twoGaps[0]);
  assert.equal(resolveColumnForDrawing(12, mapOf(twoGaps), [10, 13]), twoGaps[0]);
  assert.equal(resolveColumnForDrawing(11, mapOf(longGap), [10, 14]), null);
  assert.equal(resolveColumnForDrawing(15, mapOf([column(14)]), [14]), null);
});

test("time and price transforms round-trip in integer-domain units", () => {
  const viewport: Viewport = {
    startUs: 1_793_000_000_000_000,
    durationSec: 427,
    centerPriceTicks: 71_234,
    priceSpanTicks: 160,
  };
  const time = viewport.startUs + 133.75 * 1_000_000;
  const x = timeUsToX(time, viewport, 1_230);
  assert.ok(Math.abs(xToTimeUs(x, viewport, 1_230) - time) < 1);
  const price = 71_207.25;
  const y = priceTicksToY(price, viewport, 570);
  assert.ok(Math.abs(yToPriceTicks(y, viewport, 570) - price) < 1e-9);
});

test("JST stays fixed and Chicago labels follow both daylight-saving transitions", () => {
  assert.equal(zoneFromSearch("?tz=ct"), "ct");
  assert.equal(zoneFromSearch("?tz=jst"), "jst");
  const springBefore = Date.parse("2026-03-08T07:59:59Z") * 1_000;
  const springAfter = Date.parse("2026-03-08T08:00:00Z") * 1_000;
  assert.equal(formatTimeUs(springBefore, "ct"), "01:59:59");
  assert.equal(formatTimeUs(springAfter, "ct"), "03:00:00");
  const fallBefore = Date.parse("2026-11-01T06:59:59Z") * 1_000;
  const fallAfter = Date.parse("2026-11-01T07:00:00Z") * 1_000;
  assert.equal(formatTimeUs(fallBefore, "ct"), "01:59:59");
  assert.equal(formatTimeUs(fallAfter, "ct"), "01:00:00");
  assert.equal(formatTimeUs(springAfter, "jst"), "17:00:00");
});
