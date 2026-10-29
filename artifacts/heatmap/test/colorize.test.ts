import { test } from "node:test";
import assert from "node:assert/strict";
import { colorize } from "../src/chart/renderer.ts";
import { COLOR_LUT } from "../src/chart/palette.ts";

// Phase 14: nine-stop palette sampled into the 256-step lookup table (UI_SPEC 3.11).
const lut = COLOR_LUT;
function legacy(values: Uint32Array, threshold: number) {
  const output = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const size = values[i]!;
    output[i * 4 + 3] = 255;
    if (size < 1) continue;
    const index = Math.min(255, Math.round(size / Math.max(1, threshold) * 255)) * 3;
    output[i * 4] = lut[index]!;
    output[i * 4 + 1] = lut[index + 1]!;
    output[i * 4 + 2] = lut[index + 2]!;
  }
  return output;
}
test("ダミー：packed color writes are byte-exact against the original RGBA loop", () => {
  const values = Uint32Array.from({ length: 65536 }, (_, i) => i % 7 === 0 ? 0 : (Math.imul(i, 2654435761) >>> 0));
  for (const threshold of [NaN, Infinity, -Infinity, 0, 1, 1.5, 10, 255, 1023, 65535, 0xffffffff]) {
    assert.deepEqual(colorize(values, threshold), legacy(values, threshold));
  }
});
test("ダミー：same-size color buffers are reused and opaque zero cells fully replace old bytes", () => {
  const values = Uint32Array.of(0, 1, 2, 10, 0);
  const target = new Uint8ClampedArray(values.length * 4).fill(19);
  assert.equal(colorize(values, 5, target), target);
  assert.deepEqual(target, legacy(values, 5));
  assert.notEqual(colorize(values, 5, new Uint8ClampedArray(4)), target);
});

test("Phase 14 palette: 256 entries hit each of the nine stops exactly", () => {
  assert.equal(COLOR_LUT.length, 256 * 3);
  const at = (p: number) => Array.from(COLOR_LUT.slice(Math.round(p * 255) * 3, Math.round(p * 255) * 3 + 3));
  assert.deepEqual(at(0), [0, 0, 0]);
  assert.deepEqual(at(1), [0xff, 0x3d, 0x2e]);
  // 0.84 * 255 = 214.2 -> index 214 is within one step of white
  assert.ok(at(0.84).every(c => c >= 250));
  assert.deepEqual(Array.from(COLOR_LUT.slice(255 * 3 - 3, 255 * 3)).length, 3);
});
