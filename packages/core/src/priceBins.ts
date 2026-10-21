import type { BookSide } from "./events";
import { readMbpLevel, type MbpBook } from "./mbpBook";
import { ticksToPrice } from "./instrument";

export type PriceBinWidth = 1 | 2 | 4 | 8;
export type PriceBinObservation =
  | { readonly status: "KNOWN"; readonly qty: bigint }
  | { readonly status: "NOT_INITIALIZED" | "UNKNOWN" | "OUTSIDE_DEPTH"; readonly qty: null };

export function priceBinId(priceTicks: number, width: PriceBinWidth): number {
  ticksToPrice(priceTicks);
  if (![1, 2, 4, 8].includes(width)) throw new RangeError("Price width must be 1/2/4/8 Tick");
  return Math.floor(priceTicks / width);
}

export function priceBinTicks(priceTicks: number, width: PriceBinWidth): readonly number[] {
  const first = BigInt(priceBinId(priceTicks, width)) * BigInt(width);
  const last = first + BigInt(width) - 1n;
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (first < -limit || last > limit) throw new RangeError("Bucket boundaries exceed safe Tick integers");
  return Array.from({ length: width }, (_, index) => Number(first + BigInt(index)));
}

/** Every component must be known; never sum only the observed part of a price cell. */
export function readPriceBin(
  book: MbpBook, side: BookSide, priceTicks: number, width: PriceBinWidth,
): PriceBinObservation {
  const levels = priceBinTicks(priceTicks, width).map((tick) => readMbpLevel(book, side, tick));
  for (const status of ["NOT_INITIALIZED", "OUTSIDE_DEPTH", "UNKNOWN"] as const) {
    if (levels.some((level) => level.status === status)) return { status, qty: null };
  }
  let qty = 0n;
  for (const level of levels) {
    if (level.status === "KNOWN") qty += BigInt(level.qty);
  }
  return { status: "KNOWN", qty };
}
