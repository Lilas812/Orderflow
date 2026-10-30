import { setTimeout as delay } from "node:timers/promises";
import { LongAggregate } from "./aggregate.ts";
import { contractAt } from "./fill.ts";
import { parts, shiftDate, atET } from "./calendar.ts";
import { dayAt, dayBounds, datesBetween, edgeDifference, mergeAggregates, nextFinalizeUs, serializeDay, tradingDate } from "./day.ts";
import type { DayData, RollData } from "./day.ts";
import type { LongSource, Roll } from "./rest.ts";
import { LongObjects } from "./objects.ts";
import { historyProgress, readTradeRange } from "../vp/trade-history.ts";
import type { LocalStore } from "../store/local.ts";
import type { HistorySource } from "../history/client.ts";
import type { Metrics } from "../ingest/metrics.ts";
import type { Trade } from "../types.ts";
import type { Log } from "../logger.ts";
import { validContract, UNKNOWN_CONTRACT } from "../../../lib/market/instruments.ts";

export const productionAccumulation = (env: NodeJS.ProcessEnv) => env.REPLIT_DEPLOYMENT === "1";
export const accumulationEnabled = (env: NodeJS.ProcessEnv) =>
  productionAccumulation(env) || env.LONG_VP_DEV_ENABLE === "1";
