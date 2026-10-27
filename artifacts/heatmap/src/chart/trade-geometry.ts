import type { Viewport } from "../domain.ts";
import { US_PER_SECOND } from "../domain.ts";
import type { TradeAggregator } from "../data/trade-aggregate.ts";
import { priceTicksToY, timeUsToX } from "./coordinates.ts";

export const BUBBLE_COLORS = {
  buy: { fill: "#3ddc84", edge: "#2a9a5c" },
  sell: { fill: "#a64dff", edge: "#7436b3" },
  tie: { fill: "#d9d9d9", edge: "#989898" },
} as const;
export function parseBubbleMin(search: string): { value: number; invalid: boolean } {
  const raw = new URLSearchParams(search).get("bubbleMin");
  if (raw === null) return { value: 10, invalid: false };
  const number = Number(raw);
  return Number.isInteger(number) && number >= 1 ? { value: number, invalid: false } : { value: 10, invalid: true };
}
export function bubbleRadius(total: number, minimum: number): number {
  return Math.min(14, 3 * Math.sqrt(total / minimum));
}
export interface Bubble {
  x: number; y: number; price: number; buy: number; sell: number;
  radius: number; side: keyof typeof BUBBLE_COLORS;
}
export interface PriceBin { x: number; first: number; last: number; min: number; max: number; }
export function tradeGeometry(
  aggregation: TradeAggregator, view: Viewport, cssWidth: number, cssHeight: number,
  dpr: number, minimum: number, cutoffUs = Infinity,
): { bubbles: Bubble[]; priceBins: PriceBin[]; downsampled: boolean } {
  const physicalWidth = Math.max(1, Math.round(cssWidth * dpr));
  const downsampled = physicalWidth < view.durationSec;
  const from = Math.floor(view.startUs / US_PER_SECOND) * US_PER_SECOND;
  const to = view.startUs + view.durationSec * US_PER_SECOND;
  const merged = new Map<string, Bubble>();
  for (const cell of aggregation.cells(from, to, cutoffUs)) {
    const total = cell.buy + cell.sell;
    // Crucially, filter individual seconds BEFORE physical-pixel merging.
    if (total < minimum) continue;
    const centerX = timeUsToX(cell.secondUs + US_PER_SECOND / 2, view, cssWidth);
    const physicalX = Math.floor(centerX * physicalWidth / cssWidth);
    if (physicalX < 0 || physicalX >= physicalWidth) continue;
    const y = priceTicksToY(cell.price, view, cssHeight);
    if (y < -14 || y > cssHeight + 14) continue;
    const key = `${downsampled ? physicalX : cell.secondUs}:${cell.price}`;
    const existing = merged.get(key);
    if (existing) { existing.buy += cell.buy; existing.sell += cell.sell; }
    else merged.set(key, {
      x: downsampled ? (physicalX + 0.5) * cssWidth / physicalWidth : centerX,
      y, price: cell.price, buy: cell.buy, sell: cell.sell, radius: 0, side: "tie",
    });
  }
  const bubbles = [...merged.values()];
  for (const b of bubbles) {
    b.side = b.buy > b.sell ? "buy" : b.sell > b.buy ? "sell" : "tie";
    b.radius = bubbleRadius(b.buy + b.sell, minimum);
  }
  const bins = new Map<number, PriceBin>();
  for (const point of aggregation.lastPrices(from - US_PER_SECOND, to, cutoffUs)) {
    const x = timeUsToX(Math.min(point.secondUs + US_PER_SECOND / 2, cutoffUs), view, cssWidth);
    const physicalX = Math.floor(x * physicalWidth / cssWidth);
    const key = downsampled ? physicalX : point.secondUs;
    // Keep one neighbour outside the viewport so the carried line reaches its edges.
    const existing = bins.get(key);
    if (existing) {
      existing.last = point.price; existing.min = Math.min(existing.min, point.price);
      existing.max = Math.max(existing.max, point.price);
    } else bins.set(key, {
      x: downsampled ? (physicalX + 0.5) * cssWidth / physicalWidth : x,
      first: point.price, last: point.price, min: point.price, max: point.price,
    });
  }
  const priceBins = [...bins.values()];
  // Only extend already-known prices; never invent a leading price.
  const last = priceBins.at(-1);
  const lineEndX = timeUsToX(Math.min(to, cutoffUs), view, cssWidth);
  if (last && last.x < lineEndX) priceBins.push({ ...last, x: lineEndX, min: last.last, max: last.last });
  return { bubbles, priceBins, downsampled };
}
