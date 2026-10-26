import type { Column } from "../aggregate/columns.ts";
import type { Trade } from "../types.ts";

export interface ReplayClock {
  now(): number;
  later(fn: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}
export const realClock: ReplayClock = {
  now: Date.now, later: (fn, ms) => setTimeout(fn, ms),
  cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
/** One short timer per peer; never sleeps/blocks the receive path.
 * Recorded seconds ascend; within a second retain seq (including backwards µs).
 * The scheduling time is monotonic, the original Trade timestamps are never modified.
 */
export class Replay {
  private timer: unknown;
  private stopped = false;
  private started = 0;
  private columnIndex = 0;
  private tradeIndex = 0;
  private bucketUs: number;
  private trades: Trade[];
  private columns: Column[];
  private from: number;
  private to: number;
  private speed: number;
  private clock: ReplayClock;
  private emit: { column(c: Column): void; trades(t: Trade[]): void; end(): void };
  constructor(columns: Column[], trades: Trade[], fromSec: number, toSec: number, speed: number,
    emit: Replay["emit"], clock: ReplayClock = realClock) {
    this.columns = columns; this.trades = trades.slice().sort((a, b) =>
      Math.floor(a.tsUs / 1e6) - Math.floor(b.tsUs / 1e6) || a.seq - b.seq);
    this.from = fromSec; this.to = toSec; this.speed = speed; this.clock = clock; this.emit = emit;
    this.bucketUs = fromSec * 1e6 + 250000;
  }
  start() { this.started = this.clock.now(); this.advance(); }
  private advance() {
    if (this.stopped) return;
    const cursor = Math.min(this.to * 1e6, this.from * 1e6 + (this.clock.now() - this.started) * 1000 * this.speed);
    while (this.columnIndex < this.columns.length && this.columns[this.columnIndex].tsSec * 1e6 <= cursor) {
      this.emit.column(this.columns[this.columnIndex++]);
    }
    while (this.bucketUs <= cursor) {
      const batch: Trade[] = [];
      while (this.tradeIndex < this.trades.length && this.trades[this.tradeIndex].tsUs < this.bucketUs) {
        batch.push(this.trades[this.tradeIndex++]);
      }
      if (batch.length) this.emit.trades(batch);
      this.bucketUs += 250000;
    }
    if (cursor >= this.to * 1e6) { this.stopped = true; this.emit.end(); return; }
    const next = Math.min(this.bucketUs, (this.columns[this.columnIndex]?.tsSec ?? this.to) * 1e6, this.to * 1e6);
    this.timer = this.clock.later(() => this.advance(), Math.max(0, (next - this.from * 1e6) / (1000 * this.speed)
      - (this.clock.now() - this.started)));
  }
  stop() { this.stopped = true; this.clock.cancel(this.timer); }
}
