import { describe, expect, it } from "vitest";
import { bubbleDiameter, DEFAULT_BUBBLE_SIZING as defaults, type BubbleSizingMode } from "./bubbleSizing";

describe("R09 DATA_SPEC §8 pure bubble sizing", () => {
  const modes: readonly BubbleSizingMode[] = ["FIXED", "LINEAR", "SQRT", "LOG"];
  it.each(modes)("implements %s at volume 27", mode => {
    const oracle = { FIXED: 16, LINEAR: 12.32, SQRT: 16.313843876330612,
      LOG: 8 + 16 * Math.log(28) / Math.log(101) };
    expect(bubbleDiameter(27, { ...defaults, mode })).toBeCloseTo(oracle[mode], 12);
  });
  it.each(modes.flatMap(mode => [0, 27, 100, 1000].map(volume => ({ mode, volume }))))(
    "$mode V=$volume remains bounded and deterministic", ({ mode, volume }) => {
      const s = { ...defaults, mode }, actual = bubbleDiameter(volume, s);
      expect(actual).toBeGreaterThanOrEqual(8); expect(actual).toBeLessThanOrEqual(24);
      expect(bubbleDiameter(BigInt(volume), s)).toBe(actual);
      expect(bubbleDiameter(volume, s)).toBe(actual);
      if (volume === 0 && mode !== "FIXED") expect(actual).toBe(8);
      if (volume >= 100 && mode !== "FIXED") expect(actual).toBe(24);
    },
  );
  it.each(modes)("clamps huge BigInt without precision loss or overflow in %s", mode => {
    expect(bubbleDiameter(10n ** 400n, { ...defaults, mode })).toBe(mode === "FIXED" ? 16 : 24);
  });
  it.each([4, 16, 40])("clamps FIXED diameter %s", fixedDiameter => {
    expect(bubbleDiameter(27, { ...defaults, mode: "FIXED", fixedDiameter }))
      .toBe(Math.max(8, Math.min(24, fixedDiameter)));
  });
  it("supports an independent size reference without changing any quantity", () => {
    const volume = 27n;
    expect(bubbleDiameter(volume, { ...defaults, minDiameter: 12, maxDiameter: 20, volumeReference: 27 })).toBe(20);
    expect(volume).toBe(27n); expect(bubbleDiameter(volume)).toBeCloseTo(16.313843876330612, 12);
  });
  it.each([-1, -1n, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid volume %s", value => {
    expect(() => bubbleDiameter(value)).toThrow();
  });
  it.each([
    { volumeReference: 0 }, { volumeReference: -1 }, { volumeReference: .5 },
    { minDiameter: 0 }, { minDiameter: 25 }, { maxDiameter: Infinity },
    { fixedDiameter: NaN }, { mode: "OTHER" as BubbleSizingMode },
  ])("rejects invalid sizing $mode $volumeReference $minDiameter $maxDiameter", patch => {
    expect(() => bubbleDiameter(27, { ...defaults, ...patch })).toThrow();
  });
});
