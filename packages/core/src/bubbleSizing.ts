/** Display-only fixed-reference sizing. Never rounds or mutates executed volume. */
export type BubbleSizingMode = "FIXED" | "LINEAR" | "SQRT" | "LOG";
export interface BubbleSizing {
  readonly mode: BubbleSizingMode;
  readonly minDiameter: number;
  readonly maxDiameter: number;
  readonly volumeReference: number;
  readonly fixedDiameter: number;
}
export const DEFAULT_BUBBLE_SIZING: Readonly<BubbleSizing> = Object.freeze({
  mode: "SQRT", minDiameter: 8, maxDiameter: 24, volumeReference: 100, fixedDiameter: 16,
});
export function bubbleDiameter(volume: number | bigint, settings: BubbleSizing = DEFAULT_BUBBLE_SIZING): number {
  if (typeof volume === "bigint" ? volume < 0n : !Number.isSafeInteger(volume) || volume < 0) {
    throw new RangeError("Expected nonnegative integer executed volume");
  }
  const { mode, minDiameter: lo, maxDiameter: hi, volumeReference: ref, fixedDiameter } = settings;
  if (!["FIXED", "LINEAR", "SQRT", "LOG"].includes(mode)
    || ![lo, hi, ref, fixedDiameter].every(Number.isFinite)
    || lo <= 0 || hi < lo || !Number.isSafeInteger(ref) || ref < 1 || fixedDiameter <= 0) {
    throw new RangeError("Invalid bubble sizing settings");
  }
  if (mode === "FIXED") return Math.max(lo, Math.min(hi, fixedDiameter));
  // Saturate before Number conversion, even for arbitrary-size BigInt totals.
  const v = typeof volume === "bigint" && volume >= BigInt(ref) ? ref : Number(volume);
  const z = Math.max(0, Math.min(1, v / ref));
  const fraction = mode === "LINEAR" ? z : mode === "SQRT" ? Math.sqrt(z)
    : Math.log1p(Math.min(v, ref)) / Math.log1p(ref);
  return Math.max(lo, Math.min(hi, lo + (hi - lo) * fraction));
}
