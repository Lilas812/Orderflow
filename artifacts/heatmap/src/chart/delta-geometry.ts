import { US_PER_SECOND, type Viewport } from "../domain.ts";
import type { TradeAggregator } from "../data/trade-aggregate.ts";
import { timeUsToX } from "./coordinates.ts";

export const DELTA_SECONDS = [1, 5, 15, 60, 300] as const;
export type DeltaSeconds = typeof DELTA_SECONDS[number];

export function deltaSeconds(durationSec: number, cssWidth: number): DeltaSeconds {
  return DELTA_SECONDS.find(seconds => seconds * cssWidth / durationSec >= 3) ?? 300;
}

/** Exchange-aligned half-open bins, including bins intersecting the view edges. */
export function deltaBounds(view: Viewport, seconds: DeltaSeconds) {
  const intervalUs = seconds * US_PER_SECOND;
  return {
    fromUs: Math.floor(view.startUs / intervalUs) * intervalUs,
    toUs: Math.ceil((view.startUs + view.durationSec * US_PER_SECOND) / intervalUs) * intervalUs,
  };
}

export interface DeltaBar {
  startUs: number; buy: number; sell: number; delta: number;
  x: number; width: number; y: number; height: number;
}

export function deltaGeometry(aggregation: TradeAggregator, view: Viewport,
  cssWidth: number, cssHeight: number, cutoffUs: number, streamFromUs: number) {
  const seconds = deltaSeconds(view.durationSec, cssWidth);
  const intervalUs = seconds * US_PER_SECOND, bounds = deltaBounds(view, seconds);
  const totals = new Map<number, { buy: number; sell: number }>();
  // Use the common Phase 4 cells, not raw trades or the bubble threshold/price window.
  for (const cell of aggregation.cells(bounds.fromUs, bounds.toUs, cutoffUs)) {
    const startUs = Math.floor(cell.secondUs / intervalUs) * intervalUs;
    const total = totals.get(startUs) ?? { buy: 0, sell: 0 };
    total.buy += cell.buy; total.sell += cell.sell; totals.set(startUs, total);
  }
  const bars: DeltaBar[] = [];
  let maximum = 0, omittedCount = 0;
  for (let startUs = bounds.fromUs; startUs < bounds.toUs; startUs += intervalUs) {
    if (startUs > cutoffUs) break;
    // A forming latest interval needs coverage only through the received head.
    const toUs = Math.min(startUs + intervalUs, cutoffUs + 1);
    if (!aggregation.coversRange(startUs, toUs, { fromUs: streamFromUs, toUs: cutoffUs + 1 })) {
      omittedCount++; continue;
    }
    const total = totals.get(startUs);
    if (!total) continue; // No trades: no synthetic zero bar.
    const delta = total.buy - total.sell;
    maximum = Math.max(maximum, Math.abs(delta));
    bars.push({ startUs, ...total, delta, x: timeUsToX(startUs, view, cssWidth),
      width: seconds * cssWidth / view.durationSec, y: cssHeight / 2, height: 0 });
  }
  for (const bar of bars) {
    bar.height = maximum ? Math.abs(bar.delta) / maximum * cssHeight / 2 : 0;
    if (bar.delta > 0) bar.y -= bar.height;
  }
  return { seconds, bars, maximum, omittedCount, zeroY: cssHeight / 2 };
}
