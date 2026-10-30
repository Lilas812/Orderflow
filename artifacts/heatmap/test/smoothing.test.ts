import test from "node:test";
import assert from "node:assert/strict";
import { temporalQuantities, projectQuantities, mergeQuantity, SmoothingRaster } from "../src/chart/smoothing.ts";
import { readSmoothing, saveSmoothing } from "../src/data/smoothing-settings.ts";
import type { HeatColumn } from "../src/domain.ts";
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
