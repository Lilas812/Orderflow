import test from "node:test";
import assert from "node:assert/strict";
import { MIN_LINE_PX, glowBookColumn, glowK, lineStrength, rowStrength, wideLines } from "../src/chart/glow.ts";
import { SmoothingRaster, projectLines } from "../src/chart/smoothing.ts";
import { COLOR_LUT, lutIndex } from "../src/chart/palette.ts";
import type { HeatColumn, Viewport } from "../src/domain.ts";

// ダミー：縮小時の glow の線（SPEC 7、2026-11-05 ユーザー承認）。
const column = (sec: number, levels: [number, number][]): HeatColumn => ({ timeUs: sec * 1e6, source: "history",
  bids: { prices: Int32Array.from(levels.map(l => l[0])), sizes: Uint32Array.from(levels.map(l => l[1])) },
  asks: { prices: new Int32Array(), sizes: new Uint32Array() } });
const rgbAt = (image: Uint8ClampedArray, width: number, x: number, y: number) =>
  [image[(y * width + x) * 4]!, image[(y * width + x) * 4 + 1]!, image[(y * width + x) * 4 + 2]!];
const lut = (p: number) => { const i = lutIndex(p) * 3; return [COLOR_LUT[i]!, COLOR_LUT[i + 1]!, COLOR_LUT[i + 2]!]; };

test("ダミー：線の太さ＝1ティックの高さなら、今までのティックの行の強さと同じ", () => {
  for (const ppt of [5, 6.4, 8, 11, 23]) {
    const k = glowK(ppt), height = 200, top = 100.5, span = height / ppt;
    for (let y = 0; y < height; y++) {
      const p = top - (y + .5) * span / height, price = Math.round(p);
      const old = rowStrength(Math.min(k - 1, Math.floor((price + .5 - p) * k)), k);
      const center = (top - price) / span * height;
      assert.ok(Math.abs(lineStrength(y + .5 - center, ppt, k) - old) < 1e-9, `ppt=${ppt} y=${y}`);
    }
  }
});

test("ダミー：線モードは glow で1ティック5画素未満のときだけ", () => {
  assert.equal(MIN_LINE_PX, 5);
  assert.equal(wideLines(4.99), true); assert.equal(wideLines(5), false);
  const cols = [column(0, [[10, 100], [11, 1]])], r = new SmoothingRaster(), options = { time: "mean", price: "auto" } as const;
  const zoomIn: Viewport = { startUs: 0, durationSec: 1, centerPriceTicks: 10, priceSpanTicks: 4 };
  assert.equal(r.profiles(cols, zoomIn, 1, 40, options, "glow", null).line, false);
  assert.equal(r.profiles(cols, zoomIn, 1, 40, options, "glow", null).list[0]!.strength, null);
  const zoomOut = { ...zoomIn, priceSpanTicks: 20 };
  const line = r.profiles(cols, zoomOut, 1, 40, options, "glow", null);
  assert.equal(line.line, true); assert.ok(line.list[0]!.strength instanceof Float32Array);
  assert.equal(r.profiles(cols, zoomOut, 1, 40, options, "block", null).line, false, "四角いマスは変えない");
});

test("ダミー：縮小しても最大の板は芯が最大色（赤）まで届く（修正前は K=2 で #b9aeff 止まり）", () => {
  const cols = Array.from({ length: 10 }, (_, s) => column(s, [[100, 200]]));
  const scale = { upper: 50, lower: 0, gamma: 1 }, options = { time: "mean", price: "auto" } as const;
  for (const ppt of [0.4, 1.2, 2.2, 3.4, 4.9]) {
    const height = 220, view: Viewport = { startUs: 0, durationSec: 10, centerPriceTicks: 100, priceSpanTicks: height / ppt };
    const image = new SmoothingRaster().frame(cols, view, 10, height, options, scale, "glow", null);
    const center = Math.floor(height / 2);
    let reached = false;
    for (let y = center - 3; y <= center + 3; y++) if (rgbAt(image, 10, 5, y).join() === lut(1).join()) reached = true;
    assert.ok(reached, `ppt=${ppt}`);
    // 線は MIN_LINE_PX の範囲だけ（グローはその外にも出るが芯は出ない）。
    assert.deepEqual(rgbAt(image, 10, 5, center + 20), [0, 0, 0]);
  }
});

test("ダミー：線が重なった行は「枚数×線の強さ」が大きい価格、同点なら中心に近い線", () => {
  const ticks = new Map([[10, { sum: 100, weight: 1, max: 100 }], [11, { sum: 10, weight: 1, max: 10 }],
    [15, { sum: 0, weight: 1, max: 0 }]]);
  // 1ティック1画素、価格10の中心は y=10.5 付近、11 は 9.5。
  const { values, strength, coverage } = projectLines(ticks, 1, 20.5, 20, 20, { time: "mean", price: "auto" }, 5, 5);
  assert.equal(values[10], 100); assert.equal(strength[10], 1);
  assert.equal(values[9], 100, "隣の大きい板の線（強さ0.886×100）が小さい板の芯（1×10）に勝つ");
  assert.equal(values[7], 10, "価格11の線の端（0.171×10）が届く");
  assert.equal(values[5], 0, "0枚の価格も既知として線の範囲を持つ");
  assert.equal(coverage[5], 1);
  assert.equal(coverage[0], 0, "どの線も届かない行は不明のまま");
  const tie = projectLines(new Map([[10, { sum: 0, weight: 1, max: 0 }], [11, { sum: 0, weight: 1, max: 0 }]]),
    1, 20.5, 20, 20, { time: "mean", price: "auto" }, 5, 5);
  assert.equal(tie.strength[9], 1, "同点（0枚どうし）は中心に近い線の強さ");
});

test("ダミー：今の板の帯も縮小時は1画素1行の線で、最大の板は最大色になる", () => {
  const book = column(0, [[100, 200], [101, 3]]);
  const view: Viewport = { startUs: 0, durationSec: 1, centerPriceTicks: 100, priceSpanTicks: 100 };
  const line = glowBookColumn(book, view, 220, { upper: 50, lower: 0, gamma: 1 });
  assert.equal(line.line, true); assert.equal(line.rgba.length, 220 * 4);
  assert.equal(line.yTop, 0); assert.equal(line.destHeight, 220);
  const rows = Array.from({ length: 220 }, (_, y) => [line.rgba[y * 4]!, line.rgba[y * 4 + 1]!, line.rgba[y * 4 + 2]!].join());
  assert.ok(rows.includes(lut(1).join()));
  // 拡大時は今までどおり K 行×価格を、価格の行の位置に伸ばす。
  const zoomIn = { ...view, priceSpanTicks: 20 };
  const tick = glowBookColumn(book, zoomIn, 220, { upper: 50, lower: 0, gamma: 1 });
  assert.equal(tick.line, false); assert.equal(tick.rgba.length, tick.priceCount * tick.k * 4);
  const top = zoomIn.centerPriceTicks + zoomIn.priceSpanTicks / 2;
  assert.equal(tick.yTop, (top - (tick.topPrice + .5)) / zoomIn.priceSpanTicks * 220);
  assert.equal(tick.destHeight, tick.priceCount * 220 / zoomIn.priceSpanTicks);
});
