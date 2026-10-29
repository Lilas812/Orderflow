import test from "node:test";
import assert from "node:assert/strict";
import { CurrentBookRenderer, bookBandStart, currentBookRows } from "../src/chart/current-book.ts";
import { colorize } from "../src/chart/renderer.ts";
import { bubbleRadius } from "../src/chart/trade-geometry.ts";
import { computePixelMax } from "../src/chart/aggregate.ts";
import { SettingsRecovery } from "../src/data/settings-recovery.ts";
import { defaultDocument, DEFAULT_SETTINGS, validateSettings } from "../src/data/settings.ts";
import { FIELD_SPECS, rangeText } from "../src/components/settings-form.ts";
import type { HeatColumn } from "../src/domain.ts";

test("ダミー：起動GET失敗→実接続回復時に再取得、成功まで警告維持・再取得重複なし", async () => {
  let reads = 0, warning = "", applied = 0;
  const recovery = new SettingsRecovery(async () => {
    if (++reads === 1) throw Error("dummy HTTP 503");
    return defaultDocument();
  }, () => { applied++; warning = ""; }, () => { warning = "設定を読めませんでした"; });
  await recovery.read(); assert.equal(reads, 1); assert.ok(warning); assert.equal(applied, 0);
  await Promise.all([recovery.connected(), recovery.connected()]);
  assert.equal(reads, 2); assert.equal(warning, ""); assert.equal(applied, 1);
  await recovery.connected(); assert.equal(reads, 2);
});

test("ダミー：追加設定・フォーム14項目（棒の2項目は画面に出さない）", () => {
  assert.equal(FIELD_SPECS.length, 14);
  // Phase 14: the two bar settings stay valid in the file but are no longer form fields.
  assert.ok(FIELD_SPECS.every(f => (f.key as string) !== "bookBarPct" && (f.key as string) !== "bookBarOpacity"));
  assert.match(rangeText(FIELD_SPECS.find(f => f.key === "bubbleScale")!), /0.1刻み/);
  for (const [key, good, bad] of [
    ["bubbleScale", [.5, 3, 1.1], [.4, 3.1, .55, "1", NaN]],
    ["bookBarPct", [5, 20, 11], [4, 21, 5.1, "5", NaN]],
    ["bookBarOpacity", [.1, 1, .15, .95], [.09, 1.01, .11, "0.5", NaN]],
  ] as const) {
    for (const n of good) assert.equal(Object.keys(validateSettings({ ...DEFAULT_SETTINGS, [key]: n })).length, 0);
    for (const n of bad) assert.ok(validateSettings({ ...DEFAULT_SETTINGS, [key]: n })[key]);
  }
});

test("ダミー：倍率下限/上限で半径の下限/上限・平方根比例が変わる", () => {
  for (const scale of [.5, 1, 2, 3]) {
    assert.equal(bubbleRadius(10, 10, scale), 3 * scale);
    assert.equal(bubbleRadius(40, 10, scale), 6 * scale);
    assert.equal(bubbleRadius(10000, 10, scale), 14 * scale);
  }
});

test("ダミー：色の帯は最新列の右だけ・過去なし・同一最大行/LUT/P99・空白外を塗らない・棒なし", t => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 1 }, configurable: true });
  t.after(() => old ? Object.defineProperty(globalThis, "window", old) : Reflect.deleteProperty(globalThis, "window"));
  const view = { startUs: 0, durationSec: 10, centerPriceTicks: 100, priceSpanTicks: 20 };
  const book: HeatColumn = { timeUs: 7e6, source: "live",
    bids: { prices: Int32Array.of(99, 95), sizes: Uint32Array.of(10, 5) },
    asks: { prices: Int32Array.of(101, 104), sizes: Uint32Array.of(20, 15) } };
  const events: { color: string; alpha: number; x: number; y: number; w: number }[] = [];
  const ctx = { fillStyle: "", globalAlpha: 1, font: "", textAlign: "", textBaseline: "", clearRect() { events.length = 0; },
    fillRect(x: number, y: number, w: number) { events.push({ color: this.fillStyle, alpha: this.globalAlpha, x, y, w }); },
    measureText: () => ({ width: 0 }), setTransform() {}, fillText() {} };
  const canvas = { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 100, height: 40 }) };
  const renderer = new CurrentBookRenderer(canvas as unknown as HTMLCanvasElement);
  for (const height of [1, 3, 40]) assert.deepEqual(currentBookRows(book, view, height),
    computePixelMax([book], view, 1, height).values);
  // Numbers measure 0 wide here, so the band is bounded by the band-end rule only.
  renderer.draw(book, view, 20, 8e6, { style: "block" });
  const band = events.filter(e => e.color.startsWith("rgb("));
  assert.ok(band.length);
  const end = renderer.metrics.bandEnd!;
  assert.ok(band.every(e => e.x === 80 && e.w === end - 80 && e.alpha === 1));
  const rows = currentBookRows(book, view, 40), rgba = colorize(rows, 20);
  for (const row of band) assert.equal(row.color, `rgb(${rgba[row.y * 4]},${rgba[row.y * 4 + 1]},${rgba[row.y * 4 + 2]})`);
  assert.deepEqual(band.map(e => e.y), [...rows.keys()].filter(y => rows[y]! > 0), "outside supplied levels remains transparent/black");
  assert.ok(events.every(e => e.color !== "#8a3cff" && e.color !== "#d9d9d9"), "Phase 14: no bars");
  renderer.draw(book, view, 20, 12e6, { style: "block" });
  assert.ok(events.every(e => !e.color.startsWith("rgb(")));
  assert.equal(bookBandStart(12e6, view, 100), null);
  assert.equal(bookBandStart(-1e6, view, 100), 0);
});
