export type TimeUs = number;
export type PriceTicks = number;
export type Source = "live" | "history";

export interface LevelArrays {
  prices: Int32Array;
  sizes: Uint32Array;
}

export interface HeatColumn {
  timeUs: TimeUs;
  source: Source;
  bids: LevelArrays;
  asks: LevelArrays;
}

export interface Trade {
  tsUs: TimeUs;
  recvUs: TimeUs;
  seq: number;
  price: PriceTicks;
  size: number;
  side: "buy" | "sell" | "unknown";
  /** Optional contract delivered with the trade (footprint separates series by it). */
  contract?: string;
}

export interface Viewport {
  startUs: TimeUs;
  durationSec: number;
  centerPriceTicks: number;
  priceSpanTicks: number;
}

export const US_PER_SECOND = 1_000_000;
export const MAX_CACHE_SECONDS = 7_200;
export const MIN_TIME_SPAN_SEC = 10;
export const MAX_TIME_SPAN_SEC = 7_200;
export const MIN_PRICE_SPAN_TICKS = 8;
export const MAX_PRICE_SPAN_TICKS = 8_000;

export function bestMidpoint(column: HeatColumn | undefined): number | null {
  if (!column || column.bids.prices.length === 0 || column.asks.prices.length === 0) return null;
  return (column.bids.prices[0]! + column.asks.prices[0]!) / 2;
}

export function clampViewport(view: Viewport): Viewport {
  const durationSec = Math.min(MAX_TIME_SPAN_SEC, Math.max(MIN_TIME_SPAN_SEC, view.durationSec));
  const priceSpanTicks = Math.min(MAX_PRICE_SPAN_TICKS, Math.max(MIN_PRICE_SPAN_TICKS, view.priceSpanTicks));
  return { ...view, startUs: Math.round(view.startUs), durationSec: Math.round(durationSec * US_PER_SECOND) / US_PER_SECOND, priceSpanTicks };
}
