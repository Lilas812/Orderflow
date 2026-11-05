import test from "node:test";
import assert from "node:assert/strict";
import { MOUNTAIN_COLORS, MOUNTAIN_FILL_OPACITY, MOUNTAIN_MAX_WIDTH_PCT, bookMountains, drawBookMountains,
  mountainLength } from "../src/chart/book-mountain.ts";
import { CurrentBookRenderer } from "../src/chart/current-book.ts";
import { bookBandEnd } from "../src/chart/book-numbers.ts";
import { priceTicksToY } from "../src/chart/coordinates.ts";
import type { HeatColumn, Viewport } from "../src/domain.ts";

// ダミー：今の板の山（SPEC 7.2、2026-11-05 ユーザー決定）。
const book = (bids: [number, number][], asks: [number, number][]): HeatColumn => ({ timeUs: 0, source: "live",
  bids: { prices: Int32Array.from(bids.map(b => b[0])), sizes: Uint32Array.from(bids.map(b => b[1])) },
  asks: { prices: Int32Array.from(asks.map(a => a[0])), sizes: Uint32Array.from(asks.map(a => a[1])) } });
const view: Viewport = { startUs: 0, durationSec: 10, centerPriceTicks: 100, priceSpanTicks: 20 };

test("ダミー：山の頂点は価格ごと（ティックの中心）、抜けた価格は0、両端に0の頂点", () => {
  const m = bookMountains(book([[99, 10], [97, 30]], [[101, 20], [102, 5]]), view, 200);
  // asks: 103(0) 102 101 100(0)、上（高い価格）から。
  assert.deepEqual(m.asks.map(p => p.size), [0, 5, 20, 0]);
  assert.deepEqual(m.asks.map(p => p.y), [103, 102, 101, 100].map(p => priceTicksToY(p, view, 200)));
  // bids: 100(0) 99 98(抜け=0) 97 96(0)。
  assert.deepEqual(m.bids.map(p => p.size), [0, 10, 0, 30, 0]);
  assert.equal(m.maxSize, 30);
  assert.deepEqual(bookMountains(null, view, 200), { asks: [], bids: [], maxSize: 0 });
});

test("ダミー：長さの基準は画面内の最大の板、画面外の板は基準にしないが最大の長さで頭打ち", () => {
  // 画面は 90〜110。150 の 999 枚は画面外。
  const m = bookMountains(book([[99, 10]], [[101, 40], [150, 999]]), view, 200);
  assert.equal(m.maxSize, 40);
  assert.equal(mountainLength(40, m.maxSize, 100), 100);
  assert.equal(mountainLength(10, m.maxSize, 100), 25);
  assert.equal(mountainLength(999, m.maxSize, 100), 100);
  // 頂点は画面の外側1ティックまで（150 までは並べない）。
  assert.ok(m.asks.every(p => p.y >= priceTicksToY(111, view, 200) - 1e-9));
});

test("ダミー：1ティックが1CSS画素より小さいと、同じ画素の行の価格を最大でまとめる", () => {
  const wide = { ...view, priceSpanTicks: 400 }, height = 100;
  const m = bookMountains(book([[99, 10], [98, 50], [97, 7]], [[101, 3]]), wide, height);
  for (const side of [m.asks, m.bids]) {
    const rows = side.map(p => p.y);
    assert.equal(new Set(rows).size, rows.length, "1行に1頂点");
    assert.ok(rows.every(y => y - Math.floor(y) === .5));
  }
  assert.ok(m.bids.some(p => p.size === 50));
  assert.ok(m.bids.length <= 400 * height / 400 + 2);
});

