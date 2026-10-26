import type { HeatColumn } from "../domain.ts";

export function resolveColumnForDrawing(
  second: number,
  bySecond: ReadonlyMap<number, HeatColumn>,
  sortedSeconds: readonly number[],
): HeatColumn | null {
  const exact = bySecond.get(second);
  if (exact) return exact;
  let low = 0;
  let high = sortedSeconds.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sortedSeconds[middle]! < second) low = middle + 1;
    else high = middle;
  }
  const previous = sortedSeconds[low - 1];
  const next = sortedSeconds[low];
  if (previous === undefined || next === undefined) return null;
  const missingCount = next - previous - 1;
  if (missingCount < 1 || missingCount > 2 || second <= previous || second >= next) return null;
  return bySecond.get(previous) ?? null;
}
