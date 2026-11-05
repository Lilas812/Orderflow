import type { HeatColumn, Viewport } from "../domain.ts";
import { priceTicksToY } from "./coordinates.ts";

/**
 * SPEC 7.2 (2026-11-05 user decision): the current book is also drawn as filled "mountains" that grow leftwards
 * from just left of the numbers. One vertex per price at its tick centre, asks purple / bids light grey, the
 * largest visible level reaches the full length. All lengths are CSS px.
 */
export const MOUNTAIN_MAX_WIDTH_PCT = 10;
export const MOUNTAIN_FILL_OPACITY = 0.5;
export const MOUNTAIN_EDGE_WIDTH = 1;
export const MOUNTAIN_COLORS = { ask: "#8a3cff", bid: "#d9d9d9" } as const;

export interface MountainPoint { y: number; size: number }
export interface BookMountains { asks: MountainPoint[]; bids: MountainPoint[]; maxSize: number }

/**
 * Vertices of each side, top (high price) first. Inside a side's received levels a missing price is 0 (no order);
 * one zero vertex is added just beyond each end so every peak closes back to the base. Only prices within the view
 * (plus one tick beyond each edge) are listed. When one tick is shorter than 1 CSS px, prices sharing a CSS pixel row
 * are merged by their maximum. maxSize is the largest size among visible prices of both sides.
 */
export function bookMountains(book: HeatColumn | null, view: Viewport, cssHeight: number): BookMountains {
  if (!book || !(cssHeight > 0)) return { asks: [], bids: [], maxSize: 0 };
  const top = view.centerPriceTicks + view.priceSpanTicks / 2, bottom = top - view.priceSpanTicks;
  // Same visible-tick rule as the colour scale: a tick only touching an edge is not visible.
  const lowVisible = Math.floor(bottom - 0.5) + 1, highVisible = Math.ceil(top + 0.5) - 1;
  const merge = cssHeight / view.priceSpanTicks < 1;
  let maxSize = 0;
  const side = (levels: HeatColumn["bids"]): MountainPoint[] => {
    const sizes = new Map<number, number>();
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < levels.prices.length; i++) {
      const price = levels.prices[i]!, size = levels.sizes[i]!;
      lo = Math.min(lo, price); hi = Math.max(hi, price);
      sizes.set(price, Math.max(sizes.get(price) ?? 0, size));
      if (price >= lowVisible && price <= highVisible) maxSize = Math.max(maxSize, size);
    }
    const points: MountainPoint[] = [];
    if (lo > hi) return points;
    const from = Math.max(lo - 1, lowVisible - 1), to = Math.min(hi + 1, highVisible + 1);
    for (let price = to; price >= from; price--) {
      const size = sizes.get(price) ?? 0, y = priceTicksToY(price, view, cssHeight);
      if (!merge) { points.push({ y, size }); continue; }
      const row = Math.floor(y) + 0.5, last = points.at(-1);
      if (last && last.y === row) last.size = Math.max(last.size, size);
      else points.push({ y: row, size });
    }
    return points;
  };
  const asks = side(book.asks), bids = side(book.bids);
  return { asks, bids, maxSize };
}

/** Length (CSS px) of a vertex: proportional to the largest visible level, capped at maxLength. */
export function mountainLength(size: number, maxSize: number, maxLength: number): number {
  return maxSize > 0 ? Math.min(1, size / maxSize) * maxLength : 0;
}

/**
 * Draws both sides into a context already in CSS coordinates: semi-transparent fill between the base line x = baseX
 * and the vertices, then an opaque edge along the vertices only. Returns the number of vertices drawn.
 */
export function drawBookMountains(ctx: CanvasRenderingContext2D, mountains: BookMountains, baseX: number,
  maxLength: number): number {
  if (!(mountains.maxSize > 0) || !(maxLength > 0)) return 0;
  let drawn = 0;
  for (const [points, color] of [[mountains.asks, MOUNTAIN_COLORS.ask], [mountains.bids, MOUNTAIN_COLORS.bid]] as const) {
    if (points.length === 0) continue;
    const x = (p: MountainPoint) => baseX - mountainLength(p.size, mountains.maxSize, maxLength);
    ctx.beginPath();
    ctx.moveTo(baseX, points[0]!.y);
    for (const p of points) ctx.lineTo(x(p), p.y);
    ctx.lineTo(baseX, points.at(-1)!.y);
    ctx.closePath();
    ctx.globalAlpha = MOUNTAIN_FILL_OPACITY; ctx.fillStyle = color; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(x(points[0]!), points[0]!.y);
    for (const p of points) ctx.lineTo(x(p), p.y);
    ctx.strokeStyle = color; ctx.lineWidth = MOUNTAIN_EDGE_WIDTH; ctx.lineJoin = "round"; ctx.stroke();
    drawn += points.length;
  }
  return drawn;
}
