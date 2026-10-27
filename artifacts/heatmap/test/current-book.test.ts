import assert from "node:assert/strict";
import test from "node:test";
import { currentBookRows, CurrentBookRenderer } from "../src/chart/current-book.ts";
import { computePixelMax } from "../src/chart/aggregate.ts";
import type { HeatColumn, Viewport } from "../src/domain.ts";

const view: Viewport = { startUs: 10_000_000, durationSec: 10, centerPriceTicks: 100, priceSpanTicks: 20 };
function book(bids = [[99, 5], [98, 20]], asks = [[101, 10], [103, 30]]): HeatColumn {
  const side = (levels: number[][]) => ({
    prices: Int32Array.from(levels.map(l => l[0]!)), sizes: Uint32Array.from(levels.map(l => l[1]!)),
  });
  return { timeUs: 10_000_000, source: "live", bids: side(bids), asks: side(asks) };
}

test("ダミー：共通tickセル、価格の欠け・領域外・空板・null", () => {
  const rows = currentBookRows(book(), view, 200);
  assert.equal(rows[106], 5); assert.equal(rows[110], 5);
  assert.equal(rows[116], 20); assert.equal(rows[120], 20);
  assert.equal(rows[86], 10); assert.equal(rows[90], 10);
  assert.equal(rows[100], 0); assert.equal(rows[80], 0);
  assert.ok(currentBookRows(null, view, 200).every(v => v === 0));
  assert.ok(currentBookRows(book([], []), view, 200).every(v => v === 0));
  assert.ok(currentBookRows(book([[50, 99]], [[150, 99]]), view, 200).every(v => v === 0));
});

test("ダミー：縮小時は両側を含め最大枚数、ヒートマップと同じ物理行", () => {
  const input = book([[99, 5], [98, 20]], [[101, 10], [103, 30]]);
  for (const height of [1, 3, 200, 400]) {
    const v = { ...view, centerPriceTicks: 100.3, priceSpanTicks: 21.7 };
    const expected = computePixelMax([input], v, 1, height).values;
    assert.deepEqual(currentBookRows(input, v, height), expected);
  }
  assert.deepEqual([...currentBookRows(input, view, 1)], [30]);
});

class Context {
  events: unknown[][] = [];
  fillStyle = ""; globalAlpha = 1;
  clearRect(...args: number[]) { this.events.push(["clear", ...args]); }
  fillRect(...args: number[]) { this.events.push(["rect", this.fillStyle, this.globalAlpha, ...args]); }
}
class Canvas {
  width = 0; height = 0; context = new Context();
  getContext() { return this.context; }
  getBoundingClientRect() { return { width: 100, height: 200 }; }
}

test("ダミー：右端基点・共通P99で頭打ち、帯→棒、不透明色、DPR、全量置換", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 2 }, configurable: true });
  try {
    const canvas = new Canvas();
    const r = new CurrentBookRenderer(canvas as unknown as HTMLCanvasElement);
    r.draw(book(), view, 20);
    assert.equal(canvas.width, 200); assert.equal(canvas.height, 400);
    assert.deepEqual(canvas.context.events[0], ["clear", 0, 0, 200, 400]);
    assert.deepEqual(canvas.context.events[1]!.slice(0, 6), ["rect", "#808080", 0.2, 0, 170, 200]);
    assert.ok(Math.abs(Number(canvas.context.events[1]![6]) - 60) < 1e-9);
    const bars = canvas.context.events.filter(e => e[1] === "#8a3cff");
    assert.ok(bars.some(e => e[3] === 150 && e[5] === 50)); // size 5
    assert.ok(bars.some(e => e[3] === 100 && e[5] === 100)); // size 10
    assert.ok(bars.some(e => e[3] === 0 && e[5] === 200)); // size >=20
    assert.ok(bars.every(e => e[2] === 1 && Number(e[3]) + Number(e[5]) === 200));
    assert.equal(r.metrics.p99, 20); assert.equal(r.metrics.timeUs, 10_000_000);
    canvas.context.events = [];
    r.draw(book([[99, 1]], []), { ...view, startUs: -1_000_000 }, 10);
    assert.ok(canvas.context.events.every(e => e[1] !== "#808080"));
    assert.ok(canvas.context.events.filter(e => e[0] === "rect").every(e => e[5] === 20));
    canvas.context.events = [];
    r.draw(null, view, 10);
    assert.deepEqual(canvas.context.events, [["clear", 0, 0, 200, 400]]);
    assert.equal(r.metrics.paintedRows, 0);
    assert.equal(r.metrics.drawCount, 3);
    assert.equal(r.metrics.timeUs, null);
    assert.ok(r.metrics.meanMs >= 0 && r.metrics.maxMs >= r.metrics.meanMs);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("ダミー：時間panでは現在板は変わらず、価格zoom・端のclipは共通座標", () => {
  const input = book();
  assert.deepEqual(currentBookRows(input, view, 200),
    currentBookRows(input, { ...view, startUs: 0, durationSec: 3600 }, 200));
  const zoomed = { ...view, priceSpanTicks: 8 };
  assert.deepEqual(currentBookRows(input, zoomed, 200),
    computePixelMax([input], zoomed, 1, 200).values);
  const edge = book([[90, 10]], [[110, 20]]);
  const rows = currentBookRows(edge, view, 200);
  assert.equal(rows[0], 20); assert.equal(rows[199], 10);
});
