import { setTimeout as delay } from "node:timers/promises";
import type { HistorySource, HistoryResponse } from "./client.ts";
import { WindowSplitRequired, timeoutSplit } from "./client.ts";
import { decodedColumns, decodedTrades, inputRows } from "./prepared.ts";
import type { LocalStore } from "../store/local.ts";
import type { Metrics } from "../ingest/metrics.ts";
import type { Log } from "../logger.ts";
import type { Trade } from "../types.ts";

export interface LiveGap { startSec: number; endSec: number; reason: string; }
export class LiveGapRepair {
  readonly status = { running: false, completed: 0, columns: 0, trades: 0, quantity: 0,
    expired: 0, failures: 0, seams: [] as { startSec: number; endSec: number }[],
    unresolved: [] as (LiveGap & { repairReason: string })[] };
  private seen = new WeakSet<LiveGap>();
  private lastUnresolved = new Map<string, LiveGap & { repairReason: string }>();
  private abort = new AbortController();
  private task: Promise<void> | null = null;
  private source: HistorySource;
  private store: LocalStore;
  private metrics: Metrics;
  private nextSeq: () => number;
  private log: Log;
  private saved: (trades: Trade[], start: number, end: number) => void;
  private now: () => number;
  constructor(source: HistorySource, store: LocalStore, metrics: Metrics, nextSeq: () => number, log: Log,
    saved: (trades: Trade[], start: number, end: number) => void, now = Date.now) {
    this.source = source; this.store = store; this.metrics = metrics; this.nextSeq = nextSeq;
    this.log = log; this.saved = saved; this.now = now;
  }
  tick(gaps: LiveGap[]) {
    if (this.task || this.abort.signal.aborted) return;
    const gap = gaps.find(g => !this.seen.has(g) && this.now() / 1000 >= g.endSec + 300);
    if (!gap) return;
    this.seen.add(gap);
    const cutoff = Math.ceil(this.now() / 1000 - 7 * 86400);
    let startSec = gap.startSec;
    if (startSec < cutoff) {
      this.status.expired++;
      this.unresolved({ ...gap, endSec: Math.min(gap.endSec, cutoff), repairReason: "older_than_seven_days" });
      if (gap.endSec <= cutoff) return;
      startSec = cutoff;
    }
    this.status.running = true;
    this.task = this.run({ ...gap, startSec }).catch(() => {
      if (!this.abort.signal.aborted) {
        this.status.failures++;
        this.unresolved({ ...gap, repairReason: "history_repair_failed" });
        this.log("live_gap_repair_failed", { ...gap, reason: "history_repair_failed" });
      }
    }).finally(() => { this.task = null; this.status.running = false; });
  }
  private unresolved(range: LiveGap & { repairReason: string }) {
    const previous = this.lastUnresolved.get(range.repairReason);
    if (previous && previous.reason === range.reason && previous.endSec >= range.startSec
      && previous.startSec <= range.startSec) previous.endSec = Math.max(previous.endSec, range.endSec);
    else { this.status.unresolved.push(range); this.lastUnresolved.set(range.repairReason, range); }
  }
  private async take(kind: "book" | "tick", start: number, end: number, emptyRetry = 0): Promise<void> {
    this.abort.signal.throwIfAborted();
    let response: HistoryResponse;
    try { response = await this.source.get(kind, start, end, this.abort.signal); }
    catch (error) {
      if (error instanceof WindowSplitRequired) {
        const mid = timeoutSplit(start, end);
        if (mid !== null) { await this.take(kind, start, mid); await this.take(kind, mid, end); return; }
      }
      throw error;
    }
    if (response.truncated) {
      if (end - start <= 1) throw Error("history_truncated_at_one_second");
      const mid = start + Math.floor((end - start) / 2);
      await this.take(kind, start, mid); await this.take(kind, mid, end); return;
    }
    const rows = inputRows(response, start, end);
    if (!rows && end >= this.now() / 1000 - 600 && emptyRetry < 3) {
      await delay(120000, undefined, { signal: this.abort.signal });
      return this.take(kind, start, end, emptyRetry + 1);
    }
    if (!rows) {
      this.unresolved({ startSec: start, endSec: end, reason: "no_accepted_live_book",
        repairReason: kind === "book" ? "history_book_empty" : "history_tick_empty" });
      return;
    }
    if (kind === "book") {
      const columns = decodedColumns(response, start, end, this.metrics, this.source.symbol);
      this.status.columns += await this.store.repairMissingColumns(start, end, columns);
      const existing = (await this.store.readView(start, end)).columns;
      const missing = new Set(existing.map(c => c.tsSec));
      for (let s = start; s < end; s++) if (!missing.has(s))
        this.unresolved({ startSec: s, endSec: s + 1, reason: "no_accepted_live_book", repairReason: "history_book_unavailable" });
    } else {
      const trades = decodedTrades(response, start, end, this.metrics, this.nextSeq, this.source.symbol);
      if (trades.length !== rows) throw Error("invalid_history_tick");
      const seams = await this.store.repairEmptyTradeSeconds(start, end, trades, (fresh, a, b) => {
        this.status.trades += fresh.length;
        this.status.quantity += fresh.reduce((n, t) => n + t.size, 0);
        this.saved(fresh, a, b);
      });
      for (const seam of seams) {
        const last = this.status.seams.at(-1);
        if (last && last.endSec === seam.startSec) last.endSec = seam.endSec;
        else this.status.seams.push(seam);
      }
    }
  }
  private async run(gap: LiveGap) {
    for (let start = gap.startSec; start < gap.endSec; start += 60) {
      const end = Math.min(start + 60, gap.endSec);
      await this.take("book", start, end); await this.take("tick", start, end);
    }
    this.status.completed++;
    this.log("live_gap_repair_attempt_finished", { ...gap, ...this.status, seams: this.status.seams.length,
      unresolved: this.status.unresolved.length });
  }
  async settled() { await this.task; }
  async stop() { this.abort.abort(); await this.task; }
}
