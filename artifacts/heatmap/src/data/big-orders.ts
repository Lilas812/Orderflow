import type { HeatColumn } from "../domain.ts";
import { US_PER_SECOND } from "../domain.ts";

export interface BigOrder {
  price: number;
  size: number;
  startedUs: number;
  durationSec: number;
  outsideSinceUs: number | null;
}

export interface BigOrderSnapshot {
  timeUs: number | null;
  threshold: number | null;
  orders: BigOrder[];
}

/** URL values are independent of rendering and are shared by live and replay. */
export function parseBigOrderOptions(search: string) {
  const params = new URLSearchParams(search);
  const parse = (name: string, fallback: number, valid: (value: number) => boolean) => {
    const raw = params.get(name);
    if (raw === null) return { value: fallback, invalid: false };
    const value = Number(raw);
    const invalid = raw.trim() === "" || !Number.isFinite(value) || !valid(value);
    return { value: invalid ? fallback : value, invalid };
  };
  return {
    top: parse("bigTop", 2, value => value > 0 && value <= 100),
    minSec: parse("bigMinSec", 5, value => Number.isInteger(value) && value >= 0),
  };
}

/** Nearest rank over both complete sides, never over only the visible prices. */
export function bigOrderThreshold(column: HeatColumn, topPercent = 2): number | null {
  const sizes = [...column.bids.sizes, ...column.asks.sizes].filter(size => size >= 1);
  if (!sizes.length) return null;
  sizes.sort((a, b) => a - b);
  return sizes[Math.max(0, Math.ceil(sizes.length * (1 - topPercent / 100)) - 1)]!;
}

type TrackedOrder = Omit<BigOrder, "durationSec">;

/** Only confirmed one-second columns advance this state; no wall clock is used.
 * The state is not owned by the viewport's two-hour cache.
 */
export class BigOrderTracker {
  private readonly topPercent: number;
  private readonly tracked = new Map<number, TrackedOrder>();
  private last: HeatColumn | null = null;
  private threshold: number | null = null;
  metrics = { decisionMs: 0, meanMs: 0, maxMs: 0, processedColumns: 0, rebuildCount: 0 };
  private samples: number[] = [];

  constructor(topPercent = 2) {
    this.topPercent = topPercent;
  }

  append(column: HeatColumn): void {
    if (this.last && column.timeUs <= this.last.timeUs) return;
    const start = performance.now();
    if (this.last) {
      const missing = (column.timeUs - this.last.timeUs) / US_PER_SECOND - 1;
      if (missing >= 3) this.tracked.clear();
      else {
        // Only the tracking state carries short gaps; stored columns stay missing.
        for (let i = 1; i <= missing; i++) {
          this.process(this.last, this.last.timeUs + i * US_PER_SECOND, this.threshold);
        }
      }
    }
    this.threshold = bigOrderThreshold(column, this.topPercent);
    this.process(column, column.timeUs, this.threshold);
    this.last = column;
    const decisionMs = performance.now() - start;
    this.samples.push(decisionMs);
    this.samples = this.samples.slice(-30);
    this.metrics = { ...this.metrics, decisionMs,
      meanMs: this.samples.reduce((a, b) => a + b, 0) / this.samples.length,
      maxMs: Math.max(...this.samples), processedColumns: this.metrics.processedColumns + 1 };
  }

  rebuild(columns: readonly HeatColumn[], cutoffUs = Infinity): void {
    const start = performance.now();
    this.tracked.clear(); this.last = null; this.threshold = null; this.samples = [];
    this.metrics = { decisionMs: 0, meanMs: 0, maxMs: 0, processedColumns: 0,
      rebuildCount: this.metrics.rebuildCount + 1 };
    const ordered = new Map(columns.filter(c => c.timeUs <= cutoffUs).map(c => [c.timeUs, c]));
    for (const c of [...ordered.values()].sort((a, b) => a.timeUs - b.timeUs)) this.append(c);
    this.metrics.decisionMs = performance.now() - start;
  }

  snapshot(): BigOrderSnapshot {
    const timeUs = this.last?.timeUs ?? null;
    return { timeUs, threshold: this.threshold,
      orders: [...this.tracked.values()].map(order => ({ ...order,
        durationSec: timeUs === null ? 0 : (timeUs - order.startedUs) / US_PER_SECOND }))
        .sort((a, b) => a.price - b.price) };
  }

  private process(column: HeatColumn, timeUs: number, threshold: number | null): void {
    const levels = new Map<number, number>();
    let low = Infinity, high = -Infinity;
    for (const side of [column.bids, column.asks]) {
      for (let i = 0; i < side.prices.length; i++) {
        const price = side.prices[i]!, size = side.sizes[i]!;
        low = Math.min(low, price); high = Math.max(high, price);
        levels.set(price, size);
      }
    }
    for (const [price, order] of this.tracked) {
      // Expire before checking a return: returning at the five-minute deadline
      // must not revive the old start time.
      if (order.outsideSinceUs !== null && timeUs - order.outsideSinceUs >= 300 * US_PER_SECOND) {
        this.tracked.delete(price);
        continue;
      }
      if (price < low || price > high) {
        order.outsideSinceUs ??= timeUs;
      } else {
        const size = levels.get(price) ?? 0;
        if (threshold === null || size < threshold * 0.8) this.tracked.delete(price);
        else { order.size = size; order.outsideSinceUs = null; }
      }
    }
    if (threshold === null) return;
    for (const [price, size] of levels) {
      if (size < threshold || this.tracked.has(price)) continue;
      this.tracked.set(price, { price, size, startedUs: timeUs, outsideSinceUs: null });
    }
  }
}

/** Lifecycle adapter: bootstrap only from validated initial range zero.
 * Later historical ranges, including cache swaps, can never change tracking.
 */
export class BigOrderFeed {
  readonly tracker: BigOrderTracker;
  private initial: HeatColumn[] | null = null;
  private buffered: HeatColumn[] = [];
  private cutoffUs = Infinity;

  constructor(topPercent = 2) { this.tracker = new BigOrderTracker(topPercent); }

  beginInitial(cutoffUs: number): void {
    this.initial = []; this.buffered = []; this.cutoffUs = cutoffUs;
  }

  accept(columns: readonly HeatColumn[], kind: 1 | 2, reqId: number): void {
    if (kind === 2) {
      if (reqId === 0 && this.initial) this.initial.push(...columns.filter(c => c.timeUs <= this.cutoffUs));
      return;
    }
    if (this.initial) this.buffered.push(...columns);
    else for (const c of columns) this.tracker.append(c);
  }

  completeInitial(): void {
    if (!this.initial) return;
    this.tracker.rebuild(this.initial, this.cutoffUs);
    for (const c of this.buffered.sort((a, b) => a.timeUs - b.timeUs)) this.tracker.append(c);
    this.initial = null; this.buffered = [];
  }
}
