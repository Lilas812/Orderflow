import { test } from "node:test";
import assert from "node:assert/strict";
import { VpState } from "../src/data/vp.ts";
import { VpRenderer } from "../src/chart/vp.ts";
import type { Viewport } from "../src/domain.ts";

test("ダミー：VPの3色・DPR・白い2/2点線・1秒上限と遅延更新", t => {
  let time = 0, invalidations = 0;
  t.mock.method(performance, "now", () => time);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 2 }, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const fills: { color: string; length: number }[] = [];
  const dashes: number[][] = [];
  const context = { fillStyle: "", lineWidth: 0, strokeStyle: "",
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillRect(_x: number, _y: number, width: number) { fills.push({ color: this.fillStyle, length: width }); },
    setLineDash(values: number[]) { dashes.push(values); } };
  const canvas = { width: 0, height: 0, getContext: () => context,
    getBoundingClientRect: () => ({ width: 200, height: 200 }) };
  const state = new VpState();
  state.accept({ type: "vp", sessionStartSec: 0, upToSec: 1, loading: false,
    levels: [[100, 50, 0], [101, 30, 0], [102, 20, 0]] });
  const view = { startUs: 0, durationSec: 600, centerPriceTicks: 101, priceSpanTicks: 20 } as Viewport;
  const renderer = new VpRenderer(canvas as unknown as HTMLCanvasElement, () => {
    invalidations++; renderer.draw(state, view);
  });
  renderer.draw(state, view);
  assert.deepEqual(new Set(fills.map(x => x.color)), new Set(["#ffffff", "#f5a623", "#d9d9d9"]));
  assert.equal(Math.max(...fills.map(x => x.length)), 400); assert.equal(canvas.width, 400);
  assert.equal(context.lineWidth, 2); assert.deepEqual(dashes[0], [4, 4]);
  assert.equal(renderer.metrics.drawCount, 1);
  time = 10; renderer.draw(state, view); renderer.draw(state, view);
  assert.equal(renderer.metrics.drawCount, 1);
  time = 1000; t.mock.timers.tick(1000);
  assert.equal(renderer.metrics.drawCount, 2); assert.equal(invalidations, 1);
});
