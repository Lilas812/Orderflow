import test from "node:test";
import assert from "node:assert/strict";
import { rendererPreference } from "../src/chart/renderer.ts";
import { planSlotUploads } from "../src/chart/gpu-heatmap.ts";

test("renderer URL override: canvas / webgl forced, anything else auto", () => {
  assert.equal(rendererPreference("?renderer=canvas"), "canvas");
  assert.equal(rendererPreference("?debug=1&renderer=webgl"), "webgl");
  assert.equal(rendererPreference("?renderer=gpu"), "auto");
  assert.equal(rendererPreference(""), "auto");
});

test("ring slot planning: first frame uploads all, one-pixel follow uploads only the new column", () => {
  const W = 8, slots = new Int32Array(W).fill(-1);
  const ids = (first: number) => (x: number) => first + x; // absolute column id = absolute pixel
  let changed = planSlotUploads(W, 3 % W, ids(3), slots);
  assert.deepEqual(changed, [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const x of changed) slots[(x + 3) % W] = 3 + x;
  changed = planSlotUploads(W, 4 % W, ids(4), slots);
  assert.deepEqual(changed, [W - 1]);
  for (const x of changed) slots[(x + 4) % W] = 4 + x;
  // Settings-only redraw: same ids, same base -> nothing uploaded.
  assert.deepEqual(planSlotUploads(W, 4 % W, ids(4), slots), []);
});

test("eaten mask ring: only slots with changed signatures upload", () => {
  const W = 4, slots = ["", "", "", ""];
  const masks = new Map([[1, "2,3"]]);
  const key = (x: number) => masks.get(x) ?? "";
  assert.deepEqual(planSlotUploads(W, 0, key, slots), [1]);
  slots[1] = "2,3";
  assert.deepEqual(planSlotUploads(W, 0, key, slots), []);
  // Pan by one pixel: screen x=0 now maps to slot 1 and keeps the same mask.
  const shifted = (x: number) => (x === 0 ? "2,3" : "");
  assert.deepEqual(planSlotUploads(W, 1, shifted, slots), []);
});
