import test from "node:test";
import assert from "node:assert/strict";
import { cvdScale, cvdY, longVpCursor, type CursorScene } from "../src/long-vp/crosshair.ts";

const scene: CursorScene = { width: 1000, height: 800, plotW: 930, priceH: 600, cvdTop: 600, cvdH: 160,
  timeTop: 760, view: { startSec: Date.UTC(2026, 9, 29, 16) / 1e3, endSec: Date.UTC(2026, 9, 29, 17) / 1e3,
    priceHigh: 117400, priceLow: 117200 }, cvd: cvdScale([{ v: -200 }, { v: 800 }], 600, 160), timeZone: "Asia/Tokyo" };
test("Long VP cursor: adjusted tick axis, seconds, containing second, no heatmap viewport", () => {
  const c = longVpCursor({ x: 465, y: 300 }, scene)!;
  assert.equal(c.label, "29325.00"); assert.equal(c.time, "10/30 01:30:00"); assert.equal(c.band, "price");
  const moved = { ...scene, view: { ...scene.view, priceHigh: 117440, priceLow: 117240 } };
  assert.equal(longVpCursor({ x: 465, y: 300 }, moved)!.label, "29335.00");
});
test("Long VP cursor: CVD shares exact forward/inverse range, padded endpoints and negatives", () => {
  for (const value of [-200, 0, 421, 800]) {
    const c = longVpCursor({ x: 100, y: cvdY(value, scene.cvd) }, scene)!;
    assert.equal(c.label, String(value)); assert.equal(c.band, "cvd");
  }
  assert.deepEqual(cvdScale([], 0, 100), { low: -.08, high: 1.08, top: 4, height: 92 });
});
test("Long VP cursor: axes/divider excluded, CVD off expands price, blanks still mapped", () => {
  for (const point of [{ x: 930, y: 100 }, { x: 100, y: 760 }, { x: 100, y: 600 }, { x: -1, y: 50 }])
    assert.equal(longVpCursor(point, scene), null);
  assert.equal(longVpCursor({ x: 900, y: 700 }, scene)!.band, "cvd");
  const full = { ...scene, cvdH: 0, cvdTop: 760, priceH: 760 };
  assert.equal(longVpCursor({ x: 900, y: 700 }, full)!.band, "price");
});
