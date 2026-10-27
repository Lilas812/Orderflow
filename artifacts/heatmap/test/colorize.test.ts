import { test } from "node:test";
import assert from "node:assert/strict";
import { colorize } from "../src/chart/renderer.ts";

const stops = [
  { at: 0, rgb: [11, 26, 74] }, { at: 0.2, rgb: [59, 42, 143] },
  { at: 0.4, rgb: [138, 60, 255] }, { at: 0.6, rgb: [233, 227, 255] },
  { at: 0.8, rgb: [255, 154, 60] }, { at: 1, rgb: [255, 59, 48] },
];
const lut = new Uint8Array(1024 * 3);
for (let i = 0; i < 1024; i++) {
  const position = i / 1023;
  let stop = 0;
  while (stop < stops.length - 2 && position > stops[stop + 1]!.at) stop++;
  const a = stops[stop]!, b = stops[stop + 1]!;
  const amount = (position - a.at) / (b.at - a.at);
  for (let channel = 0; channel < 3; channel++) {
    lut[i * 3 + channel] = Math.round(a.rgb[channel]! + (b.rgb[channel]! - a.rgb[channel]!) * amount);
  }
}
function legacy(values: Uint32Array, threshold: number) {
  const output = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const size = values[i]!;
    output[i * 4 + 3] = 255;
    if (size < 1) continue;
    const index = Math.min(1023, Math.round(size / Math.max(1, threshold) * 1023)) * 3;
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
