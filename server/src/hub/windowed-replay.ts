import type { Column } from "../aggregate/columns.ts";
import type { Trade } from "../types.ts";
import { realClock } from "./replay.ts";
import type { ReplayClock } from "./replay.ts";

export interface ReplayView { columns: Column[]; trades: Trade[] }
interface Window extends ReplayView { end: number; columnIndex: number; tradeIndex: number }

/** Absolute virtual clock, with at most one 300-second window plus one read-ahead.
 * Neither the saved end nor the protocol changes as new live data arrives.
 */
export class WindowedReplay {
  private timer: unknown;
  private stopped = false;
  private started = 0;
  private bucketUs: number;
  private current: Window;
  private nextReady: Window | null = null;
  private reading = false;
  private waiting = false;
  private readonly from: number;
  private readonly to: number;
  private readonly speed: number;
  private readonly read: (start: number, end: number) => Promise<ReplayView>;
  private readonly clock: ReplayClock;
  private readonly emit: { column(c: Column): void; trades(t: Trade[]): void; end(): void; error(): void };

  constructor(first: ReplayView, from: number, to: number, speed: number,
    read: WindowedReplay["read"], emit: WindowedReplay["emit"], clock: ReplayClock = realClock) {
    this.from = from; this.to = to; this.speed = speed; this.read = read; this.emit = emit; this.clock = clock;
    this.bucketUs = from * 1e6 + 250000;
    this.current = this.window(first, Math.min(from + 300, to));
  }

  private window(view: ReplayView, end: number): Window {
    return { columns: view.columns, trades: view.trades.slice().sort((a, b) =>
      Math.floor(a.tsUs / 1e6) - Math.floor(b.tsUs / 1e6) || a.seq - b.seq),
      end, columnIndex: 0, tradeIndex: 0 };
  }

  start(): void { this.started = this.clock.now(); this.prefetch(); this.advance(); }

  private prefetch(): void {
    if (this.stopped || this.reading || this.nextReady || this.current.end >= this.to) return;
    const from = this.current.end, to = Math.min(from + 300, this.to);
    this.reading = true;
    void this.read(from, to).then(view => {
      this.reading = false;
      if (this.stopped) return;
      this.nextReady = this.window(view, to);
      if (this.waiting) { this.waiting = false; this.advance(); }
    }).catch(() => {
      this.reading = false;
      if (this.stopped) return;
      this.stop(); this.emit.error();
    });
  }

  private advance(): void {
    if (this.stopped) return;
    const cursor = Math.min(this.to * 1e6, this.from * 1e6 + (this.clock.now() - this.started) * 1000 * this.speed);
    for (;;) {
      const window = this.current, limit = Math.min(cursor, window.end * 1e6);
      while (!this.stopped && window.columnIndex < window.columns.length
        && window.columns[window.columnIndex].tsSec * 1e6 <= limit) {
        const index = window.columnIndex++;
        const column = window.columns[index];
        this.emit.column(column);
        // Release consumed objects even during a long-lived connection.
        delete window.columns[index];
      }
      // The existing scheduler emits columns at the cursor before the trade
      // bucket ending there. Preserve that interleaving at a window boundary.
      if (!this.stopped && cursor >= window.end * 1e6 && window.end < this.to) {
        if (!this.nextReady) { this.waiting = true; this.prefetch(); return; }
        const future = this.nextReady;
        while (!this.stopped && future.columnIndex < future.columns.length
          && future.columns[future.columnIndex].tsSec * 1e6 <= cursor) {
          const index = future.columnIndex++;
          this.emit.column(future.columns[index]);
          delete future.columns[index];
        }
      }
      while (!this.stopped && this.bucketUs <= limit) {
        const batch: Trade[] = [];
        while (window.tradeIndex < window.trades.length && window.trades[window.tradeIndex].tsUs < this.bucketUs) {
          const index = window.tradeIndex++;
          batch.push(window.trades[index]); delete window.trades[index];
        }
        if (batch.length) this.emit.trades(batch);
        this.bucketUs += 250000;
      }
      if (this.stopped) return;
      if (cursor < window.end * 1e6) break;
      if (window.end >= this.to) {
        this.stop(); this.emit.end(); return;
      }
      if (!this.nextReady) {
        this.waiting = true; this.prefetch(); return;
      }
      this.current = this.nextReady; this.nextReady = null; this.prefetch();
    }
    const next = Math.min(this.bucketUs,
      (this.current.columns[this.current.columnIndex]?.tsSec ?? this.current.end) * 1e6,
      this.current.end * 1e6, this.to * 1e6);
    this.timer = this.clock.later(() => this.advance(), Math.max(0,
      (next - this.from * 1e6) / (1000 * this.speed) - (this.clock.now() - this.started)));
  }

  stop(): void {
    this.stopped = true; this.clock.cancel(this.timer);
    this.current.columns = []; this.current.trades = []; this.nextReady = null;
  }
}
