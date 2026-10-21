/** NQ outright prices use exact quarter-point increments. No contract is selected. */
export const NQ = Object.freeze({ root: "NQ", tickSize: 0.25 } as const);

export function ticksToPrice(tickInteger: number): number {
  if (!Number.isSafeInteger(tickInteger)) {
    throw new RangeError("NQ ticks must be a safe integer");
  }
  return tickInteger / 4;
}

/**
 * Quarter points are exactly representable in binary, so no rounding tolerance
 * is needed. Reject off-grid prices and ticks outside the safe integer range.
 */
export function priceToTicks(price: number): number {
  const ticks = price * 4;
  if (!Number.isFinite(price) || !Number.isSafeInteger(ticks)) {
    throw new RangeError("NQ price must be on the 0.25 grid with safe integer ticks");
  }
  return ticks;
}