class PathContext {
  fillStyle = ""; strokeStyle = ""; globalAlpha = 1; lineWidth = 0; lineJoin = ""; font = ""; textAlign = ""; textBaseline = "";
  ops: unknown[][] = [];
  beginPath() { this.ops.push(["begin"]); }
  moveTo(x: number, y: number) { this.ops.push(["move", x, y]); }
  lineTo(x: number, y: number) { this.ops.push(["line", x, y]); }
  closePath() { this.ops.push(["close"]); }
  fill() { this.ops.push(["fill", this.fillStyle, this.globalAlpha]); }
  stroke() { this.ops.push(["stroke", this.strokeStyle, this.globalAlpha, this.lineWidth]); }
  clearRect() {} fillRect() {} setTransform() {}
  measureText(text: string) { return { width: text.length * 6 }; }
  fillText(text: string) { this.ops.push(["text", text]); }
}

test("ダミー：売りは紫・買いは薄グレー、半透明の塗りと不透明な縁、基準線から左へ伸びる", () => {
  const ctx = new PathContext();
  const m = bookMountains(book([[99, 10]], [[101, 20]]), view, 200);
  const drawn = drawBookMountains(ctx as unknown as CanvasRenderingContext2D, m, 80, 40);
  assert.equal(drawn, m.asks.length + m.bids.length);
  const fills = ctx.ops.filter(o => o[0] === "fill"), strokes = ctx.ops.filter(o => o[0] === "stroke");
  assert.deepEqual(fills, [["fill", MOUNTAIN_COLORS.ask, MOUNTAIN_FILL_OPACITY], ["fill", MOUNTAIN_COLORS.bid, MOUNTAIN_FILL_OPACITY]]);
  assert.deepEqual(strokes.map(s => [s[1], s[2]]), [[MOUNTAIN_COLORS.ask, 1], [MOUNTAIN_COLORS.bid, 1]]);
  const xs = ctx.ops.filter(o => o[0] === "line" || o[0] === "move").map(o => o[1] as number);
  assert.ok(xs.every(x => x >= 40 && x <= 80), "基準線 x=80 から最大40画素まで");
  assert.ok(ctx.ops.some(o => o[0] === "line" && o[1] === 40 && o[2] === priceTicksToY(101, view, 200)), "最大の板は最大の長さ");
  assert.ok(ctx.ops.some(o => o[0] === "line" && o[1] === 60 && o[2] === priceTicksToY(99, view, 200)), "半分の板は半分");
  assert.equal(drawBookMountains(ctx as unknown as CanvasRenderingContext2D, { asks: [], bids: [], maxSize: 0 }, 80, 40), 0);
});

test("ダミー：今の板の層では、山は数字の左（帯の終わり）から画面幅の10%まで、数字より先に描く", t => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 2 }, configurable: true });
  t.after(() => saved ? Object.defineProperty(globalThis, "window", saved) : Reflect.deleteProperty(globalThis, "window"));
  const ctx = new PathContext();
  const canvas = { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 300, height: 200 }) };
  const renderer = new CurrentBookRenderer(canvas as unknown as HTMLCanvasElement);
  const input = book([[99, 10], [98, 4]], [[101, 25], [102, 8]]);
  // 過去を見ている（帯なし）ときも山と数字は出す。
  renderer.draw(input, view, 20, 50e6, { style: "block" });
  const base = bookBandEnd(300, 2 * 6), length = 300 * MOUNTAIN_MAX_WIDTH_PCT / 100;
  const xs = ctx.ops.filter(o => o[0] === "line" || o[0] === "move").map(o => o[1] as number);
  assert.ok(xs.length > 0 && xs.every(x => x >= base - length - 1e-9 && x <= base + 1e-9));
  assert.ok(xs.includes(base - length));
  const firstText = ctx.ops.findIndex(o => o[0] === "text"), lastFill = ctx.ops.map(o => o[0]).lastIndexOf("fill");
  assert.ok(lastFill >= 0 && firstText > lastFill, "数字は山の上");
  assert.equal(renderer.metrics.mountainMaxSize, 25);
  assert.ok(renderer.metrics.mountainPoints > 0);
  ctx.ops.length = 0;
  renderer.draw(null, view, 20, 50e6, { style: "block" });
  assert.equal(renderer.metrics.mountainPoints, 0);
  assert.ok(ctx.ops.every(o => o[0] !== "fill"));
});
