import { US_PER_SECOND, type Viewport } from "../domain.ts";
import type { TradeAggregator } from "../data/trade-aggregate.ts";
import { resetViewport } from "./view-reset.ts";

/** Time-only reset: price state is deliberately preserved, including AUTO fits. */
export function resetTimeViewport(view: Viewport, anchorUs: number, width: number, mode: "live" | "replay"): Viewport {
  const reset = resetViewport(anchorUs, view.centerPriceTicks, width, mode);
  return { ...view, startUs: reset.startUs, durationSec: reset.durationSec };
}

export function fitPriceViewport(view: Viewport, trades: TradeAggregator, currentPrice: number): Viewport {
  const extent = trades.priceExtent(view.startUs, view.startUs + view.durationSec * US_PER_SECOND);
  return { ...view,
    centerPriceTicks: extent ? (extent.min + extent.max) / 2 : currentPrice,
    // Do not apply the manual zoom ceiling: all visible trades must fit.
    priceSpanTicks: extent ? Math.max(20, (extent.max - extent.min) / 0.8) : 160 };
}

/** Coalesces incoming trades and viewport changes, without a perpetual polling loop. */
export class AutoPriceScale {
  enabled = false;
  private dirty = false;
  private lastFit = -Infinity;
  enable(): void { this.enabled = true; this.dirty = true; }
  disable(): void { this.enabled = false; this.dirty = false; }
  invalidate(): void { if (this.enabled) this.dirty = true; }
  delay(now: number): number | null {
    return this.enabled && this.dirty ? Math.max(0, this.lastFit + 1_000 - now) : null;
  }
  fit(now: number, view: Viewport, trades: TradeAggregator, currentPrice: number): Viewport | null {
    if (this.delay(now) !== 0) return null;
    this.dirty = false;
    this.lastFit = now;
    return fitPriceViewport(view, trades, currentPrice);
  }
}
