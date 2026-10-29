import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoPriceScale, fitPriceViewport, resetTimeViewport } from "../src/chart/axis-view.ts";
import { bindDoubleActivation, DoubleTap } from "../src/chart/double-activation.ts";
import { TradeAggregator } from "../src/data/trade-aggregate.ts";
import { followStartUs } from "../src/chart/coordinates.ts";
import type { Viewport } from "../src/domain.ts";

const view: Viewport = { startUs: 1_500_000, durationSec: 10, centerPriceTicks: 100, priceSpanTicks: 80 };
function trades(rows: [number, number][]): TradeAggregator {
  const result = new TradeAggregator();
  result.appendLive(rows.map(([tsUs, price], seq) => ({ tsUs, price, seq, recvUs: tsUs, size: 1, side: "buy" })));
  return result;
}

test("AUTO fits exact visible trades, including partial seconds, with ten percent margins", () => {
  const data = trades([[1_499_999, -999], [1_500_000, 100], [2_000_000, 180],
    [11_499_999, 140], [11_500_000, 999]]);
  const fit = fitPriceViewport(view, data, 50);
  assert.equal(fit.centerPriceTicks, 140);
  assert.equal(fit.priceSpanTicks, 100);
  assert.equal((fit.centerPriceTicks + fit.priceSpanTicks / 2 - 180) / fit.priceSpanTicks, 0.1);
  assert.equal((fit.centerPriceTicks + fit.priceSpanTicks / 2 - 100) / fit.priceSpanTicks, 0.9);
  assert.equal(fit.startUs, view.startUs);
  assert.equal(fit.durationSec, view.durationSec);
});

test("AUTO minimum is twenty ticks; no trades restores current price and initial scale", () => {
  assert.equal(fitPriceViewport(view, trades([[2_000_000, 121]]), 50).priceSpanTicks, 20);
  assert.deepEqual(fitPriceViewport(view, trades([]), 50),
    { ...view, centerPriceTicks: 50, priceSpanTicks: 160 });
  assert.equal(fitPriceViewport(view, trades([[2_000_000, 0], [3_000_000, 2_000]]), 50).priceSpanTicks, 2_500);
});

test("only committed history affects AUTO; range replacement and live arrivals update bounds", () => {
  const data = trades([[2_000_000, 100]]);
  data.beginRange(1, 2_000_000, 3_000_000);
  data.appendRangeChunk(1, [{ tsUs: 2_100_000, recvUs: 2_100_000, seq: 2, price: 200, size: 1, side: "sell" }]);
  assert.deepEqual(data.priceExtent(view.startUs, 11_500_000), { min: 100, max: 100 });
  data.appendLive([{ tsUs: 2_200_000, recvUs: 2_200_000, seq: 3, price: 250, size: 1, side: "buy" }]);
  data.commitRange(1);
  assert.deepEqual(data.priceExtent(view.startUs, 11_500_000), { min: 200, max: 250 });
});

test("AUTO coalesces updates at most once a second, and manual/reset disable stops pending work", () => {
  const auto = new AutoPriceScale(), data = trades([[2_000_000, 100]]);
  assert.equal(auto.delay(0), null);
  auto.enable();
  assert.ok(auto.fit(0, view, data, 50));
  assert.equal(auto.delay(100), null);
  auto.invalidate();
  assert.equal(auto.delay(100), 900);
  assert.equal(auto.fit(999, view, data, 50), null);
  assert.ok(auto.fit(1_000, { ...view, startUs: 20_000_000 }, data, 50));
  auto.invalidate(); auto.disable();
  assert.equal(auto.fit(2_000, view, data, 50), null);
  auto.enable();
  assert.ok(auto.fit(2_000, view, data, 50));
});

test("time reset preserves both price coordinates and returns to live/replay anchor at initial duration", () => {
  for (const mode of ["live", "replay"] as const) {
    const reset = resetTimeViewport(view, 900_000_000, 1_000, mode);
    const duration = mode === "live" ? 3600 : 600;
    assert.equal(reset.durationSec, duration);
    assert.equal(reset.startUs, followStartUs(mode === "live" ? 900_000_000 : 899_000_000, duration, 1_000));
    assert.equal(reset.centerPriceTicks, view.centerPriceTicks);
    assert.equal(reset.priceSpanTicks, view.priceSpanTicks);
  }
});

test("double tap recognizes a pair, but not drag, cancel, slow or multi-pointer gestures", () => {
  const tap = new DoubleTap();
  const single = (at: number) => { tap.down(1, 10, 20, at); return tap.up(1, 10, 20, at + 50); };
  assert.equal(single(0), false);
  assert.equal(single(200), true);
  assert.equal(single(400), false);
  tap.down(1, 10, 20, 500); tap.move(1, 30, 20);
  assert.equal(tap.up(1, 10, 20, 550), false);
  assert.equal(single(600), false);
  tap.down(1, 10, 20, 700);
  assert.equal(tap.up(1, 10, 20, 750, true), false);
  assert.equal(single(800), false);
  assert.equal(single(1_200), false);
  tap.down(1, 10, 20, 1_300); tap.down(2, 10, 20, 1_301);
  assert.equal(tap.up(1, 10, 20, 1_350), false);
  assert.equal(tap.up(2, 10, 20, 1_351), false);
  tap.clear();
  assert.equal(single(1_400), false);
});

test("axis event binding handles mouse, touch, native duplicate suppression and modal cancellation", () => {
  class Element extends EventTarget {
    captures = new Set<number>();
    setPointerCapture(id: number) { this.captures.add(id); }
    hasPointerCapture(id: number) { return this.captures.has(id); }
    releasePointerCapture(id: number) { this.captures.delete(id); }
  }
  const element = new Element();
  let count = 0;
  const clear = bindDoubleActivation(element as unknown as HTMLElement, () => count++);
  const send = (type: string, id = 1, x = 10) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerType: "touch", pointerId: id, clientX: x, clientY: 20 });
    element.dispatchEvent(event);
    return event;
  };
  assert.equal(send("dblclick").defaultPrevented, true);
  assert.equal(count, 1);
  send("pointerdown"); send("pointerup");
  send("pointerdown"); send("pointerup");
  assert.equal(count, 2);
  send("dblclick");
  assert.equal(count, 2);
  send("pointerdown"); send("pointermove", 1, 40); send("pointerup");
  send("pointerdown"); send("pointerup");
  assert.equal(count, 2);
  send("pointerdown"); clear(); send("pointerup");
  assert.equal(element.captures.size, 0);
  send("pointerdown"); send("pointerup");
  assert.equal(count, 2);
  clear();
});
