import type { Column } from "../aggregate/columns.ts";
import type { Trade } from "../types.ts";
import { realClock } from "./replay.ts";
import type { ReplayClock } from "./replay.ts";

export interface ReplayView { columns: Column[]; trades: Trade[] }
interface Window extends ReplayView {
  end: number; columnIndex: number; tradeIndex: number; vpTrades: Trade[]; vpIndex: number;
}

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
  private speed: number;
  private precise: boolean;
  private anchorUs: number;
  private headUs: number;
  private paused = false;
  private stepTarget: number | null = null;
  private stepDone?: () => void;
  private readonly read: (start: number, end: number) => Promise<ReplayView>;
  private readonly clock: ReplayClock;
  private readonly emit: { column(c: Column): void; trades(t: Trade[]): void; end(): void; error(): void;
    cursor?(upToUs: number): void; vpTrades?(trades: Trade[]): void };

  constructor(first: ReplayView, from: number, to: number, speed: number,
    read: WindowedReplay["read"], emit: WindowedReplay["emit"], clock: ReplayClock = realClock, precise = false,
    initialHeadUs = from * 1_000_000) {
    this.from = from; this.to = to; this.speed = speed; this.read = read; this.emit = emit; this.clock = clock;
    if (!Number.isSafeInteger(initialHeadUs) || initialHeadUs < from * 1e6 || initialHeadUs > to * 1e6) throw Error("invalid_replay_head");
    this.anchorUs = this.headUs = initialHeadUs;
    this.precise = precise;
    this.bucketUs = (Math.floor(initialHeadUs / 250000) + 1) * 250000;
    this.current = this.window(first, Math.min(from + 300, to));
    while (this.current.tradeIndex < this.current.trades.length && this.current.trades[this.current.tradeIndex]!.tsUs < initialHeadUs) {
      this.current.tradeIndex++;
    }
  }

  private window(view: ReplayView, end: number): Window {
    return { columns: view.columns, trades: view.trades.slice().sort((a, b) =>
      (this.precise ? a.tsUs - b.tsUs : Math.floor(a.tsUs / 1e6) - Math.floor(b.tsUs / 1e6)) || a.seq - b.seq),
      end, columnIndex: 0, tradeIndex: 0, vpIndex: 0,
      vpTrades: this.emit.vpTrades ? view.trades.slice().sort((a, b) => a.tsUs - b.tsUs || a.seq - b.seq) : [] };
  }

  get positionUs() { return this.headUs; }
  start(paused = false): void { this.paused = paused; this.started = this.clock.now(); this.prefetch(); if (!paused) this.advance(); }
  pause(): void {
    if (this.stopped || this.paused) return;
    this.advance();
    this.paused = true; this.anchorUs = this.headUs; this.clock.cancel(this.timer);
  }
  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false; this.anchorUs = this.headUs; this.started = this.clock.now(); this.advance();
  }
  changeSpeed(speed: number): void {
    const playing = !this.paused;
    if (playing) this.pause();
    this.speed = speed;
    if (playing) this.resume();
  }
  step(seconds: number): Promise<void> {
    if (!this.paused || this.stopped || this.stepTarget !== null) return Promise.reject(Error("replay_not_paused"));
    return new Promise(resolve => {
      this.stepDone = resolve; this.stepTarget = Math.min(this.to * 1e6, this.headUs + seconds * 1e6);
      this.advance();
    });
  }

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
    this.clock.cancel(this.timer);
    if (this.stopped || (this.paused && this.stepTarget === null)) return;
    const cursor = this.stepTarget ?? Math.min(this.to * 1e6, this.anchorUs + (this.clock.now() - this.started) * 1000 * this.speed);
    this.headUs = cursor;
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
      if (this.precise) {
        const batch: Trade[] = [];
        while (window.tradeIndex < window.trades.length && window.trades[window.tradeIndex].tsUs < limit) {
          const index = window.tradeIndex++; batch.push(window.trades[index]); delete window.trades[index];
        }
        if (batch.length) this.emit.trades(batch);
      }
      if (this.emit.vpTrades) {
        const batch: Trade[] = [];
        while (window.vpIndex < window.vpTrades.length && window.vpTrades[window.vpIndex].tsUs < limit) {
          const index = window.vpIndex++;
          batch.push(window.vpTrades[index]); delete window.vpTrades[index];
        }
        if (batch.length) this.emit.vpTrades(batch);
      }
      this.emit.cursor?.(limit);
      if (limit === this.stepTarget) { this.stepTarget = null; this.stepDone?.(); this.stepDone = undefined; }
      if (cursor < window.end * 1e6) break;
      if (window.end >= this.to) {
        this.stop(); this.emit.end(); return;
      }
      if (!this.nextReady) {
        this.waiting = true; this.prefetch(); return;
      }
      this.current = this.nextReady; this.nextReady = null; this.prefetch();
    }
    if (this.paused) return;
    const next = Math.min(this.bucketUs,
      (this.current.columns[this.current.columnIndex]?.tsSec ?? this.current.end) * 1e6,
      this.current.end * 1e6, this.to * 1e6);
    this.timer = this.clock.later(() => this.advance(), Math.max(this.precise ? 1 : 0,
      (next - this.anchorUs) / (1000 * this.speed) - (this.clock.now() - this.started)));
  }

  stop(): void {
    this.stopped = true; this.clock.cancel(this.timer);
    this.stepDone?.(); this.stepDone = undefined; this.stepTarget = null;
    this.current.columns = []; this.current.trades = []; this.current.vpTrades = []; this.nextReady = null;
  }
}
