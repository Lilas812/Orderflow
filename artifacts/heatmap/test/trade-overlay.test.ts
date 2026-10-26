import assert from "node:assert/strict";
import test from "node:test";
import { TradeOverlayRenderer } from "../src/chart/trade-overlay.ts";
import { TradeAggregator } from "../src/data/trade-aggregate.ts";
class Context {
  events: unknown[][] = [];
  fillStyle = ""; strokeStyle = ""; lineWidth = 0; globalAlpha = 1;
  font = ""; textAlign = ""; textBaseline = "";
  setTransform(...args: number[]) { this.events.push(["transform", ...args]); }
  clearRect() { this.events.push(["clear"]); }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  arc(x: number, y: number, radius: number) { this.events.push(["arc", x, y, radius]); }
  fill() { this.events.push(["fill", this.fillStyle, this.globalAlpha]); }
  stroke() { this.events.push(["stroke", this.strokeStyle, this.lineWidth]); }
  setLineDash(dash: number[]) { this.events.push(["dash", ...dash]); }
  fillRect() { this.events.push(["rect", this.fillStyle]); }
  fillText(text: string) { this.events.push(["label", text, this.fillStyle]); }
}
class Canvas {
  context = new Context(); width = 0; height = 0;
  getContext() { return this.context; }
  getBoundingClientRect() { return { width: 100, height: 200 }; }
}
test("ダミー：独立overlayの描画順、CSSの太さ/半径/点線、白地黒字の現在値", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 2 }, configurable: true });
  try {
    const heat = new Canvas(), book = new Canvas(), axis = new Canvas();
    const renderer = new TradeOverlayRenderer(
      heat as unknown as HTMLCanvasElement, book as unknown as HTMLCanvasElement, axis as unknown as HTMLCanvasElement,
    );
    const a = new TradeAggregator();
    a.appendLive([{ tsUs: 10_100_000, recvUs: 11_000_000, seq: 1, price: 100, size: 10, side: "buy" }]);
    const view = { startUs: 10_000_000, durationSec: 10, centerPriceTicks: 100, priceSpanTicks: 20 };
    renderer.draw(a, view, 10, 100);
    const events = heat.context.events;
    assert.deepEqual(events.filter(e => e[0] === "stroke"), [
      ["stroke", "#b9a7ff", 1.5], ["stroke", "#2a9a5c", 1], ["stroke", "#ffffff", 1],
    ]);
    assert.deepEqual(events.find(e => e[0] === "fill"), ["fill", "#3ddc84", 0.8]);
    assert.deepEqual(events.find(e => e[0] === "arc"), ["arc", 5, 100, 3]);
    assert.deepEqual(events.find(e => e[0] === "dash"), ["dash", 4, 4]);
    assert.deepEqual(book.context.events.filter(e => e[0] === "stroke"), [["stroke", "#ffffff", 1]]);
    assert.deepEqual(axis.context.events.filter(e => e[0] === "rect" || e[0] === "label"),
      [["rect", "#ffffff"], ["label", "25.00", "#000000"]]);
    assert.equal(heat.width, 200);
    const previous = events.length;
    a.appendLive([{ tsUs: 11_100_000, recvUs: 12_000_000, seq: 2, price: 101, size: 12, side: "sell" }]);
    renderer.draw(a, view, 10, 101);
    assert.equal(renderer.metrics.bubbleCount, 2);
    assert.ok(events.length > previous, "trade-only update paints the separate overlay without any heatmap renderer");
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved); else Reflect.deleteProperty(globalThis, "window");
  }
});
