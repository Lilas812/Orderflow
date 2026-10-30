import test from "node:test";
import assert from "node:assert/strict";
import { temporalQuantities, projectQuantities, mergeQuantity, SmoothingRaster } from "../src/chart/smoothing.ts";
import { readSmoothing, saveSmoothing } from "../src/data/smoothing-settings.ts";
import type { HeatColumn } from "../src/domain.ts";
import { backgroundDpr, followStartUs } from "../src/chart/coordinates.ts";
const column = (sec: number, size: number, price = 10): HeatColumn => ({ timeUs: sec * 1e6, source: "history",
  bids: { prices: Int32Array.of(price), sizes: Uint32Array.of(size) },
  asks: { prices: new Int32Array(), sizes: new Uint32Array() } });
test("weighted seconds, explicit zero versus unknown, fractional edges and multistage", () => {
  const columns = Array.from({ length: 10 }, (_, s) => column(s, s ? 10 : 100));
  const q = temporalQuantities(columns, 0, 10).get(10)!;
  assert.equal(q.sum / q.weight, 19); assert.equal(q.max, 100);
  assert.deepEqual(mergeQuantity(temporalQuantities(columns.slice(0, 1), 0, 10).get(10)!,
    temporalQuantities(columns.slice(1), 0, 10).get(10)!), q);
  assert.equal(temporalQuantities([column(0, 100), column(1, 0)], 0, 2).get(10)!.sum / 2, 50);
  const unknown = temporalQuantities([column(0, 100)], 0, 2).get(10)!;
  assert.equal(unknown.sum / unknown.weight, 100); assert.equal(unknown.weight / 2, .5);
  const edge = temporalQuantities([column(0, 100), column(1, 10)], .5, 1.25).get(10)!;
  assert.equal(edge.sum, 52.5); assert.equal(edge.weight, .75);
});
test("price area, time-valid weights, expanded original values and maximum", () => {
  const ticks = new Map([[10, { sum: 100, weight: 1, max: 100 }], [11, { sum: 0, weight: 2, max: 0 }]]);
  const mean = projectQuantities(ticks, 2, 11.5, 2, 1, { time: "mean", price: "auto" });
  assert.ok(Math.abs(mean.values[0]! - 100 / 3) < .00001); assert.equal(mean.coverage[0], .75);
  assert.equal(projectQuantities(ticks, 2, 11.5, 2, 1, { time: "mean", price: "none" }).values[0], 100);
  assert.deepEqual([...projectQuantities(ticks, 2, 11.5, 2, 4, { time: "mean", price: "auto" }).values], [0, 0, 100, 100]);
});
test("cache correction, missing no glow leakage, no implicit future or short gap interpolation", () => {
  const r = new SmoothingRaster(), v = { startUs: 0, durationSec: 4, centerPriceTicks: 10, priceSpanTicks: 1 };
  const cols = [column(0, 100), column(3, 10)], opt = { time: "mean", price: "auto" } as const;
  const scale = { upper: 200, lower: 0, gamma: 1 };
  const a = r.frame(cols, v, 8, 2, opt, scale, "glow", null);
  for (const x of [2, 3, 4, 5]) for (let y = 0; y < 2; y++) assert.equal(a[(y * 8 + x) * 4], 0);
  r.frame(cols, v, 8, 2, opt, scale, "glow", null); assert.equal(r.metrics.recomputedColumns, 0);
  r.frame([column(0, 30), cols[1]!], v, 8, 2, opt, scale, "glow", null); assert.equal(r.metrics.recomputedColumns, 2);
  const future = r.frame(cols, { ...v, startUs: 4e6 }, 8, 2, opt, scale, "block", null);
  assert.ok(future.every((n, i) => i % 4 === 3 ? n === 255 : n === 0));
  assert.ok(r.metrics.cachedBytes <= 48 * 1024 * 1024);
});
test("tab settings separate symbols, defaults, no server setting side effects", () => {
  const data = new Map<string, string>(), storage = { getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); } };
  assert.deepEqual(readSmoothing(storage, "GC"), { time: "mean", price: "auto" });
  saveSmoothing(storage, "NQ", { time: "max", price: "none" });
  assert.equal(readSmoothing(storage, "NQ").time, "max"); assert.equal(readSmoothing(storage, "GC").time, "mean");
});

test("epoch follow grid reuses overlapping pixels at DPR1/2 and matches a fresh raster", () => {
  const head = 1_793_350_000, durationSec = 1800;
  const columns = Array.from({ length: 1800 }, (_, s) => column(head - 1799 + s, s % 113));
  const scale = { upper: 200, lower: 0, gamma: 1 };
  for (const width of [928, 1856]) for (const style of ["block", "glow"] as const) {
    const raster = new SmoothingRaster(), options = { time: "mean", price: "auto" } as const;
    let previousIndex: number | undefined;
    for (let step = 0; step <= 5; step++) {
      const startUs = followStartUs((head + step) * 1e6, durationSec, width);
      const view = { startUs, durationSec, centerPriceTicks: 10, priceSpanTicks: 2 };
      const index = Math.round(startUs / (durationSec * 1e6 / width));
      const image = raster.frame(columns, view, width, 4, options, scale, style, null);
      const advance = previousIndex === undefined ? width : index - previousIndex;
      assert.equal(raster.metrics.recomputedColumns, advance, `width=${width}, ${style}, step=${step}`);
      if (advance < width) assert.ok(raster.metrics.coreColumns < 50);
      assert.deepEqual(image, new SmoothingRaster().frame(columns, view, width, 4, options, scale, style, null));
      previousIndex = index;
    }
    const view = { startUs: followStartUs((head + 5) * 1e6, durationSec, width),
      durationSec, centerPriceTicks: 10, priceSpanTicks: 2 };
    // A late replacement changes only the pixel(s) overlapping this second.
    const corrected = [...columns]; corrected[1000] = column(head - 799, 91);
    const image = raster.frame(corrected, view, width, 4, options, scale, style, null);
    assert.ok(raster.metrics.recomputedColumns > 0 && raster.metrics.recomputedColumns <= 3);
    assert.deepEqual(image, new SmoothingRaster().frame(corrected, view, width, 4, options, scale, style, null));
  }
});

