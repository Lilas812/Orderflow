import assert from "node:assert/strict";
import test from "node:test";
import type { HeatColumn, Viewport } from "../src/domain.ts";
import { APPEAR_COLUMNS, GlowRaster, NOT_PAINTED, PAINTED, UNKNOWN, coreAlpha, fadeFactor, glowK, glowRadius,
  glowSigma, rowStrength } from "../src/chart/glow.ts";
import { COLOR_LUT, COLOR_LUT_STEPS, HEAT_STOPS } from "../src/chart/palette.ts";
import { bookBandEnd, bookGroupTicks, bookNumberStyle } from "../src/chart/book-numbers.ts";
import { boardColumns } from "../src/chart/layout.ts";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, defaultDocument, validDocument, validateSettings } from "../src/data/settings.ts";
import { FIELD_SPECS, SettingsForm } from "../src/components/settings-form.ts";
import { resetDurationSec } from "../src/chart/view-reset.ts";

test("Phase14: 9-stop / 256 LUT and glow primitives", () => {
  assert.equal(HEAT_STOPS.length, 9);
  assert.equal(COLOR_LUT_STEPS, 256);
  assert.equal(COLOR_LUT.length, 256 * 3);
  assert.deepEqual([...COLOR_LUT.slice(0, 3)], [0, 0, 0]);
  assert.equal(glowK(1), 2); assert.equal(glowK(6.4), 6); assert.equal(glowK(40), 10);
  assert.equal(glowSigma(2), 1.5); assert.equal(glowSigma(1), 1.2);
  assert.equal(glowRadius(4), Math.ceil(2.5 * 3));
  assert.equal(rowStrength(0, 1), 1);
  assert.ok(rowStrength(0, 10) < rowStrength(4, 10));
  assert.equal(coreAlpha(.5), .7); assert.equal(coreAlpha(1), 1);
});

test("Phase14: fade appear / cancel / eaten / unknown edge", () => {
  const states = (arr: number[], self: number) => (o: number) => arr[self + o] ?? UNKNOWN;
  const no = () => false;
  // appear: not painted then painted at index 1..
  const appear = [NOT_PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED];
  for (let k = 0; k < APPEAR_COLUMNS; k++) assert.equal(fadeFactor(states(appear, 1 + k), no), (k + 1) / 7);
  assert.equal(fadeFactor(states(appear, 7), no), 1);
  // unknown left edge: no fade
  assert.equal(fadeFactor(states([UNKNOWN, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED], 1), no), 1);
  // cancel: 4 columns before disappearance
  const cancel = [PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, NOT_PAINTED];
  const known = (o: number) => o < -7 ? PAINTED : cancel[7 + o] ?? UNKNOWN;
  assert.equal(fadeFactor(known, no), 1 / 5);
  assert.equal(fadeFactor(o => known(o - 3), no), 4 / 5);
  // eaten: a trade at that price cancels the cancel fade
  assert.equal(fadeFactor(known, o => o === 0), 1);
  assert.equal(fadeFactor(known, o => o === 1), 1 / 5, "消えた列の約定だけでは食われた判定にしない");
  const short = states([NOT_PAINTED, PAINTED, PAINTED, NOT_PAINTED], 1);
  assert.equal(fadeFactor(short, no), (1 / 7) * (2 / 5), "短命な板は出現と取消の倍率を掛ける");
  assert.equal(fadeFactor(short, o => o === 1), 1 / 7, "食われた板も出現倍率だけは適用");
  assert.equal(fadeFactor(states([NOT_PAINTED, PAINTED, PAINTED, NOT_PAINTED], 3), no), 0);
  assert.equal(fadeFactor(o => cancel[8 + o] === undefined ? UNKNOWN : PAINTED, no), 1);
  assert.equal(fadeFactor(() => NOT_PAINTED, no), 0);
});

function col(sec: number, size = 50): HeatColumn {
  return { timeUs: sec * 1e6, source: "live",
    bids: { prices: Int32Array.from({ length: 30 }, (_, i) => 100 - i), sizes: Uint32Array.from({ length: 30 }, (_, i) => i === 3 ? size : 1) },
    asks: { prices: Int32Array.from({ length: 30 }, (_, i) => 101 + i), sizes: Uint32Array.from({ length: 30 }, () => 1) } };
}

