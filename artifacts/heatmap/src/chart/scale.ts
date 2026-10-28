import type { HeatColumn, Viewport } from "../domain.ts";
import type { SettingsValues } from "../data/settings.ts";

export type HeatScaleOptions = Pick<SettingsValues, "heatUpperMode" | "heatUpperSize" | "heatTopPct"
  | "heatLowerMode" | "heatLowerPct" | "heatLowerSize" | "heatGamma">;

export function heatThresholds(columns: readonly HeatColumn[], view: Viewport, options: HeatScaleOptions) {
  const upper = options.heatUpperMode === "size" ? options.heatUpperSize
    : viewportPositiveP99(columns, view, options.heatTopPct);
  const requestedLower = options.heatLowerMode === "off" ? 0 : options.heatLowerMode === "size"
    ? options.heatLowerSize : viewportPositivePercentile(columns, view, options.heatLowerPct / 100);
  return { upper, lower: Math.min(requestedLower, upper - 1), lowerAdjusted: requestedLower >= upper };
}

export function viewportPositiveP99(columns: readonly HeatColumn[], view: Viewport, topPercent = 1): number {
  return viewportPositivePercentile(columns, view, 1 - topPercent / 100);
}

export function viewportPositivePercentile(columns: readonly HeatColumn[], view: Viewport, percentile: number): number {
  const endUs = view.startUs + view.durationSec * 1_000_000;
  const visible = columns.filter(c => c.timeUs + 1_000_000 > view.startUs && c.timeUs < endUs);
  const bottom = view.centerPriceTicks - view.priceSpanTicks / 2;
  const top = view.centerPriceTicks + view.priceSpanTicks / 2;
  // A tick cell has half-open extent price±0.5; touching only the border is not visible area.
  return positiveVisibleP99(visible, Math.floor(bottom - 0.5) + 1, Math.ceil(top + 0.5) - 1, percentile);
}

export const HEAT_STOPS: readonly { at: number; color: string }[] = [
  { at: 0, color: "#0b1a4a" },
  { at: 0.2, color: "#3b2a8f" },
  { at: 0.4, color: "#8a3cff" },
  { at: 0.6, color: "#e9e3ff" },
  { at: 0.8, color: "#ff9a3c" },
  { at: 1, color: "#ff3b30" },
];

export function positiveVisibleSizes(columns: readonly HeatColumn[], minTick: number, maxTick: number): number[] {
  const values: number[] = [];
  for (const column of columns) {
    for (const side of [column.bids, column.asks]) {
      for (let i = 0; i < side.sizes.length; i += 1) {
        const size = side.sizes[i]!;
        const price = side.prices[i]!;
        if (size >= 1 && price >= minTick && price <= maxTick) values.push(size);
      }
    }
  }
  return values;
}

/** Nearest-rank percentile; zeros, missing cells, and out-of-view values are excluded. */
export function positiveNearestRank(values: readonly number[], percentile = 0.99): number {
  const bins = new Uint32Array(65_536);
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 1 || value > 0xffff_ffff) continue;
    bins[Math.floor(value / 65_536)] += 1;
    count += 1;
  }
  if (count === 0) return 1;
  let remaining = Math.min(count, Math.max(1, Math.ceil(percentile * count)));
  let high = 0;
  for (; high < bins.length; high += 1) {
    if (remaining <= bins[high]!) break;
    remaining -= bins[high]!;
  }
  const lows = new Uint32Array(65_536);
  for (const value of values) {
    if (value >= 1 && value <= 0xffff_ffff && Math.floor(value / 65_536) === high) lows[value & 0xffff] += 1;
  }
  for (let low = 0; low < lows.length; low += 1) {
    if (remaining <= lows[low]!) return high * 65_536 + low;
    remaining -= lows[low]!;
  }
  return 1;
}

export function positiveVisibleP99(columns: readonly HeatColumn[], minTick: number, maxTick: number, percentile = .99): number {
  const highBins = new Uint32Array(65_536);
  let count = 0;
  for (const column of columns) {
    for (const levels of [column.bids, column.asks]) {
      for (let i = 0; i < levels.sizes.length; i += 1) {
        const size = levels.sizes[i]!;
        const price = levels.prices[i]!;
        if (size >= 1 && price >= minTick && price <= maxTick) {
          highBins[size >>> 16] += 1;
          count += 1;
        }
      }
    }
  }
  if (count === 0) return 1;
  let rank = Math.max(1, Math.ceil(count * percentile));
  let high = 0;
  for (; high < highBins.length; high += 1) {
    if (rank <= highBins[high]!) break;
    rank -= highBins[high]!;
  }
  const lowBins = new Uint32Array(65_536);
  for (const column of columns) {
    for (const levels of [column.bids, column.asks]) {
      for (let i = 0; i < levels.sizes.length; i += 1) {
        const size = levels.sizes[i]!;
        const price = levels.prices[i]!;
        if (size >= 1 && price >= minTick && price <= maxTick && (size >>> 16) === high) lowBins[size & 0xffff] += 1;
      }
    }
  }
  for (let low = 0; low < lowBins.length; low += 1) {
    if (rank <= lowBins[low]!) return high * 65_536 + low;
    rank -= lowBins[low]!;
  }
  return 1;
}

function hexRgb(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

export function heatColor(size: number, ceiling: number): [number, number, number] {
  if (size < 1 || !Number.isFinite(size)) return [0, 0, 0];
  const position = Math.max(0, Math.min(1, size / Math.max(1, ceiling)));
  let lower = HEAT_STOPS[0]!;
  let upper = HEAT_STOPS.at(-1)!;
  for (let i = 1; i < HEAT_STOPS.length; i += 1) {
    if (position <= HEAT_STOPS[i]!.at) {
      lower = HEAT_STOPS[i - 1]!;
      upper = HEAT_STOPS[i]!;
      break;
    }
  }
  const amount = (position - lower.at) / (upper.at - lower.at);
  const a = hexRgb(lower.color);
  const b = hexRgb(upper.color);
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}
