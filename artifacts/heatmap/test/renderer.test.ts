import assert from "node:assert/strict";
import test from "node:test";
import { computePixelMax } from "../src/chart/aggregate.ts";
import { HeatmapRenderer } from "../src/chart/renderer.ts";
import { TimeTileCache } from "../src/chart/tiles.ts";
import type { HeatColumn, Viewport } from "../src/domain.ts";
import { column } from "./helpers.ts";

class FakeImageData {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
  constructor(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

class FakeContext {
  imageSmoothingEnabled = false;
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  lastImage: FakeImageData | null = null;
  blits = 0;
  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  drawImage(): void { this.blits++; }
  putImageData(image: FakeImageData): void { this.lastImage = image; }
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly context = new FakeContext();
  cssWidth = 4;
  cssHeight = 4;
  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, left: 0, top: 0, right: this.cssWidth, bottom: this.cssHeight, width: this.cssWidth, height: this.cssHeight, toJSON: () => ({}) } as DOMRect;
  }
  getContext(): FakeContext { return this.context; }
}

function withFakeCanvas(run: (renderer: HeatmapRenderer, heat: FakeCanvas, axis: FakeCanvas) => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalImageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { devicePixelRatio: 1, setTimeout: () => 1, clearTimeout: () => {} },
  });
  Object.defineProperty(globalThis, "ImageData", { configurable: true, value: FakeImageData });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new FakeCanvas() } });
  try {
    const heat = new FakeCanvas();
    const axis = new FakeCanvas();
    const renderer = new HeatmapRenderer(heat as unknown as HTMLCanvasElement, axis as unknown as HTMLCanvasElement);
    // Explicit legacy options: these regression tests pin the Phase 10c block drawing.
    renderer.setStyle("block");
    renderer.setScaleOptions({ heatTopPct: 1, heatUpperMode: "auto", heatUpperSize: 100, heatLowerMode: "off",
      heatLowerPct: 20, heatLowerSize: 5, heatGamma: 1 });
    run(renderer, heat, axis);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalImageData) Object.defineProperty(globalThis, "ImageData", originalImageData);
    else Reflect.deleteProperty(globalThis, "ImageData");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

const baseView: Viewport = {
  startUs: 10_000_000,
  durationSec: 1,
  centerPriceTicks: 100,
  priceSpanTicks: 4,
};

test("ダミー：fractional pan/zoom の縦投影は生の最大値集計と一致する", () => {
  let seed = 123456;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const columns = Array.from({ length: 17 }, (_, i) => column(100 + i, {
    bids: Array.from({ length: 100 }, (_, p) => [40000 - p, next() % 100 + 1] as [number, number]),
    asks: Array.from({ length: 100 }, (_, p) => [40001 + p, next() % 100 + 1] as [number, number]),
  }));
  const tiles = new TimeTileCache(); tiles.setColumns(columns);
  for (let i = 0; i < 40; i++) {
    const view = { startUs: 100000000 + next() % 1000000, durationSec: 10 + next() % 8,
      centerPriceTicks: 40000 + (next() % 2001 - 1000) / 100,
      priceSpanTicks: 8 + (next() % 160000) / 100 };
    assert.deepEqual(tiles.aggregate(view, 67, 123).values, computePixelMax(columns, view, 67, 123).values);
  }
});

test("same-P99 data replacement repaints cached scalar pixels", () => {
  withFakeCanvas((renderer, heat) => {
    const first = column(10, { bids: [[100, 10]] });
    renderer.draw([first], baseView, 1, "UTC" as never, true);
    const firstImage = new Uint8ClampedArray(heat.context.lastImage!.data);
    assert.equal(renderer.metrics.p99, 10);
    assert.equal(renderer.metrics.rasterRebuilt, true);

    const replacement = column(10, { bids: [[101, 10]] });
    renderer.draw([replacement], baseView, 2, "UTC" as never, true);
    const replacementImage = heat.context.lastImage!.data;
    assert.equal(renderer.metrics.p99, 10);
    assert.equal(renderer.metrics.rasterRebuilt, true);
    assert.notDeepEqual(replacementImage, firstImage);
    assert.ok(renderer.metrics.rawLevelScans === 1);

    renderer.draw([replacement], { ...baseView, durationSec: 0.5 }, 3, "UTC" as never, true);
    assert.equal(renderer.metrics.rasterRebuilt, true);
    assert.equal(renderer.metrics.profileHits, 1);
    assert.equal(renderer.metrics.rawLevelScans, 0);

    const appended = column(11, { asks: [[102, 10]] });
    renderer.draw([replacement, appended], { ...baseView, durationSec: 2 }, 4, "UTC" as never, true);
    assert.equal(renderer.metrics.profileHits, 1);
    assert.equal(renderer.metrics.profileMisses, 1);
    assert.equal(renderer.metrics.recomputedColumns, 1);
    assert.equal(renderer.metrics.rawLevelScans, 1);
    assert.equal(renderer.metrics.tileInvalidations, 1);
  });
});