test("arbitrary pan, zoom, geometry and mode changes retain exact fresh-raster results", () => {
  const columns = Array.from({ length: 20 }, (_, s) => column(s, s ? 10 : 100));
  const raster = new SmoothingRaster(), scale = { upper: 200, lower: 0, gamma: 1 };
  for (const startUs of [123_457, 1_777_777, 123_457, 0]) for (const durationSec of [10, 10.1234567])
    for (const time of ["mean", "max"] as const) for (const price of ["auto", "none"] as const) {
      const view = { startUs, durationSec, centerPriceTicks: 10.125, priceSpanTicks: 3 };
      const image = raster.frame(columns, view, 17, 2, { time, price }, scale, "glow", null);
      assert.deepEqual(image, new SmoothingRaster().frame(columns, view, 17, 2, { time, price }, scale, "glow", null));
    }
});

test("rounded follow edges use their actual duration: fully known pixels retain full coverage", () => {
  const head = 1_793_350_000, scale = { upper: 200, lower: 0, gamma: 1 };
  const options = { time: "mean", price: "auto" } as const;
  const columns = Array.from({ length: 60 }, (_, i) => column(head - 30 + i, 100));
  const reference = new SmoothingRaster().frame([column(0, 100)],
    { startUs: 0, durationSec: 1, centerPriceTicks: 10, priceSpanTicks: 1 }, 1, 1, options, scale, "block", null);
  for (const width of [928, 1856]) {
    const view = { startUs: followStartUs(head * 1e6, 10, width),
      durationSec: 10, centerPriceTicks: 10, priceSpanTicks: 1 };
    const image = new SmoothingRaster().frame(columns, view, width, 1, options, scale, "block", null);
    for (let x = 0; x < width; x++) assert.deepEqual(image.slice(x * 4, x * 4 + 4), reference);
  }
});

test("retained RGBA, dirty strips and both-direction scroll match full repaint at effective DPR", () => {
  const head = 1_793_350_000;
  for (const dpr of [1, 2, 3]) for (const style of ["block", "glow"] as const) {
    const width = 64 * backgroundDpr(dpr), height = 12 * backgroundDpr(dpr);
    const raster = new SmoothingRaster();
    let cols = Array.from({ length: 90 }, (_, i) => column(head - 80 + i, i % 11 === 0 ? 0 : (i * 17) % 150));
    let shared: Uint8ClampedArray | undefined;
    for (let step = 0; step < 24; step++) {
      const time = step % 7 === 0 ? "max" : "mean", price = step % 5 === 0 ? "none" : "auto";
      const durationSec = step >= 17 ? 71.123 : 60;
      const startUs = step >= 12 && step <= 15 ? (head - 45) * 1e6 + step * 123_457
        : followStartUs((head + (step < 8 ? step : 16 - step)) * 1e6, durationSec, width);
      const view = { startUs, durationSec, centerPriceTicks: 10.125, priceSpanTicks: step > 20 ? 12 : 25 };
      if (step === 4) { cols = [...cols]; cols[40] = column(head - 40, 137); }
      if (step === 10) cols = cols.filter((_, i) => i !== 42);
      const scale = { upper: step > 18 ? 170 : 200, lower: 0, gamma: step > 18 ? .7 : 1 };
      const actual = raster.frame(cols, view, width, height, { time, price }, scale, style, null);
      if (shared) assert.equal(actual, shared, "reuse full-size RGBA even across pan/zoom/settings");
      shared = actual;
      assert.deepEqual(actual, new SmoothingRaster().frame(cols, view, width, height, { time, price }, scale, style, null),
        `DPR=${dpr} style=${style} step=${step}`);
    }
    assert.equal(backgroundDpr(dpr), Math.min(dpr, 2));
  }
});

test("stationary and one-pixel follow preserve the image and restrict dirty columns", () => {
  const cols = Array.from({ length: 120 }, (_, i) => column(i, i % 100));
  const raster = new SmoothingRaster(), options = { time: "mean", price: "auto" } as const;
  const view = { startUs: 0, durationSec: 120, centerPriceTicks: 10, priceSpanTicks: 1 };
  const scale = { upper: 200, lower: 0, gamma: 1 };
  const first = raster.frame(cols, view, 120, 4, options, scale, "glow", null);
  assert.equal(raster.frame(cols, view, 120, 4, options, scale, "glow", null), first);
  assert.equal(raster.dirtyRanges.length, 0);
  const moved = { ...view, startUs: 1e6 };
  raster.frame(cols, moved, 120, 4, options, scale, "glow", null);
  assert.equal(raster.shiftPixels, 1); assert.equal(raster.fullRepaint, false);
  assert.ok(raster.dirtyRanges.reduce((n, [a,b]) => n+b-a, 0) < 30);
  assert.deepEqual(first, new SmoothingRaster().frame(cols, moved, 120, 4, options, scale, "glow", null));
});
