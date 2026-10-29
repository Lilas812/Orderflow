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
  font = ""; textAlign = ""; textBaseline = "";
  measureText(text: string) { return { width: text.length * 6 }; }
  setTransform() {}
  fillText(text: string, x: number, y: number) { this.events.push(["text", text, x, y, this.fillStyle, this.font]); }
}
class Canvas {
  width = 0; height = 0; context = new Context();
  getContext() { return this.context; }
  getBoundingClientRect() { return { width: 100, height: 200 }; }
}

test("Phase 14：棒をやめ数字を右寄せ、帯は最も広い数字の5px手前まで、DPR、全量置換", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 2 }, configurable: true });
  try {
    const canvas = new Canvas();
    const r = new CurrentBookRenderer(canvas as unknown as HTMLCanvasElement);
    r.draw(book(), view, 20, 15_000_000, { style: "block" });
    assert.equal(canvas.width, 200); assert.equal(canvas.height, 400);
    assert.deepEqual(canvas.context.events[0], ["clear", 0, 0, 200, 400]);
    const texts = canvas.context.events.filter(e => e[0] === "text");
    // 200 CSS px / 20 ticks = 10 px per tick < 11 -> groups of 2 ticks.
    assert.equal(r.metrics.groupTicks, 2);
    assert.deepEqual(texts.map(e => e[1]).sort(), ["10", "25", "30"].sort());
    assert.ok(texts.every(e => e[2] === 96), "right aligned 4 CSS px inside");
    assert.ok(canvas.context.events.every(e => e[1] !== "#8a3cff" && e[1] !== "#d9d9d9"), "no bars");
    // widest "30"/"20"/"10" = 2 chars * 6 = 12 -> band ends at (100 - 4 - 12 - 5) CSS = 79 * 2 physical.
    assert.equal(r.metrics.bandEnd, 158);
    const band = canvas.context.events.filter(e => e[0] === "rect" && String(e[1]).startsWith("rgb"));
    assert.ok(band.length > 0 && band.every(e => Number(e[3]) + Number(e[5]) === 158));
    canvas.context.events = [];
    r.draw(null, view, 10);
    assert.deepEqual(canvas.context.events, [["clear", 0, 0, 200, 400]]);
    assert.equal(r.metrics.numbers, 0);
    assert.equal(r.metrics.drawCount, 2);
    assert.equal(r.metrics.timeUs, null);
    canvas.context.events = [];
    // Price 110 is at the top edge and is excluded by the 6 CSS px label margin.
    r.draw(book([[110, 20]], []), view, 20, 15_000_000, { style: "block" });
    assert.equal(r.metrics.numbers, 0);
    assert.equal(r.metrics.bandStart, null);
    assert.equal(r.metrics.bandEnd, null);
    assert.equal(canvas.context.events.some(e => e[0] === "rect" || e[0] === "text"), false);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
