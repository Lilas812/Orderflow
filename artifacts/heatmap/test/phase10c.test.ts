import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, validateSettings, settingsChanges } from "../src/data/settings.ts";
import { SettingsForm, fieldVisible } from "../src/components/settings-form.ts";
import { heatThresholds } from "../src/chart/scale.ts";
import { colorize } from "../src/chart/renderer.ts";
import { currentBookRows, CurrentBookRenderer } from "../src/chart/current-book.ts";
import { vpPriceRow, vpBandBounds, vpGuides, drawVpGuides, drawVpLabels } from "../src/chart/vp-decoration.ts";
import type { HeatColumn, Viewport } from "../src/domain.ts";

const view: Viewport = { startUs: 0, durationSec: 2, centerPriceTicks: 100, priceSpanTicks: 10 };
const column: HeatColumn = { timeUs: 0, source: "live",
  bids: { prices: new Int32Array([100, 99, 98, 97]), sizes: new Uint32Array([1, 2, 10, 0]) },
  asks: { prices: new Int32Array([101, 102, 800]), sizes: new Uint32Array([20, 100, 9999]) } };

test("ダミー：U自動は可視の正の値だけ、固定枚数は相場で変わらない", () => {
  assert.equal(heatThresholds([column], view, DEFAULT_SETTINGS).upper, 100);
  const fixed = { ...DEFAULT_SETTINGS, heatUpperMode: "size" as const, heatUpperSize: 17 };
  assert.equal(heatThresholds([column], view, fixed).upper, 17);
  assert.equal(heatThresholds([], view, fixed).upper, 17);
  assert.equal(heatThresholds([{ ...column, bids: column.asks }], view, fixed).upper, 17);
});

test("ダミー：Loなし・下位20%・固定・U以上の調整（U=1を含む）", () => {
  assert.deepEqual(heatThresholds([column], view, DEFAULT_SETTINGS), { upper: 100, lower: 0, lowerAdjusted: false });
  assert.equal(heatThresholds([column], view, { ...DEFAULT_SETTINGS, heatLowerMode: "pct" }).lower, 1);
  assert.equal(heatThresholds([column], view, { ...DEFAULT_SETTINGS, heatLowerMode: "size", heatLowerSize: 5 }).lower, 5);
  for (const size of [100, 200]) assert.deepEqual(heatThresholds([column], view,
    { ...DEFAULT_SETTINGS, heatLowerMode: "size", heatLowerSize: size }), { upper: 100, lower: 99, lowerAdjusted: true });
  assert.deepEqual(heatThresholds([], view, { ...DEFAULT_SETTINGS, heatUpperMode: "size", heatUpperSize: 1,
    heatLowerMode: "size", heatLowerSize: 10 }), { upper: 1, lower: 0, lowerAdjusted: true });
});

test("ダミー：Lo以下は黒、gamma1は既存LUT、0.5と2は指定の色位置", () => {
  const sizes = new Uint32Array([0, 1, 5, 6, 100, 200]);
  const rgba = colorize(sizes, 100, undefined, 5);
  for (let i = 0; i < 3; i++) assert.deepEqual([...rgba.slice(i * 4, i * 4 + 4)], [0, 0, 0, 255]);
  const old = colorize(sizes, 100);
  assert.deepEqual(colorize(sizes, 100, undefined, 0, 1), old);
  for (const gamma of [.5, 2]) {
    const actual = colorize(new Uint32Array([30]), 110, undefined, 10, gamma);
    // t=.2; compare with the same historical LUT at the transformed position.
    const expected = colorize(new Uint32Array([Math.round(.2 ** gamma * 1000000)]), 1000000);
    assert.deepEqual(actual, expected);
  }
});

class Context {
  fillStyle = ""; strokeStyle = ""; globalAlpha = 1; lineWidth = 0; font = ""; textAlign = ""; textBaseline = "";
  events: any[][] = [];
  clearRect(...args: number[]) { this.events.push(["clear", ...args]); }
  fillRect(...args: number[]) { this.events.push(["fill", this.fillStyle, this.globalAlpha, ...args]); }
  fillText(...args: unknown[]) { this.events.push(["text", this.fillStyle, this.font, ...args]); }
  setLineDash(v: number[]) { this.events.push(["dash", ...v]); }
  beginPath() {}
  moveTo(...v: number[]) { this.events.push(["move", ...v]); }
  lineTo(...v: number[]) { this.events.push(["line", ...v]); }
  stroke() { this.events.push(["stroke", this.strokeStyle, this.globalAlpha, this.lineWidth]); }
}
function canvas(width = 100, height = 100) {
  const ctx = new Context();
  return { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width, height }), ctx };
}
test("ダミー：現在板の帯は同じLo/gamma、棒はLo/gammaに依存せずUだけ", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 1 }, configurable: true });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "window", descriptor) : Reflect.deleteProperty(globalThis, "window"));
  const c = canvas(), renderer = new CurrentBookRenderer(c as unknown as HTMLCanvasElement);
  renderer.draw(column, view, 100, 1_000_000, 10, .5, 5, 2);
  const rows = currentBookRows(column, view, 100), expected = colorize(rows, 100, undefined, 5, 2);
  for (const e of c.ctx.events.filter(e => e[0] === "fill" && String(e[1]).startsWith("rgb"))) {
    const y = e[4], i = y * 4;
    assert.ok(rows[y] > 5);
    assert.equal(e[1], `rgb(${expected[i]},${expected[i + 1]},${expected[i + 2]})`);
  }
  const bars = c.ctx.events.filter(e => e[0] === "fill" && e[2] === .5);
  assert.ok(bars.some(e => e[5] < .5)); // Low-size bars are still present.
  const lengths = bars.map(e => e[5]);
  c.ctx.events = []; renderer.draw(column, view, 100, 1_000_000, 10, .5, 0, .5);
  assert.deepEqual(c.ctx.events.filter(e => e[0] === "fill" && e[2] === .5).map(e => e[5]), lengths);
});