test("Phase14: incremental glow — appending a column recomputes only its neighbourhood", () => {
  const view: Viewport = { startUs: 0, durationSec: 100, centerPriceTicks: 100, priceSpanTicks: 20 };
  const cols = new Map<number, HeatColumn>();
  for (let s = 0; s < 80; s++) cols.set(s, col(s));
  const raster = new GlowRaster();
  const scale = { upper: 50, lower: 0, gamma: 1 };
  const f1 = raster.frame(s => cols.get(s) ?? null, view, 100, 100, scale, null);
  assert.equal(raster.metrics.fullFlush, true);
  assert.equal(f1.width, 100); assert.equal(f1.bucketSec, 1); assert.equal(f1.k, 5);
  cols.set(80, col(80));
  raster.frame(s => cols.get(s) ?? null, view, 100, 100, scale, null);
  assert.equal(raster.metrics.fullFlush, false);
  assert.equal(raster.metrics.sizeRecomputed, 1);
  assert.ok(raster.metrics.blurRecomputed <= 12, `blur ${raster.metrics.blurRecomputed}`);
  assert.ok(raster.metrics.composeRecomputed <= 14);
  raster.frame(s => cols.get(s) ?? null, view, 100, 100, { ...scale, upper: 60 }, null);
  assert.equal(raster.metrics.fullFlush, true);
});

test("Phase14: numeric book grouping, colours, band end", () => {
  assert.equal(bookGroupTicks(12), 1); assert.equal(bookGroupTicks(6), 2); assert.equal(bookGroupTicks(.01), 200);
  assert.deepEqual(bookNumberStyle(.95), { color: "#ff8a6a", bold: true });
  assert.deepEqual(bookNumberStyle(.8), { color: "#ffffff", bold: true });
  assert.deepEqual(bookNumberStyle(.1), { color: "#9c97b5", bold: false });
  assert.equal(bookBandEnd(100, 12), 79); assert.equal(bookBandEnd(100, 0), 100);
});

test("Phase14: layout, live reset width, settings v4 with 16 keys", () => {
  assert.deepEqual(boardColumns(false), [76, 5, 0, 19]);
  assert.deepEqual(boardColumns(true), [66, 5, 10, 19]);
  assert.equal(resetDurationSec("live"), 3600); assert.equal(resetDurationSec("replay"), 600);
  assert.equal(SETTINGS_VERSION, 4);
  assert.equal(Object.keys(DEFAULT_SETTINGS).length, 16);
  assert.equal(FIELD_SPECS.length, 14);
  const d = DEFAULT_SETTINGS;
  assert.deepEqual([d.heatTopPct, d.heatLowerMode, d.heatLowerPct, d.heatGamma, d.heatStyle, d.bigOrdersVisible],
    [5, "pct", 80, .5, "glow", false]);
  assert.ok(validDocument(defaultDocument()));
  assert.ok(!validDocument({ ...defaultDocument(), version: 3 }));
  assert.ok(validateSettings({ ...d, heatStyle: "x" }).heatStyle);
  assert.ok(validateSettings({ ...d, bigOrdersVisible: "true" }).bigOrdersVisible);
  const f = new SettingsForm();
  f.loadOk({ ...d, bookBarPct: 13, bookBarOpacity: .35 });
  f.set("bigOrdersVisible", "true"); f.set("heatStyle", "block");
  const saved = f.startSave()!;
  assert.equal(Object.keys(saved).length, 16);
  assert.equal(saved.bigOrdersVisible, true); assert.equal(saved.heatStyle, "block");
  assert.equal(saved.bookBarPct, 13); assert.equal(saved.bookBarOpacity, .35);
  f.loadOk({ ...d, bookBarPct: 17, bookBarOpacity: .75 });
  f.resetDefaults();
  assert.deepEqual(f.startSave(), d, "非表示2項目を含む全16項目を初期値へ戻す");
});
