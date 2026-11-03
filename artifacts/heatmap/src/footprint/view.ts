import { DISPLAY_TIMEFRAMES, TIMEFRAMES, type Timeframe, type DisplayTimeframe } from "./model.ts";

export interface FpView { endSec: number; barW: number; rowH: number; centerPrice: number; follow: boolean; displayTf?: DisplayTimeframe; }
export const BAR_W_MIN = 5, BAR_W_MAX = 240, BAR_W_DEFAULT = 92;
export const ROW_H_MIN = 2, ROW_H_MAX = 30, ROW_H_DEFAULT = 16;
/** Left OHLC lane inside a bar and the gap between bars, px. */
export const OHLC_LANE = 6, BAR_GAP = 3;
/** Numbers are only drawn when each half-cell is at least this wide/tall; never overlapped. */
export const MIN_CELL_W = 28, MIN_ROW_H = 12;
export const DETAIL_BAR_W = OHLC_LANE + BAR_GAP + 2 * MIN_CELL_W;
export const MAX_PRICE_TICKS = 8_000;
export const PRICE_GROUPS = [1, 2, 4, 5, 10, 20, 40, 50, 100, 200] as const;
/** Approved extension for short screens: keep the original steps, then double from 200. */
export function priceGroupTicks(rowH: number): number {
  const fixed = PRICE_GROUPS.find(g => g * rowH >= MIN_ROW_H - 1e-9);
  if (fixed) return fixed;
  let g = 400;
  while (g * rowH < MIN_ROW_H - 1e-9) g *= 2;
  return g;
}
export function adaptTime(v: FpView, selected: Timeframe): FpView {
  const prior = v.displayTf ?? selected;
  const density = Math.max(DETAIL_BAR_W / 900, Math.min(BAR_W_MAX / selected, v.barW / prior));
  const displayTf = DISPLAY_TIMEFRAMES.find(t => t >= selected && density * t >= DETAIL_BAR_W - 1e-9) ?? 900;
  return { ...v, displayTf, barW: density * displayTf };
}
export const AXIS_W = 66, TIME_H = 22, STATS_H = 34, STATUS_H = 5;

export const cellWidth = (barW: number) => (barW - OHLC_LANE - BAR_GAP) / 2;
export const detailMode = (v: Pick<FpView, "barW" | "rowH">) => cellWidth(v.barW) >= MIN_CELL_W && v.rowH >= MIN_ROW_H;
export const followEnd = (nowSec: number, tf: number) => Math.floor(nowSec / tf) * tf + tf * 2;

export function barLeft(startSec: number, v: FpView, tf: number, plotW: number): number {
  return plotW - ((v.endSec - startSec) / tf) * v.barW;
}
export function xToSec(x: number, v: FpView, tf: number, plotW: number): number {
  return v.endSec - ((plotW - x) / v.barW) * tf;
}
export function priceToY(price: number, v: FpView, plotH: number): number {
  return plotH / 2 - (price - v.centerPrice) * v.rowH;
}
export function yToPrice(y: number, v: FpView, plotH: number): number {
  return Math.round(v.centerPrice + (plotH / 2 - y) / v.rowH);
}
export function visibleSpan(v: FpView, tf: number, plotW: number): [number, number] {
  const n = Math.ceil(plotW / v.barW) + 1;
  return [Math.floor(v.endSec / tf) * tf - n * tf, v.endSec];
}
export function clampView(v: FpView, tf: number, nowSec: number | null, plotH = 480): FpView {
  const barW = Math.min(BAR_W_MAX, Math.max(DETAIL_BAR_W, v.barW));
  const rowH = Math.min(ROW_H_MAX, Math.max(plotH / MAX_PRICE_TICKS, v.rowH));
  let endSec = v.endSec;
  if (nowSec !== null) {
    const max = followEnd(nowSec, tf) + tf * 20, min = nowSec - 7_200 + tf * 4;
    endSec = Math.min(max, Math.max(min, endSec));
  }
  return { ...v, barW, rowH, endSec: Math.round(endSec * 1000) / 1000, centerPrice: Number.isFinite(v.centerPrice) ? v.centerPrice : 0 };
}
export function zoomTimeAt(v: FpView, factor: number, x: number, selected: Timeframe, plotW: number): FpView {
  const anchor = xToSec(x, v, v.displayTf ?? selected, plotW);
  const next = adaptTime({ ...v, barW: v.barW * factor }, selected);
  return { ...next, follow: false, endSec: anchor + ((plotW - x) / next.barW) * next.displayTf! };
}
export function zoomPriceAt(v: FpView, factor: number, y: number, plotH: number): FpView {
  const anchor = v.centerPrice + (plotH / 2 - y) / v.rowH;
  const rowH = Math.min(ROW_H_MAX, Math.max(plotH / MAX_PRICE_TICKS, v.rowH * factor));
  return { ...v, rowH, centerPrice: anchor - (plotH / 2 - y) / rowH };
}
export function parseTimeframe(v: unknown): Timeframe {
  const n = Number(v);
  return (TIMEFRAMES as readonly number[]).includes(n) ? n as Timeframe : 5;
}
export function compactQty(n: number): string {
  const a = Math.abs(n);
  if (a < 10_000) return String(n);
  if (a < 1_000_000) return (n / 1000).toFixed(a < 100_000 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(1) + "M";
}