test("ダミー：VAの帯と線は拡大・縮小時の同じ価格行、画面端をclip", () => {
  const area = { poc: 100, high: 102, low: 99, total: 100, included: 70 };
  for (const height of [2, 100]) {
    const band = vpBandBounds(area, view, height)!;
    assert.ok(band.first >= 0 && band.end <= height);
    const guides = vpGuides(area, view, height);
    assert.deepEqual(guides.map(g => g.kind), ["VAL", "VAH", "POC"]);
    for (const g of guides) assert.equal(g.y, vpPriceRow(g.price, view, height).line);
    if (height === 2) {
      assert.equal(band.first, Math.floor(vpPriceRow(area.high, view, height).line));
      assert.equal(band.end, Math.floor(vpPriceRow(area.low, view, height).line) + 1);
    }
  }
  assert.deepEqual(vpBandBounds({ ...area, high: 1000, low: 0 }, view, 100), { first: 0, end: 100 });
});

test("ダミー：線の全幅・色・dash・透明度、ラベルはPOCが最後", () => {
  const c = canvas(290, 100), labels = canvas(50, 100);
  const area = { poc: 100, high: 100, low: 100, total: 100, included: 100 };
  drawVpGuides(c as unknown as HTMLCanvasElement, area, view, 1);
  assert.deepEqual(c.ctx.events.filter(e => e[0] === "line"), [["line", 290, 50], ["line", 290, 50], ["line", 290, 50]]);
  assert.deepEqual(c.ctx.events.filter(e => e[0] === "stroke"), [
    ["stroke", "#f5a623", .8, 1], ["stroke", "#f5a623", .8, 1], ["stroke", "#ffffff", 1, 1],
  ]);
  assert.deepEqual(c.ctx.events.find(e => e[0] === "dash"), ["dash", 2, 2]);
  drawVpLabels(labels as unknown as HTMLCanvasElement, area, view, 1);
  const fills = labels.ctx.events.filter(e => e[0] === "fill");
  assert.deepEqual(fills.map(e => e[1]), ["#f5a623", "#f5a623", "#333333"]);
  assert.ok(labels.ctx.events.filter(e => e[0] === "text").every(e => e[2].startsWith("11px")));
});

test("6設定の範囲・刻み・mode、非表示値は保持して全14項目を送る", () => {
  assert.equal(Object.keys(DEFAULT_SETTINGS).length, 14);
  for (const [key, good, bad] of [
    ["heatUpperSize", [1, 100000], [0, 100001, 1.5, "10"]],
    ["heatLowerPct", [.1, 90], [0, 90.1, .15, NaN]],
    ["heatLowerSize", [0, 100000], [-1, 100001, .5]],
    ["heatGamma", [.3, 3], [.2, 3.1, .35, Infinity]],
    ["heatUpperMode", ["auto", "size"], ["off", "", null]],
    ["heatLowerMode", ["off", "pct", "size"], ["auto", "", null]],
  ] as const) {
    for (const v of good) assert.equal(validateSettings({ ...DEFAULT_SETTINGS, [key]: v })[key], undefined);
    for (const v of bad) assert.ok(validateSettings({ ...DEFAULT_SETTINGS, [key]: v })[key]);
  }
  const f = new SettingsForm(); f.loadOk({ ...DEFAULT_SETTINGS, heatUpperSize: 777, heatLowerSize: 88 });
  assert.equal(fieldVisible("heatUpperSize", f.inputs), false);
  f.set("heatUpperMode", "size"); f.set("heatLowerMode", "pct");
  assert.equal(fieldVisible("heatTopPct", f.inputs), false);
  assert.equal(fieldVisible("heatLowerPct", f.inputs), true);
  assert.equal(fieldVisible("heatLowerSize", f.inputs), false);
  const saved = f.startSave()!;
  assert.equal(saved.heatUpperSize, 777); assert.equal(saved.heatLowerSize, 88);
  assert.equal(Object.keys(saved).length, 14);
  for (const [key, value] of [["heatGamma", .5], ["heatUpperMode", "size"], ["heatLowerMode", "pct"]] as const) {
    const changes = settingsChanges(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, [key]: value });
    assert.deepEqual(Object.entries(changes).filter(([, yes]) => yes).map(([k]) => k), ["heat"]);
  }
});
