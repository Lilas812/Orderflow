import type { HeatColumn, Viewport } from "../domain.ts";
import { priceTicksToY } from "./coordinates.ts";
import { colorPosition } from "./palette.ts";

/** SPEC 7.2 (Phase 14): numeric current book. All lengths are CSS px. */
export const BOOK_GROUP_WIDTHS = [1, 2, 4, 8, 20, 40, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 102400] as const;
export const BOOK_ROW_MIN_CSS = 11;
export const BOOK_NUMBER_RIGHT_INSET = 4;
export const BOOK_NUMBER_EDGE_MARGIN = 6;
export const BOOK_BAND_GAP = 5;
export const BOOK_NUMBER_FONT_PX = 10;
export const BOOK_NUMBER_COLORS = { hot: "#ff8a6a", bright: "#ffffff", normal: "#9c97b5" } as const;

/** Smallest width with non-overlapping numbers, including very short 8000-tick plots. */
export function bookGroupTicks(cssPerTick: number): number {
  return BOOK_GROUP_WIDTHS.find(g => g * cssPerTick >= BOOK_ROW_MIN_CSS) ?? 102400;
}

export function bookNumberStyle(position: number): { color: string; bold: boolean } {
  if (position >= 0.9) return { color: BOOK_NUMBER_COLORS.hot, bold: true };
  if (position >= 0.72) return { color: BOOK_NUMBER_COLORS.bright, bold: true };
  return { color: BOOK_NUMBER_COLORS.normal, bold: false };
}

export interface BookNumberRow { groupStart: number; ticks: number; total: number; maxSize: number; y: number;
  position: number; color: string; bold: boolean; }

/**
 * Grouped totals of bids+asks. Group key = floor(price / g) * g. Rows with total 0 or whose centre is
 * within 6 CSS px of the top/bottom edge are omitted. Colour by the largest single level's t'.
 */
export function bookNumberRows(book: HeatColumn | null, view: Viewport, cssHeight: number,
  scale: { upper: number; lower: number; gamma: number }): BookNumberRow[] {
  if (!book || cssHeight <= 0) return [];
  const g = bookGroupTicks(cssHeight / view.priceSpanTicks);
  const groups = new Map<number, { total: number; max: number }>();
  for (const side of [book.bids, book.asks]) {
    for (let i = 0; i < side.prices.length; i++) {
      const size = side.sizes[i]!;
      if (!(size > 0)) continue;
      const key = Math.floor(side.prices[i]! / g) * g;
      const entry = groups.get(key);
      if (entry) { entry.total += size; entry.max = Math.max(entry.max, size); }
      else groups.set(key, { total: size, max: size });
    }
  }
  const rows: BookNumberRow[] = [];
  for (const [groupStart, { total, max }] of groups) {
    if (total <= 0) continue;
    const y = priceTicksToY(groupStart + (g - 1) / 2, view, cssHeight);
    if (y < BOOK_NUMBER_EDGE_MARGIN || y > cssHeight - BOOK_NUMBER_EDGE_MARGIN) continue;
    const position = colorPosition(max, scale.upper, scale.lower, scale.gamma);
    rows.push({ groupStart, ticks: g, total, maxSize: max, y, position, ...bookNumberStyle(position) });
  }
  return rows.sort((a, b) => a.y - b.y);
}

export function bookNumberFont(bold: boolean): string {
  return `${bold ? "700 " : ""}${BOOK_NUMBER_FONT_PX}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
}

/**
 * Band end x (CSS px): 5 px before the leftmost edge of the widest drawn number. Without drawn
 * numbers the band runs to the heatmap's right edge.
 */
export function bookBandEnd(cssWidth: number, widestText: number): number {
  if (!(widestText > 0)) return cssWidth;
  return Math.max(0, cssWidth - BOOK_NUMBER_RIGHT_INSET - widestText - BOOK_BAND_GAP);
}
