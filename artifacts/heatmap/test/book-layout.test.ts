import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { followStartUs, timeUsToX, zoomTimeAt } from "../src/chart/coordinates.ts";

test("confirmed latest column remains at 80% across zoom, reset scale, DPR and resize", () => {
  const latest = 1_793_022_000_000_000;
  for (const width of [1, 667, 803, 1606]) for (const durationSec of [10, 600, 3600, 7200]) {
    const view = { startUs: followStartUs(latest, durationSec, width), durationSec,
      centerPriceTicks: 117244.5, priceSpanTicks: 160 };
    const endX = timeUsToX(latest + 1_000_000, view, width);
    assert.ok(Math.abs(endX - width * 0.8) <= 1.501);
    const zoom = zoomTimeAt(view, latest, 0.5);
    zoom.startUs = followStartUs(latest, zoom.durationSec, width);
    assert.ok(Math.abs(timeUsToX(latest + 1_000_000, zoom, width) - width * 0.8) <= 1.501);
  }
});

test("shared 66% grid removes book frame, keeps right columns and overlay input transparent", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.match(css, /grid-template-columns:\s*66fr 5fr 10fr 19fr/);
  assert.doesNotMatch(main, /book-region|book-lower-region|current-book-line/);
  assert.ok(main.indexOf('id="heatmap"') < main.indexOf('id="current-book"'));
  assert.ok(main.indexOf('id="current-book"') < main.indexOf('id="trade-overlay"'));
  assert.match(css, /\.book-canvas\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.current-book-overlay\s*\{[^}]*z-index:\s*1/);
  assert.match(css, /\.trade-overlay\s*\{[^}]*z-index:\s*2/);
  assert.match(main, /canvas\.addEventListener\("dblclick", resetView\)/);
  assert.match(main, /if \(follow\) alignFollowToPhysicalPixel\(\)/);
});