const WEEK_US = 7 * 86400e6;
export interface LongDependencies {
  repository: LongObjects; store: LocalStore; history: HistorySource; metrics: Metrics;
  metadata: Pick<LongSource, "roll"> & { readonly currentContract?: string | null };
  nextSeq(): number; log: Log; now?(): number;
  ready?(signal: AbortSignal): Promise<void>;
  schedule?: { now(): number; wait(ms: number, signal: AbortSignal): Promise<void> };
}
/** App Storage implementation. The legacy PostgreSQL service is intentionally not instantiated. */
export class AppLongVp {
  readonly repository: LongObjects;
  private deps: LongDependencies;
  private abort = new AbortController();
  private job: Promise<void> | null = null;
  private pollJob: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private stopped = false;
  private timeline: Roll[] = [];
  private rollRows: RollData[] = [];
  private pendingRoll: { old: Roll; next: Roll } | null = null;
  private todayDate: string | null = null;
  private todayBase = new LongAggregate();
  private todayLive = new LongAggregate();
  private todayGaps: [number, number][] = [];
  private todayReady = false;
  private restoreCutoffUs = 0;
  private restoreCutoffSeq = 0;
  private lastFinalizedUs = 0;
  private prepared: { date: string; upToUs: number; aggregate: LongAggregate; gaps: [number, number][] } | null = null;
  private state = "idle";
  private error: string | null = null;
  private rollError: string | null = null;
  private progress = { totalDays: 0, processedDays: 0, date: null as string | null };
  private history = historyProgress();
  private retryAtUs: number | null = null;
  private failures = 0;
  constructor(deps: LongDependencies) { this.deps = deps; this.repository = deps.repository; }
  private get gc() { return this.repository.symbol === "GC"; }
  private contract(t: Trade) {
    return this.gc ? (validContract(t.contract, "GC") ? t.contract : contractAt(t.tsUs, this.timeline) ?? UNKNOWN_CONTRACT)
      : contractAt(t.tsUs, this.timeline);
  }
  private now() { return this.deps.now?.() ?? Date.now() * 1000; }
  snapshot() {
    const dates = [...this.repository.records].filter(([, r]) => r.complete).map(([d]) => d).sort();
    return { enabled: true, state: this.state, bootstrap: { ...this.progress },
      finalized: { count: dates.length, from: dates[0] ?? null, to: dates.at(-1) ?? null },
      incomplete: [...this.repository.records].filter(([, r]) => !r.complete).map(([date, r]) => ({ date, gaps: r.gaps })),
      rolls: this.rollRows.length, pendingRoll: this.pendingRoll, rollError: this.rollError,
      nextBatchUs: nextFinalizeUs(this.now()), nextRetryAtUs: this.retryAtUs, cache: this.repository.snapshot(),
      today: { date: this.todayDate, ready: this.todayReady, ...this.todayBase.snapshot(),
        liveTrades: this.todayLive.count }, history: this.history, error: this.error };
  }
  start() {
    if (this.job || this.timer || this.stopped) return;
    this.launch();
    this.timer = setInterval(() => {
      if (this.stopped) return;
      if (this.initialized && !this.pollJob) {
        this.pollJob = this.refreshMetadata().catch(() => {
          if (!this.stopped) this.rollError = "longvp_metadata_refresh_failed";
        }).finally(() => { this.pollJob = null; });
      }
      const date = dayAt(this.now());
      const due = parts(this.now()).date;
      const boundary = atET(due, 18, 5);
      const prepareDue = tradingDate(due) && this.now() >= atET(due, 17) && this.now() < boundary
        && this.prepared?.date !== due;
      const retryReady = this.retryAtUs === null || this.now() >= this.retryAtUs;
      if (!this.job && retryReady && ((this.retryAtUs !== null) || !this.initialized || date !== this.todayDate
        || prepareDue || (this.now() >= boundary && boundary > this.lastFinalizedUs))) this.launch();
    }, 60000);
  }
  private launch() {
    this.job = this.run().catch(error => {
      if (!this.stopped) {
        this.state = "failed";
        this.error = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
          ? error.message : "longvp_failed";
        this.deps.log("long_vp_failed", { reason: this.error });
        this.retryAtUs = this.now() + Math.min(900, 60 * 2 ** Math.min(this.failures++, 4)) * 1e6;
      }
    }).finally(() => { this.job = null; });
  }
  async settled() { await this.job; }
  private async refreshMetadata() {
    const next = await this.deps.metadata.roll(this.abort.signal);
    if (this.gc && next.contract === UNKNOWN_CONTRACT) {
      this.timeline = [next]; this.pendingRoll = null; this.rollError = "unknown_contract_since"; return;
    }
    if (next.sinceUs > this.now()) throw Error("longvp_future_contract");
    const old = this.timeline.at(-1);
    if (!old) this.timeline.push(next);
    else if (old.contract === next.contract) {
      old.sinceUs = Math.min(old.sinceUs, next.sinceUs);
    } else {
      if (next.sinceUs <= old.sinceUs) throw Error("longvp_contract_rollback");
      this.timeline.push(next);
      this.pendingRoll = old.contract === UNKNOWN_CONTRACT ? null : { old, next };
      this.rollError = "roll_edge_pending";
    }
    if (this.pendingRoll) {
      try {
        const { old: previous, next: current } = this.pendingRoll;
        if (current.sinceUs < this.now() - WEEK_US) throw Error("roll_edge_outside_seven_days");
        // Only persisted, matured data; no independent tick client or extra upstream.
        const start = Math.floor(current.sinceUs / 1e6) - 300;
        const end = Math.ceil(current.sinceUs / 1e6) + 300;
        let before: Trade | null = null, after: Trade | null = null;
        const state = await this.range(start, end, t => {
          if (t.tsUs < current.sinceUs && (!before || t.tsUs >= before.tsUs)) before = t;
          if (t.tsUs >= current.sinceUs && (!after || t.tsUs < after.tsUs)) after = t;
        });
        if (state.gaps.length) throw Error("roll_edge_gap");
        const row = edgeDifference(previous.contract, current.contract, current.sinceUs, before, after);
        row.detail.fromSinceUs = previous.sinceUs;
        const rows = [...this.rollRows.filter(r => r.atSec !== row.atSec), row].sort((a, b) => a.atSec - b.atSec);
        await this.repository.saveRolls(rows, this.abort.signal);
        this.rollRows = rows; this.pendingRoll = null; this.rollError = null;
        this.deps.log("long_vp_roll_saved", row);
      } catch (error) {
        this.abort.signal.throwIfAborted();
        this.rollError = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
          ? error.message : "roll_edge_unavailable";
      }
    } else this.rollError = null;
  }
  private range(start: number, end: number, visit: (t: Trade) => void) {
    this.history = historyProgress();
    return readTradeRange({ store: this.deps.store, source: this.deps.history, metrics: this.deps.metrics,
      nextSeq: this.deps.nextSeq, signal: this.abort.signal, start, end, visit,
      state: this.history, schedule: this.deps.schedule });
  }
  private async build(date: string, endUs: number, cutoffRecvUs = Infinity, cutoffSeq = Infinity) {
    const a = new LongAggregate(), bounds = dayBounds(date);
    const first = Math.max(bounds.startUs, Math.ceil((this.now() - WEEK_US) / 1e6) * 1e6);
    const gaps: [number, number][] = [];
    if (first > bounds.startUs) gaps.push([bounds.startUs / 1e6, Math.min(first, endUs) / 1e6]);
    const state = first < endUs ? await this.range(first / 1e6, endUs / 1e6, t => {
      if (t.recvUs > cutoffRecvUs || (t.recvUs === cutoffRecvUs && t.seq >= cutoffSeq)) return;
      const contract = this.contract(t);
      if (contract) a.add(t, contract);
    }) : historyProgress();
    gaps.push(...state.gaps.map(g => [g.startSec, g.endSec] as [number, number]));
    // Unknown contract intervals are gaps even if there were no prints.
    const verifiedStart = this.timeline[0]?.sinceUs ?? endUs;
    if (!this.gc && verifiedStart > first && first < endUs)
      gaps.push([first / 1e6, Math.min(verifiedStart, endUs) / 1e6]);
    return { aggregate: a, gaps: union(gaps.filter(([x, y]) => x < y)) };
  }
  private resetToday(date: string | null) {
    this.todayDate = date; this.todayBase = new LongAggregate(); this.todayLive = new LongAggregate();
    this.todayGaps = []; this.todayReady = false;
    this.restoreCutoffUs = this.now();
    this.restoreCutoffSeq = this.deps.nextSeq();
  }
  trade(t: Trade) {
    if (this.stopped) return;
    const date = dayAt(this.now());
    if (date !== this.todayDate) this.resetToday(date);
    if (!date || dayAt(t.tsUs) !== date || t.seq < this.restoreCutoffSeq) return;
    const contract = this.contract(t);
    if (contract) this.todayLive.add(t, contract);
    else this.rollError = "unverified_live_contract";
  }
  today(): DayData | null {
    if (!this.todayDate || !this.todayReady) return null;
    return serializeDay(this.todayDate, mergeAggregates(this.todayBase, this.todayLive),
      this.timeline, this.todayGaps, this.now(), true, this.gc);
  }
  rolls() { return this.rollRows; }
  frontContract(): string | null {
    const c = this.deps.metadata.currentContract;
    return validContract(c, this.gc ? "GC" : "NQ") ? c : null;
  }
  async run() {
    this.state = "running"; this.error = null;
    if (!this.initialized) {
      await this.repository.initialize();
      this.rollRows = await this.repository.rolls();
      for (const r of this.rollRows) {
        if (r.detail.fromSinceUs !== undefined) this.timeline.push({ contract: r.from, sinceUs: r.detail.fromSinceUs });
        this.timeline.push({ contract: r.to, sinceUs: Math.round(r.atSec * 1e6) });
      }
      for (const record of this.gc ? [] : this.repository.records.values()) for (const c of record.contracts) {
        this.timeline.push({ contract: c.contract, sinceUs: Math.round(c.fromSec * 1e6) });
      }
      this.timeline = this.timeline.filter((r, i, rows) => !rows.some((v, j) => j < i && v.sinceUs === r.sinceUs))
        .sort((a, b) => a.sinceUs - b.sinceUs);
      this.timeline = this.timeline.filter((r, i, rows) => i === 0 || rows[i - 1].contract !== r.contract);
      await this.refreshMetadata();
      await this.deps.ready?.(this.abort.signal);
      this.initialized = true;
    } else await this.refreshMetadata();
    const date = dayAt(this.now());
    if (date !== this.todayDate || !this.todayReady) {
      this.resetToday(date);
      if (date) {
        const target = this.todayDate, cutoff = this.restoreCutoffUs, sequence = this.restoreCutoffSeq;
        const end = Math.min(dayBounds(date).endUs, Math.ceil(cutoff / 1e6) * 1e6);
        const built = await this.build(date, end, cutoff, sequence);
        if (this.todayDate === target) {
          this.todayBase = built.aggregate; this.todayGaps = built.gaps; this.todayReady = true;
        }
      }
    }
    const current = this.now(), from = parts(current - WEEK_US).date, to = parts(current).date;
    if (date && current >= atET(date, 17) && current < atET(date, 18, 5) && this.prepared?.date !== date) {
      const upToUs = Math.min(dayBounds(date).endUs, Math.floor(current / 1e6 - 300) * 1e6);
      const built = await this.build(date, upToUs);
      this.prepared = { date, upToUs, ...built };
      this.deps.log("long_vp_day_prepared", { date, upToUs, gaps: built.gaps, trades: built.aggregate.count });
    }
    const dates = datesBetween(from, to).filter(d => dayBounds(d).endUs + 300e6 <= current);
    this.progress = { totalDays: dates.length, processedDays: 0, date: null };
    for (const date of dates) {
      this.abort.signal.throwIfAborted();
      this.progress.date = date;
      if (!this.repository.records.get(date)?.complete) {
        const start = performance.now(), prepared = this.prepared?.date === date ? this.prepared : null;
        let built: { aggregate: LongAggregate; gaps: [number, number][] };
        if (prepared && !prepared.gaps.length) {
          const tail = new LongAggregate();
          const state = await this.range(prepared.upToUs / 1e6, dayBounds(date).endUs / 1e6, t => {
            const contract = this.contract(t);
            if (contract) tail.add(t, contract);
          });
          built = { aggregate: mergeAggregates(prepared.aggregate, tail),
            gaps: state.gaps.map(g => [g.startSec, g.endSec]) };
        } else built = await this.build(date, dayBounds(date).endUs);
        const data = serializeDay(date, built.aggregate, this.timeline, built.gaps, this.now(), false, this.gc);
        const old = this.repository.records.has(date) ? await this.repository.day(date) : null;
        if (!old || improvesDay(old, data)) {
          const size = await this.repository.save(data, this.abort.signal);
          this.deps.log("long_vp_day_saved", { date, complete: data.complete, gaps: data.gaps,
            trades: built.aggregate.count, ...size, elapsedMs: performance.now() - start,
            rss: process.memoryUsage().rss });
          if (this.prepared?.date === date) this.prepared = null;
        } else this.deps.log("long_vp_day_preserved", { date, reason: "rebuild_would_lose_coverage_or_volume" });
      }
      this.progress.processedDays++;
      await delay(0, undefined, { signal: this.abort.signal });
    }
    this.lastFinalizedUs = current;
    this.progress.date = null; this.state = "waiting";
    this.retryAtUs = null; this.failures = 0;
    this.deps.log("long_vp_batch_finished", this.snapshot());
  }
  async stop() {
    this.stopped = true; this.state = "stopped"; this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.job, this.pollJob]);
  }
}
export function union(gaps: [number, number][]) {
  const result: [number, number][] = [];
  for (const [a, b] of gaps.sort((x, y) => x[0] - y[0])) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else result.push([a, b]);
  }
  return result;
}
export function improvesDay(old: DayData, next: DayData) {
  if (next.gaps.some(([a, b]) => !old.gaps.some(([x, y]) => x <= a && b <= y))) return false;
  const key = (d: DayData, r: DayData["vp30m"][number]) => `${r[0]}:${r[1]}:${d.contracts[r[4]].contract}`;
  const rows = new Map(next.vp30m.map(r => [key(next, r), r]));
  return old.vp30m.every(r => {
    const n = rows.get(key(old, r));
    return n !== undefined && n[2] >= r[2] && n[3] >= r[3] && (n[5] ?? 0) >= (r[5] ?? 0);
  });
}
