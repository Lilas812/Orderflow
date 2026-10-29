import assert from "node:assert/strict";
import test from "node:test";
import { CrosshairOverlay, crosshairValues, fitCursorLabel } from "../src/chart/crosshair.ts";
import { formatCrosshairTimeUs } from "../src/chart/timezone.ts";

const view = { startUs: Date.UTC(2026, 9, 29, 15, 59, 0) * 1_000, durationSec: 120,
  centerPriceTicks: 117241, priceSpanTicks: 160 };

test("crosshair: existing inverse coordinates, quarter-point rounding and containing second", () => {
  const value = crosshairValues({ x: 123.4, y: 123.4 }, view, 800, 400, "jst");
  assert.equal(value.timeUs, view.startUs + 18_000_000);
  assert.equal(value.priceTicks, 117272);
  assert.equal(value.price, "29318.00");
  assert.equal(value.time, "10/30 00:59:18");
  assert.equal(crosshairValues({ x: 0, y: 0 }, view, 800, 400, "ct").priceTicks, 117321);
  const blank = crosshairValues({ x: 799, y: 399 }, view, 800, 400, "ct");
  assert.equal(blank.timeUs, view.startUs + 119_000_000);
  assert.equal(blank.time, "10/29 11:00:59");
});

test("crosshair: date rollover and Chicago DST use configured IANA zone", () => {
  assert.equal(formatCrosshairTimeUs(Date.UTC(2026, 10, 1, 6, 59, 59) * 1e3, "ct"), "11/01 01:59:59");
  assert.equal(formatCrosshairTimeUs(Date.UTC(2026, 10, 1, 7, 0, 0) * 1e3, "ct"), "11/01 01:00:00");
  assert.equal(formatCrosshairTimeUs(Date.UTC(2026, 11, 31, 15) * 1e3, "jst"), "01/01 00:00:00");
});

test("crosshair: labels stay in narrow axes without shifting coordinate values", () => {
  const axis = { x: 800, y: 0, width: 50, height: 400 };
  assert.deepEqual(fitCursorLabel(axis, { x: 825, y: 0 }, 60), { x: 800, y: 0, width: 50, height: 18 });
  assert.equal(fitCursorLabel(axis, { x: 825, y: 399 }, 40).y, 382);
  assert.deepEqual(fitCursorLabel({ x: 0, y: 500, width: 800, height: 14 }, { x: 799, y: 507 }, 100),
    { x: 692, y: 500, width: 108, height: 14 });
});

test("crosshair: one pending frame, idle stops, latest view, blur/hidden/modal/touch/leave cleanup", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const keys = ["window", "document", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame"];
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  const ctx = Object.fromEntries(["clearRect", "setTransform", "beginPath", "moveTo", "lineTo", "stroke", "setLineDash",
    "save", "rect", "clip", "fillRect", "fillText", "restore"].map(key => [key, () => {}])) as Record<string, unknown>;
  ctx.measureText = (text: string) => ({ width: text.length * 7 });
  class Element extends EventTarget {
    width = 0; height = 0;
    readonly rect: { x: number; y: number; width: number; height: number };
    constructor(rect: { x: number; y: number; width: number; height: number }) { super(); this.rect = rect; }
    getBoundingClientRect() { return this.rect; }
    getContext() { return ctx; }
    append() {} setAttribute() {} remove() {}
  }
  const board = new Element({ x: 0, y: 0, width: 1000, height: 520 });
  const heat = new Element({ x: 0, y: 0, width: 800, height: 400 });
  const axis = new Element({ x: 800, y: 0, width: 50, height: 400 });
  const time = new Element({ x: 0, y: 500, width: 800, height: 20 });
  const win = Object.assign(new EventTarget(), { devicePixelRatio: 2 });
  const doc = Object.assign(new EventTarget(), { hidden: false, createElement: () => new Element(board.rect) });
  const flush = () => { const batch = [...frames.values()]; frames.clear(); for (const fn of batch) fn(0); };
  const move = (x = 200, pointerType = "mouse") => heat.dispatchEvent(Object.assign(new Event("pointermove"),
    { clientX: x, clientY: 100, pointerType }));
  let active = true, currentView = { ...view };
  let overlay: CrosshairOverlay | undefined;
  try {
    globals.window = win; globals.document = doc;
    globals.ResizeObserver = class { observe() {} disconnect() {} };
    globals.requestAnimationFrame = (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; };
    globals.cancelAnimationFrame = (key: number) => frames.delete(key);
    overlay = new CrosshairOverlay(board as unknown as HTMLElement, heat as unknown as HTMLCanvasElement,
      axis as unknown as HTMLElement, time as unknown as HTMLElement, () => currentView, () => "jst", () => active);
    for (let n = 0; n < 100; n++) move(200 + n);
    assert.equal(frames.size, 1); flush();
    assert.equal(overlay.snapshot().x, 299); assert.equal(overlay.snapshot().drawCount, 1);
    assert.equal(frames.size, 0, "no idle animation loop");
    assert.equal(overlay.canvas.width, 2000, "DPR applies only to backing pixels");
    currentView = { ...currentView, centerPriceTicks: view.centerPriceTicks + 10 };
    overlay.request(); flush();
    assert.equal(overlay.snapshot().priceTicks, 117291);
    for (const hide of [
      () => win.dispatchEvent(new Event("blur")),
      () => heat.dispatchEvent(new Event("pointerleave")),
      () => { doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange")); doc.hidden = false; },
      () => move(200, "touch"),
      () => { active = false; overlay!.request(); flush(); active = true; },
    ]) {
      move(); flush(); assert.equal(overlay.snapshot().visible, true);
      hide(); assert.equal(overlay.snapshot().visible, false); assert.equal(frames.size, 0);
    }
    move(900); flush(); assert.equal(overlay.snapshot().visible, false, "captured drag outside body");
  } finally {
    overlay?.destroy();
    keys.forEach((key, n) => {
      if (originals[n]) Object.defineProperty(globalThis, key, originals[n]!); else delete globals[key];
    });
  }
});
