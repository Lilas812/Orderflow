import { historyColumns, historyTrades } from "./decode.ts";
import type { HistorySource } from "./client.ts";
import { WindowUnavailableError } from "./client.ts";
import { setTimeout as delay } from "node:timers/promises";
import { inWindow } from "./decode.ts";
import { hourOf } from "../store/local.ts";
import type { Kind, Store } from "../store/local.ts";
import type { Metrics } from "../ingest/metrics.ts";
import type { Log } from "../logger.ts";

export function missingRuns(store: Store, kind: Kind, start: number, end: number): [number, number][] {
  const result: [number, number][] = [];
  for (let sec = start; sec < end;) {
    if (store.covered(kind, sec)) { sec++; continue; }
    const a = sec++;
    while (sec < end && !store.covered(kind, sec)) sec++;
    result.push([a, sec]);
  }
  return result;
}

interface DeferredEmpty {
  kind: Kind; startSec: number; endSec: number; retries: number; nextAttemptUs: number;
}
interface HistoryGap {
  kind: Kind; startSec: number; endSec: number; reason: string;
}
interface Schedule {
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class Backfill {
  readonly status = {
    state: "idle" as "idle" | "running" | "complete" | "failed" | "stopped",
    startSec: null as number | null, endSec: null as number | null,
    totalWindows: 180, completedWindows: 0, skippedRequests: 0, emptyRequests: 0, splitRequests: 0,
    startedAtUs: null as number | null, finishedAtUs: null as number | null, elapsedMs: 0,
    lastError: null as string | null,
    emptyRetries: 0, pendingEmpty: [] as DeferredEmpty[],
    noData: [] as (HistoryGap & { attempts: number })[],
    gaps: [] as HistoryGap[],
  };
  private source: HistorySource;
  private store: Store;
  private metrics: Metrics;
  private nextSeq: () => number;
  private log: Log;
  private abort = new AbortController();
  private task: Promise<void> | null = null;
  private schedule: Schedule;
  constructor(source: HistorySource, store: Store, metrics: Metrics, nextSeq: () => number, log: Log,
    schedule: Schedule = { now: Date.now, wait: async (ms, signal) => { await delay(ms, undefined, { signal }); } }) {
    this.source = source; this.store = store; this.metrics = metrics; this.nextSeq = nextSeq; this.log = log;
    this.schedule = schedule;
  }
  start(L: number) {
    if (this.task) return;
    const start = L - 10800;
    Object.assign(this.status, { state: "running", startSec: start, endSec: L, startedAtUs: this.schedule.now() * 1000 });
    this.store.hold(start, L);
    this.task = this.run(start, L);
  }
  snapshot() {
    if (this.status.state === "running") this.status.elapsedMs = this.schedule.now() - this.status.startedAtUs! / 1000;
    return { ...this.status, pendingEmpty: this.status.pendingEmpty.map(p => ({ ...p })),
      noData: this.status.noData.map(p => ({ ...p })), gaps: this.status.gaps.map(p => ({ ...p })) };
  }
  private async take(kind: Kind, start: number, end: number, retries = 0): Promise<void> {
    this.abort.signal.throwIfAborted();
    let response;
    try { response = await this.source.get(kind, start, end, this.abort.signal); }
    catch (error) {
      if (!(error instanceof WindowUnavailableError)) throw error;
      const gap = { kind, startSec: start, endSec: end, reason: error.reason };
      this.status.gaps.push(gap);
      this.log("history_window_gap", gap);
      return; // Not covered: a later run may try again.
    }
    if (response.truncated) {
      if (end - start <= 1) throw Error("history_truncated_at_one_second");
      this.status.splitRequests++;
      const middle = start + Math.floor((end - start) / 2);
      await this.take(kind, middle, end); await this.take(kind, start, middle);
      return;
    }
    const empty = !response.rows.some(row => inWindow(row, start, end));
    if (empty) {
      this.status.emptyRequests++;
      const nowSec = this.schedule.now() / 1000;
      if ((retries > 0 || (end >= nowSec - 300 && end <= nowSec)) && retries < 3) {
        const deferred = { kind, startSec: start, endSec: end, retries, nextAttemptUs: (this.schedule.now() + 120000) * 1000 };
        this.status.pendingEmpty.push(deferred);
        this.log("history_empty_deferred", deferred);
        return; // Do not cover/release this time range while it is waiting.
      }
      const noData = { kind, startSec: start, endSec: end, reason: "empty_response", attempts: retries + 1 };
      this.status.noData.push(noData);
      this.log("history_no_data", noData);
    }
    if (kind === "book") {
      const columns = historyColumns(response.rows, start, end, this.metrics);
      await this.store.addColumns(columns);
    } else {
      const trades = historyTrades(response.rows, start, end, this.metrics, this.nextSeq);
      await this.store.addTrades(trades);
    }
    this.log("history_range_saved", { kind, startSec: start, endSec: end, empty, attempts: retries + 1 });
    this.store.markCovered(kind, start, end);
  }
  private async retryReady() {
    for (;;) {
      const index = this.status.pendingEmpty.findIndex(p => p.nextAttemptUs <= this.schedule.now() * 1000);
      if (index < 0) return;
      const [pending] = this.status.pendingEmpty.splice(index, 1);
      this.status.emptyRetries++;
      this.log("history_empty_retry", { ...pending, attempt: pending.retries + 2 });
      await this.take(pending.kind, pending.startSec, pending.endSec, pending.retries + 1);
    }
  }
  private async run(start: number, end: number) {
    const released = new Set<number>();
    try {
      for (let b = end; b > start;) {
        const a = Math.max(start, b - 60);
        for (const kind of ["book", "tick"] as const) {
          const missing = missingRuns(this.store, kind, a, b);
          if (!missing.length) this.status.skippedRequests++;
          for (const [x, y] of missing.reverse()) {
            await this.retryReady();
            await this.take(kind, x, y);
          }
        }
        this.status.completedWindows++;
        for (let h = hourOf(end - 1); h >= hourOf(start); h -= 3600) {
          const waiting = this.status.pendingEmpty.some(p => p.startSec < h + 3600 && p.endSec > h);
          if (a <= h && !released.has(h) && !waiting) { await this.store.releaseHour(h); released.add(h); }
        }
        this.log("history_window_complete", { startSec: a, endSec: b, completed: this.status.completedWindows });
        b = a;
      }
      while (this.status.pendingEmpty.length) {
        await this.retryReady();
        if (this.status.pendingEmpty.length) {
          const next = Math.min(...this.status.pendingEmpty.map(p => p.nextAttemptUs / 1000));
          await this.schedule.wait(Math.max(0, next - this.schedule.now()), this.abort.signal);
        }
      }
      for (let h = hourOf(start); h < end; h += 3600) if (!released.has(h)) await this.store.releaseHour(h);
      this.status.state = "complete";
      this.status.finishedAtUs = this.schedule.now() * 1000;
      this.status.elapsedMs = (this.status.finishedAtUs - this.status.startedAtUs!) / 1000;
      this.log("history_complete", this.snapshot());
    } catch (error) {
      this.status.state = this.abort.signal.aborted ? "stopped" : "failed";
      this.status.lastError = this.abort.signal.aborted ? "shutdown" : (error instanceof Error ? error.message : "history_failed");
      this.log("history_stopped", this.snapshot());
    } finally {
      this.status.finishedAtUs = this.schedule.now() * 1000;
      this.status.elapsedMs = (this.status.finishedAtUs - this.status.startedAtUs!) / 1000;
      // Failure must not hold subsequent live data indefinitely.
      if (this.status.state === "failed") {
        for (let h = hourOf(start); h < end; h += 3600) await this.store.releaseHour(h);
      }
    }
  }
  async stop() { this.abort.abort(); await this.task; }
  async settled() { await this.task; }
}
