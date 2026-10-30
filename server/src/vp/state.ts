import type { Trade } from "../types.ts";

const chicago = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });

/** Calendar days, not fixed 24-hour subtraction: DST sessions can be 23/25 hours.
 * The explicitly approved interval includes the 16:00–17:00 maintenance hour.
 */
export function sessionStartSec(second: number): number {
  const parts = Object.fromEntries(chicago.formatToParts(new Date(second * 1000)).map(p => [p.type, p.value]));
  let date = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  if (+parts.hour < 17) date -= 86400000;
  // At 17:00 Chicago the UTC hour is 22 (CDT) or 23 (CST).
  const candidate = date / 1000 + 22 * 3600;
  return chicago.formatToParts(new Date(candidate * 1000)).find(p => p.type === "hour")!.value === "17"
    ? candidate : candidate + 3600;
}

export type VpLevel = [number, number, number];
export interface VpMessage {
  type: "vp" | "vpUpdate"; sessionStartSec: number; upToSec: number;
  loading?: boolean; levels: VpLevel[];
}
export class VolumeProfile {
  start: number;
  upToSec: number;
  loading = true;
  revision = 0;
  generation = 0;
  private end: number;
  buy = 0;
  sell = 0;
  private levels = new Map<number, { buy: number; sell: number; revision: number }>();
  private seconds = new Map<number, { buy: number; sell: number; weighted: number; unknown: number; revision: number }>();
  private lastTradeUs = 0;
  private dailyChanges = new Map<number, number>();
  private dailyFloor = 0;
  constructor(second: number) {
    this.start = sessionStartSec(second); this.upToSec = second;
    this.end = sessionStartSec(this.start + 27 * 3600);
  }
  advance(second: number): void {
    if (second >= this.end) {
      this.start = sessionStartSec(second); this.end = sessionStartSec(this.start + 27 * 3600);
      this.levels.clear(); this.buy = this.sell = 0; this.generation++;
      this.seconds.clear(); this.lastTradeUs = 0;
      this.dailyChanges.clear(); this.dailyFloor = 0;
      // All post-startup sessions are already owned by the running live/replay feed.
      this.loading = false;
    }
    this.upToSec = Math.max(this.upToSec, second);
  }
  add(trade: Trade): void {
    if (trade.tsUs < this.start * 1e6 || trade.tsUs >= this.end * 1e6) return;
    const level = this.levels.get(trade.price) ?? { buy: 0, sell: 0, revision: 0 };
    level[trade.side] += trade.size; level.revision = ++this.revision;
    this[trade.side] += trade.size;
    this.levels.set(trade.price, level);
    const second = Math.floor(trade.tsUs / 1e6) * 1e6;
    const row = this.seconds.get(second) ?? { buy: 0, sell: 0, weighted: 0, unknown: 0, revision: 0 };
    row[trade.side] += trade.size; row.weighted += trade.price * trade.size;
    if (!trade.contract) row.unknown += trade.size;
    row.revision = this.revision; this.seconds.set(second, row);
    this.dailyChanges.delete(second); this.dailyChanges.set(second, row.revision);
    if (this.dailyChanges.size > 512) {
      const [old, revision] = this.dailyChanges.entries().next().value!;
      this.dailyChanges.delete(old); this.dailyFloor = Math.max(this.dailyFloor, revision);
    }
    this.lastTradeUs = Math.max(this.lastTradeUs, trade.tsUs);
  }
  summary() {
    return { sessionStartSec: this.start, upToSec: this.upToSec, loading: this.loading,
      prices: this.levels.size, buy: this.buy, sell: this.sell, total: this.buy + this.sell };
  }
  complete(start: number): void {
    if (start !== this.start) return;
    this.loading = false; this.generation++;
  }
  /** Absolute per-second counters: retransmission is replacement, never addition.
   * Uses the SAME accepted rows/ownership as VP, not another history job. */
  dailyMessage(after?: number) {
    const full = after === undefined || after < this.dailyFloor;
    const seconds = full ? [...this.seconds.keys()]
      : [...this.dailyChanges].filter(([, revision]) => revision > after!).map(([t]) => t);
    return { type: "sessionIndicators", sessionStartSec: this.start, full,
      revision: this.revision, loading: this.loading, quality: "received_not_guaranteed",
      upToUs: this.lastTradeUs, adjusted: false,
      points: seconds.sort((a, b) => a - b).map(t => {
        const r = this.seconds.get(t)!; return [t, r.buy, r.sell, r.weighted, r.unknown];
      }) };
  }
  message(after?: number): VpMessage {
    return { type: after === undefined ? "vp" : "vpUpdate", sessionStartSec: this.start,
      upToSec: this.upToSec, ...(after === undefined ? { loading: this.loading } : {}),
      levels: [...this.levels].filter(([, v]) => after === undefined || v.revision > after)
        .sort(([a], [b]) => a - b).map(([price, v]) => [price, v.buy, v.sell]) };
  }
}
