import { historyColumns, historyTrades } from "./decode.ts";
import type { HistorySource } from "./client.ts";
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

export class Backfill {
  readonly status = {
    state: "idle" as "idle" | "running" | "complete" | "failed" | "stopped",
    startSec: null as number | null, endSec: null as number | null,
    totalWindows: 180, completedWindows: 0, skippedRequests: 0, emptyRequests: 0, splitRequests: 0,
    startedAtUs: null as number | null, finishedAtUs: null as number | null, elapsedMs: 0,
    lastError: null as string | null,
  };
  private source: HistorySource;
  private store: Store;
  private metrics: Metrics;
  private nextSeq: () => number;
  private log: Log;
  private abort = new AbortController();
  private task: Promise<void> | null = null;
  constructor(source: HistorySource, store: Store, metrics: Metrics, nextSeq: () => number, log: Log) {
    this.source = source; this.store = store; this.metrics = metrics; this.nextSeq = nextSeq; this.log = log;
  }
  start(L: number) {
    if (this.task) return;
    const start = L - 10800;
    Object.assign(this.status, { state: "running", startSec: start, endSec: L, startedAtUs: Date.now() * 1000 });
    this.store.hold(start, L);
    this.task = this.run(start, L);
  }
  snapshot() {
    if (this.status.state === "running") this.status.elapsedMs = Date.now() - this.status.startedAtUs! / 1000;
    return { ...this.status };
  }
  private async take(kind: Kind, start: number, end: number): Promise<void> {
    this.abort.signal.throwIfAborted();
    const response = await this.source.get(kind, start, end, this.abort.signal);
    if (response.truncated) {
      if (end - start <= 1) throw Error("history_truncated_at_one_second");
      this.status.splitRequests++;
      const middle = start + Math.floor((end - start) / 2);
      await this.take(kind, middle, end); await this.take(kind, start, middle);
      return;
    }
    if (kind === "book") {
      const columns = historyColumns(response.rows, start, end, this.metrics);
      await this.store.addColumns(columns);
      if (!columns.length) this.status.emptyRequests++;
    } else {
      const trades = historyTrades(response.rows, start, end, this.metrics, this.nextSeq);
      await this.store.addTrades(trades);
      if (!trades.length) this.status.emptyRequests++;
    }
    // Including empty/rejected seconds: absence is real, not a trigger for repeated downloads.
    this.store.markCovered(kind, start, end);
  }
  private async run(start: number, end: number) {
    const released = new Set<number>();
    try {
      for (let b = end; b > start;) {
        const a = Math.max(start, b - 60);
        for (const kind of ["book", "tick"] as const) {
          const missing = missingRuns(this.store, kind, a, b);
          if (!missing.length) this.status.skippedRequests++;
          for (const [x, y] of missing.reverse()) await this.take(kind, x, y);
        }
        this.status.completedWindows++;
        for (let h = hourOf(end - 1); h >= hourOf(start); h -= 3600) {
          if (a <= h && !released.has(h)) { await this.store.releaseHour(h); released.add(h); }
        }
        this.log("history_window_complete", { startSec: a, endSec: b, completed: this.status.completedWindows });
        b = a;
      }
      for (let h = hourOf(start); h < end; h += 3600) if (!released.has(h)) await this.store.releaseHour(h);
      this.status.state = "complete";
      this.log("history_complete", this.snapshot());
    } catch (error) {
      this.status.state = this.abort.signal.aborted ? "stopped" : "failed";
      this.status.lastError = this.abort.signal.aborted ? "shutdown" : (error instanceof Error ? error.message : "history_failed");
      this.log("history_stopped", this.snapshot());
    } finally {
      this.status.finishedAtUs = Date.now() * 1000;
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
