import path from "node:path";
import { fileURLToPath } from "node:url";
import { ColumnAggregator } from "./aggregate/columns.ts";
import type { Column } from "./aggregate/columns.ts";
import { LocalStore } from "./store/local.ts";
import { Metrics } from "./ingest/metrics.ts";
import { HistoryClient } from "./history/client.ts";
import { Backfill } from "./history/backfill.ts";
import type { BookSnapshot, Trade } from "./types.ts";
import type { Log } from "./logger.ts";
import { VolumeProfile } from "./vp/state.ts";
import { VpHistory, coverageSegments } from "./vp/history.ts";
import type { MarketSymbol } from "../../lib/market/instruments.ts";

export class Pipeline {
  readonly store: LocalStore;
  readonly historyMetrics: Metrics;
  readonly client: HistoryClient;
  readonly backfill: Backfill;
  readonly vp: VolumeProfile;
  readonly vpHistory: VpHistory;
  private aggregate: ColumnAggregator;
  private log: Log;
  private seam: number | null = null;
  private lastColumn: number | null = null;
  private gaps: { startSec: number; endSec: number; reason: string }[] = [];
  private tradeBatch: Trade[] = [];
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private pending = new Set<Promise<unknown>>();
  private storageError: string | null = null;
  private ticking = false;
  private onColumn: (column: Column) => void;

  constructor(apiKey: string, nextSeq: () => number, log: Log, onColumn: (column: Column) => void = () => {},
    store?: LocalStore, symbol: MarketSymbol = "NQ", request: typeof fetch = fetch) {
    this.log = log;
    this.onColumn = onColumn;
    // Resolve independently of the workflow's cwd; never under server/data.
    this.store = store ?? new LocalStore(fileURLToPath(new URL(
      symbol === "NQ" ? "../../data/" : "../../data/instruments/GC/", import.meta.url)), Date.now, undefined, symbol);
    this.historyMetrics = new Metrics(log);
    this.client = new HistoryClient(apiKey, log, request, undefined, symbol);
    this.backfill = new Backfill(this.client, this.store, this.historyMetrics, nextSeq, log);
    this.vp = new VolumeProfile(Date.now() / 1000);
    this.vpHistory = new VpHistory(this.vp, this.client, this.store, this.historyMetrics, nextSeq, log);
    this.aggregate = new ColumnAggregator(column => {
      if (this.seam === null) {
        this.seam = column.tsSec;
        this.log("live_history_seam", { tsSec: this.seam });
        this.backfill.start(this.seam); // Hold before enqueuing the first live write.
        this.vpHistory.start(this.seam, this.backfill.settled());
        this.tradeBatch = this.tradeBatch.filter(t => t.tsUs >= this.seam! * 1_000_000);
        // Trades received before the first finalized column were buffered but
        // not yet counted. L belongs to live; only timestamps strictly below L
        // are owned by history. This branch runs once, even across rollbacks.
        this.vp.advance(Date.now() / 1000);
        for (const trade of this.tradeBatch) this.vp.add(trade);
      }
      if (this.lastColumn !== null && column.tsSec > this.lastColumn + 1) {
        const gap = { startSec: this.lastColumn + 1, endSec: column.tsSec, reason: "no_accepted_live_book" };
        this.gaps.push(gap); this.log("live_column_gap", gap);
      }
      this.lastColumn = column.tsSec;
      this.track(this.store.addColumns([column]));
      this.onColumn(column);
    });
  }
  private track(promise: Promise<unknown>) {
    const tracked = promise.catch(() => {
      if (!this.storageError) {
        this.storageError = "local_storage_failed";
        this.log("storage_failed", { reason: this.storageError });
      }
    }).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
  async initialize(signal?: AbortSignal) {
    await this.store.initialize(signal);
    signal?.throwIfAborted();
    this.timer = setInterval(() => { void this.tick(); }, 1000);
  }
  book(book: BookSnapshot) {
    if (this.stopped) return;
    this.aggregate.accept(book);
    if (this.expiry) clearTimeout(this.expiry);
    const second = this.aggregate.pendingSecond;
    if (second !== null) this.expiry = setTimeout(() => {
      this.expiry = null;
      this.aggregate.expire(Date.now() * 1000);
    }, Math.max(0, (second + 3) * 1000 - Date.now()));
  }
  trade(trade: Trade) {
    if (!this.stopped && (this.seam === null || trade.tsUs >= this.seam * 1_000_000)) {
      this.tradeBatch.push(trade);
      if (this.seam !== null) { this.vp.advance(Date.now() / 1000); this.vp.add(trade); }
    }
  }
  private async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      this.vp.advance(Date.now() / 1000);
      if (this.seam !== null && this.tradeBatch.length) {
        const batch = this.tradeBatch; this.tradeBatch = [];
        await this.store.addTrades(batch);
      }
      await this.store.maintenance();
    } catch {
      this.storageError = "local_storage_failed";
      this.log("storage_failed", { reason: this.storageError });
    } finally { this.ticking = false; }
  }
  status() {
    const gaps = this.gaps.slice();
    if (this.lastColumn !== null) {
      const end = Math.min(Math.floor(Date.now() / 1000) - 2, this.aggregate.pendingSecond ?? Infinity);
      if (end > this.lastColumn + 1) gaps.push({
        startSec: this.lastColumn + 1, endSec: end, reason: "no_accepted_live_book_ongoing",
      });
    }
    return {
      seamL: this.seam,
      vp: { ...this.vpHistory.snapshot(), profile: this.vp.summary() },
      backfill: this.backfill.snapshot(), historyNetwork: { ...this.client.stats },
      historyCounts: { ...this.historyMetrics.counts }, historyExamples: this.historyMetrics.examples,
      storage: { ...this.store.stats,
        ...("cloudStatus" in this.store ? { appStorage: this.store.cloudStatus } : {}) }, storageError: this.storageError,
      liveGaps: gaps, unconfirmedSecond: this.aggregate.pendingSecond,
    };
  }
  readRange(start: number, end: number) {
    // Capture before enqueuing the store view: the one-second flush may move this
    // batch into the store later, but cannot interleave inside that view.
    const buffered = this.tradeBatch.filter(t => t.tsUs >= start * 1e6 && t.tsUs < end * 1e6);
    return this.store.readView(start, end).then(view => ({
      columns: view.columns, trades: [...view.trades, ...buffered].sort((a, b) => a.seq - b.seq),
    }));
  }
  async replayVp(from: number, alive: () => boolean) {
    const profile = new VolumeProfile(from);
    const coverage = await this.store.recordedTickCoverage();
    for (const segment of coverageSegments(coverage, profile.start, from)) {
      if (!segment.covered) {
        this.log("vp_replay_gap", { startSec: segment.start, endSec: segment.end }); continue;
      }
      for (let a = segment.start; a < segment.end; a += 900) {
        if (!alive()) return profile;
        await this.store.visitTrades(a, Math.min(a + 900, segment.end), t => profile.add(t));
      }
    }
    profile.complete(profile.start);
    return profile;
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.expiry) clearTimeout(this.expiry);
    await this.backfill.stop();
    await this.vpHistory.stop();
    this.aggregate.expire(Date.now() * 1000);
    if (this.seam !== null && this.tradeBatch.length) {
      const batch = this.tradeBatch; this.tradeBatch = [];
      this.track(this.store.addTrades(batch));
    }
    await Promise.all(this.pending);
    await this.store.flush();
    this.log("storage_stopped", { ...this.status(), root: path.relative(process.cwd(), this.store.root) });
  }
}
