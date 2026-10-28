import type { Bar } from "./model.ts";
import { dayStartSec, latestTradingDate, shiftTradingDays } from "./time.ts";

export interface LvView { startSec: number; endSec: number; priceHigh: number; priceLow: number; }
export const MIN_SPAN_SEC = 1800;
export const MAX_SPAN_SEC = 90 * 86400;
export const INITIAL_TRADING_DAYS = 10;

/** `?view=longvp` selects the long-term screen; anything else is the heatmap. */
export const isLongVpRoute = (search: string) => new URLSearchParams(search).get("view") === "longvp";
export function viewLink(view: "heatmap" | "longvp", base = baseUrl()): string {
  return view === "longvp" ? `${base}?view=longvp` : base;
}
function baseUrl() {
  try { return import.meta.env.BASE_URL ?? "/"; } catch { return "/"; }
}

/** Last 10 trading days, with room on the right for the POC extension (10% of a day). */
export function initialView(nowSec: number): LvView {
  const last = latestTradingDate(nowSec);
  const start = dayStartSec(shiftTradingDays(last, -(INITIAL_TRADING_DAYS - 1)));
  const end = Math.max(nowSec, start + 3600) + 0.1 * 86400 + 3600;
  return { startSec: start, endSec: end, priceHigh: 100, priceLow: 0 };
}
export function clampView(v: LvView, nowSec: number): LvView {
  let span = Math.min(MAX_SPAN_SEC, Math.max(MIN_SPAN_SEC, v.endSec - v.startSec));
  if (!Number.isFinite(span)) span = 86400;
  let end = v.startSec + span;
  const maxEnd = nowSec + 3 * 86400;
  if (end > maxEnd) end = maxEnd;
  let hi = v.priceHigh, lo = v.priceLow;
  if (!(hi - lo >= 8)) { const m = (hi + lo) / 2 || 0; hi = m + 4; lo = m - 4; }
  if (hi - lo > 400_000) { const m = (hi + lo) / 2; hi = m + 200_000; lo = m - 200_000; }
  return { startSec: end - span, endSec: end, priceHigh: hi, priceLow: lo };
}
/** Fits price range to the visible bars with 8% padding; null when nothing visible. */
export function fitPrice(bars: Bar[], fromSec: number, toSec: number, _heightPx: number) {
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) {
    if (b.t + 60 < fromSec || b.t > toSec) continue;
    lo = Math.min(lo, b.l); hi = Math.max(hi, b.h);
  }
  if (!Number.isFinite(lo)) return null;
  const pad = Math.max(4, (hi - lo) * .08);
  return { priceHigh: hi + pad, priceLow: lo - pad };
}