test("ダミー：初期chunkが可視範囲外でもP99=1を固定せず、最初の可視セルから計算する", () => {
  withFakeCanvas((renderer) => {
    renderer.draw([column(10, { bids: [[200, 10]] })], baseView, 1, "jst", true);
    assert.equal(renderer.metrics.p99, 1);
    assert.equal(renderer.metrics.scaleMs, 0);
    renderer.draw([column(10, { bids: [[100, 20]] })], baseView, 2, "jst", true);
    assert.equal(renderer.metrics.p99, 20);
  });
});

test("ダミー: an initial empty paint must not freeze P99=1 for the first received book", () => {
  withFakeCanvas(renderer => {
    renderer.draw([], baseView, 0, "jst", false);
    renderer.draw([column(10, { bids: [[100, 14]] })], baseView, 1, "jst", true);
    assert.equal(renderer.metrics.p99, 14);
  });
});

test("time zoom reuses per-column price profiles; an append invalidates only its time tile", () => {
  const tiles = new TimeTileCache();
  const first = column(10, { bids: [[100, 7], [101, 20]], asks: [[102, 9]] });
  const second = column(11, { bids: [[100, 8]] });
  tiles.setColumns([first, second]);
  const firstView = { ...baseView, durationSec: 2 };
  tiles.aggregate(firstView, 8, 4);
  assert.equal(tiles.metrics.rawLevelScans, 2);
  assert.equal(tiles.metrics.profileMisses, 2);

  tiles.setColumns([first, second]);
  tiles.aggregate({ ...firstView, durationSec: 1.5 }, 8, 4);
  assert.equal(tiles.metrics.rawLevelScans, 0);
  assert.equal(tiles.metrics.profileHits, 2);

  const appended = column(12, { asks: [[103, 33]] });
  tiles.setColumns([first, second, appended]);
  tiles.aggregate({ ...firstView, durationSec: 3 }, 8, 4);
  assert.equal(tiles.metrics.profileHits, 2);
  assert.equal(tiles.metrics.rawLevelScans, 1);
  assert.equal(tiles.metrics.recomputedColumns, 1);
  assert.equal(tiles.metrics.tileInvalidations, 1);
  assert.ok(tiles.metrics.cachedProfileBytes <= 48 * 1024 * 1024);
});

test("price zoom retains one reusable projection per column, and removal releases it", () => {
  const tiles = new TimeTileCache();
  const first = column(10, { bids: [[100, 7], [101, 20]], asks: [[102, 9]] });
  tiles.setColumns([first]);
  for (let n = 0; n < 100; n++) {
    const view = { ...baseView, durationSec: 1, priceSpanTicks: 4 + n / 20 };
    const actual = tiles.aggregate(view, 8, 40);
    const reference = new TimeTileCache();
    reference.setColumns([first]);
    assert.deepEqual(actual.values, reference.aggregate(view, 8, 40).values);
    assert.equal(tiles.metrics.cachedProfileBytes, 40 * 4);
  }
  tiles.setColumns([]);
  assert.equal(tiles.metrics.cachedProfileBytes, 0);
});

test("tiled max raster matches the full physical-pixel reference without downscaling", () => {
  const columns: HeatColumn[] = [
    column(100, { bids: [[10, 5], [12, 71]], asks: [[11, 12]] }),
    column(101, { bids: [[10, 99]], asks: [[11, 14]] }),
  ];
  const view: Viewport = {
    startUs: 100_000_000,
    durationSec: 2,
    centerPriceTicks: 10,
    priceSpanTicks: 4,
  };
  const expected = computePixelMax(columns, view, 3, 2);
  const cache = new TimeTileCache();
  cache.setColumns(columns);
  const actual = cache.aggregate(view, 3, 2);
  assert.deepEqual(actual.values, expected.values);
});

test("ダミー: streaming one physical pixel reuses the old image and paints only the dirty minute tile", () => {
  withFakeCanvas((renderer, heat) => {
    heat.cssWidth = 120;
    const first = column(119, { bids: [[100, 10]] });
    renderer.draw([first], { ...baseView, startUs: 0, durationSec: 120 }, 1, "jst", true);
    const appended = column(120, { bids: [[100, 10]] });
    renderer.draw([first, appended], { ...baseView, startUs: 1_000_000, durationSec: 120 }, 2, "jst", true);
    assert.equal(renderer.metrics.partialRaster, true);
    assert.equal(renderer.metrics.rawLevelScans, 1);
    assert.equal(renderer.metrics.repaintPixels, 4);
    assert.equal(heat.context.blits, 1);
  });
});

test("ダミー: clipped dirty-strip aggregation is identical to a complete raster including short gaps", () => {
  const cols = [
    column(100, { bids: [[10, 5]] }),
    column(103, { bids: [[11, 12]] }),
    column(107, { asks: [[12, 99]] }),
  ];
  const view = { startUs: 99_100_000, durationSec: 10, centerPriceTicks: 11, priceSpanTicks: 4 };
  const cache = new TimeTileCache();
  cache.setColumns(cols);
  const whole = cache.aggregate(view, 13, 7);
  const split = { width: 13, height: 7, values: new Uint32Array(13 * 7) };
  for (const [a, b] of [[0, 3], [3, 8], [8, 13]]) cache.aggregateStrip(split, view, a!, b!);
  assert.deepEqual(split.values, whole.values);
  assert.deepEqual(whole.values, computePixelMax(cols, view, 13, 7).values);
});
