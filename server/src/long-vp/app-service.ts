import { setTimeout as delay } from "node:timers/promises";
import { LongAggregate } from "./aggregate.ts";
import { contractAt } from "./fill.ts";
import { parts, shiftDate, atET } from "./calendar.ts";
import { dayAt, dayBounds, datesBetween, edgeDifference, mergeAggregates, nextFinalizeUs, serializeDay, tradingDate } from "./day.ts";
import type { DayData, RollData } from "./day.ts";
import type { LongSource, Roll } from "./rest.ts";
import { LongObjects } from "./objects.ts";
import { coverageSegments, historyProgress, readTradeRange, readRecordedTradeRange } from "../vp/trade-history.ts";
import type { LocalStore } from "../store/local.ts";
import type { HistorySource } from "../history/client.ts";
import type { Metrics } from "../ingest/metrics.ts";
import type { Trade } from "../types.ts";
import type { Log } from "../logger.ts";
import { validContract, UNKNOWN_CONTRACT } from "../../../lib/market/instruments.ts";
import { LongVpDiagnostics } from "./diagnostics.ts";
import { exceptionDetails } from "../logger.ts";
export { improvesDay } from "./day.ts";

export const productionAccumulation = (env: NodeJS.ProcessEnv) => env.REPLIT_DEPLOYMENT === "1";
export const accumulationEnabled = (env: NodeJS.ProcessEnv) =>
  productionAccumulation(env) || env.LONG_VP_DEV_ENABLE === "1";
const WEEK_US = 7 * 86400e6;
export interface LongDependencies {
  repository: LongObjects; store: LocalStore; history: HistorySource; metrics: Metrics;
  metadata: Pick<LongSource, "roll"> & { readonly currentContract?: string | null };
  nextSeq(): number; log: Log; now?(): number;
  readyStatus?(): { seamReady: boolean; backfillState: string; vpHistoryState: string };
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
  private metadataEvidence: { contract: string; sinceUs: number; untilUs: number } | null = null;
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
  private checkpointJob: Promise<void> | null = null;
  private checkpointKey = "";
  private repositoryReady: Promise<void> | null = null;
  private diagnostics: LongVpDiagnostics;
  private checkpointDiagnostics: LongVpDiagnostics;
  constructor(deps: LongDependencies) {
    this.deps = deps; this.repository = deps.repository;
    this.diagnostics = new LongVpDiagnostics(this.repository.symbol, deps.log, () => ({
      ...deps.readyStatus?.(), fileWindows: this.history.fileWindows, apiWindows: this.history.apiWindows,
      importedTrades: this.history.importedTrades, gapCount: this.history.gaps.length,
      pendingMaturityUntilUs: this.history.pendingMaturityUntilUs,
    }));
    this.checkpointDiagnostics = new LongVpDiagnostics(this.repository.symbol, deps.log,
      () => ({ mode: "recorded_only" }));
  }
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
    this.launchCheckpoint();
    this.launch();
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.diagnostics.waiting();
      this.checkpointDiagnostics.waiting();
      if (!this.checkpointJob && this.checkpointBoundary() !== this.checkpointKey) this.launchCheckpoint();
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
        this.deps.log("long_vp_failed", { reason: this.error, error: exceptionDetails(error) });
        this.retryAtUs = this.now() + Math.min(900, 60 * 2 ** Math.min(this.failures++, 4)) * 1e6;
      }
    }).finally(() => { this.job = null; });
  }
  async settled() { await Promise.all([this.job, this.checkpointJob]); }
  private initializeRepository() {
    if (!this.repositoryReady) this.repositoryReady = this.repository.initialize().catch(error => {
      this.repositoryReady = null; throw error;
    });
    return this.repositoryReady;
  }
  private checkpointBoundary() {
    const now = this.now(), date = parts(now).date;
    const evidence = this.metadataEvidence;
    const verified = evidence
      ? `${evidence.contract}:${evidence.sinceUs}:${dayAt(evidence.untilUs)}` : "unconfirmed";
    return `${date}:${now >= atET(date, 18, 5) ? "final" : now >= atET(date, 17, 55) ? "cutoff" : "startup"}:${verified}`;
  }
  private launchCheckpoint() {
    this.checkpointJob = this.checkpoint().catch(error => {
      if (!this.stopped) this.deps.log("long_vp_failed", {
        reason: "daily_checkpoint_failed", error: exceptionDetails(error), mode: "recorded_only" });
    }).finally(() => { this.checkpointJob = null; });
  }
  /** Independent of network-history jobs and their store queue, including at CT16:55. */
  async checkpoint() {
    const key = this.checkpointBoundary();
    await this.checkpointDiagnostics.run(async () => {
      const diag = this.checkpointDiagnostics;
      await diag.stage("repository_initialize", {}, () => this.initializeRepository());
      const now = this.now(), to = parts(now).date;
      const dates = datesBetween(parts(now - WEEK_US).date, to).filter(date =>
        dayBounds(date).endUs + 300e6 <= now || (date === to && now >= atET(to, 17, 55)));
      for (const date of dates.reverse()) {
        this.abort.signal.throwIfAborted();
        if (this.repository.records.get(date)?.complete) continue;
        const bounds = dayBounds(date), end = Math.min(bounds.endUs, Math.floor(now / 1e6) * 1e6);
        const built = await this.build(date, end, Infinity, Infinity, true, diag);
        const gaps = [...built.gaps];
        if (end < bounds.endUs) gaps.push([end / 1e6, bounds.endUs / 1e6]);
        else if (this.now() < bounds.endUs + 300e6) gaps.push([bounds.endUs / 1e6 - 300, bounds.endUs / 1e6]);
        const data = serializeDay(date, built.aggregate, this.timeline, union(gaps), this.now(),
          false, this.gc, built.contracts);
        const result = await diag.stage("save", { date, mode: "recorded_only", complete: data.complete },
          () => this.repository.save(data, this.abort.signal));
        diag.note({ date, mode: "recorded_only", decision: "latest_cloud_improves_day",
          action: result.saved ? "save" : "preserve", generation: result.generation });
        this.deps.log(result.saved ? "long_vp_day_saved" : "long_vp_day_preserved",
          { date, mode: "recorded_only", complete: data.complete, gapCount: data.gaps.length,
            trades: built.aggregate.count, ...result });
      }
    });
    this.checkpointKey = key;
  }
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
    this.metadataEvidence = { contract: next.contract, sinceUs: next.sinceUs, untilUs: this.now() };
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
  private diagnosticMetadata() {
    return this.diagnostics.stage("metadata", {}, () => this.refreshMetadata(),
      () => ({ contractCount: this.timeline.length, rollError: this.rollError }));
  }
  private range(start: number, end: number, visit: (t: Trade) => void) {
    this.history = historyProgress();
    return readTradeRange({ store: this.deps.store, source: this.deps.history, metrics: this.deps.metrics,
      nextSeq: this.deps.nextSeq, signal: this.abort.signal, start, end, visit,
      state: this.history, schedule: this.deps.schedule });
  }
  private async build(date: string, endUs: number, cutoffRecvUs = Infinity, cutoffSeq = Infinity,
    recordedOnly = false, diag = this.diagnostics) {
    const bounds = dayBounds(date), first = Math.max(bounds.startUs, Math.ceil((this.now() - WEEK_US) / 1e6) * 1e6);
    const contracts = recordedOnly && !this.gc ? this.checkpointContracts(date, endUs) : undefined;
    return diag.stage("build", { date, startSec: bounds.startUs / 1e6,
      endSec: endUs / 1e6, fetchStartSec: first / 1e6 },
    () => this.buildRange(bounds, first, endUs, cutoffRecvUs, cutoffSeq, recordedOnly, contracts),
    result => ({ trades: result.aggregate.count, gapCount: result.gaps.length }));
  }
  /** Bounded evidence only: a saved day's final expiry must never extend into an unseen day. */
  private checkpointContracts(date: string, endUs: number): DayData["contracts"] {
    const bounds = dayBounds(date);
    const candidates = (this.repository.records.get(date)?.contracts ?? []).map(c => ({ ...c, priority: 0 }));
    for (const roll of this.rollRows) {
      if (roll.detail.fromSinceUs !== undefined) candidates.push({ contract: roll.from,
        fromSec: roll.detail.fromSinceUs / 1e6, toSec: roll.atSec, priority: 1 });
    }
    const evidence = this.metadataEvidence;
    if (evidence) candidates.push({ contract: evidence.contract, fromSec: evidence.sinceUs / 1e6,
      toSec: evidence.untilUs / 1e6, priority: 2 });
    const start = bounds.startUs / 1e6, end = endUs / 1e6;
    const clipped = candidates.map(c => ({ ...c, fromSec: Math.max(start, c.fromSec),
      toSec: Math.min(end, c.toSec) })).filter(c => c.fromSec < c.toSec);
    const edges = [...new Set([start, end, ...clipped.flatMap(c => [c.fromSec, c.toSec])])].sort((a, b) => a - b);
    const contracts: DayData["contracts"] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      const fromSec = edges[i], toSec = edges[i + 1];
      const candidate = clipped.filter(c => c.fromSec <= fromSec && c.toSec >= toSec)
        .sort((a, b) => b.priority - a.priority)[0];
      if (!candidate) continue;
      const last = contracts.at(-1);
      if (last?.contract === candidate.contract && last.toSec === fromSec) last.toSec = toSec;
      else contracts.push({ contract: candidate.contract, fromSec, toSec });
    }
    return contracts;
  }
  private async buildRange(bounds: ReturnType<typeof dayBounds>, first: number, endUs: number,
    cutoffRecvUs: number, cutoffSeq: number, recordedOnly: boolean, contracts?: DayData["contracts"]) {
    const a = new LongAggregate();
    const gaps: [number, number][] = [];
    if (first > bounds.startUs) gaps.push([bounds.startUs / 1e6, Math.min(first, endUs) / 1e6]);
    const visit = (t: Trade) => {
      if (t.recvUs > cutoffRecvUs || (t.recvUs === cutoffRecvUs && t.seq >= cutoffSeq)) return;
      const contract = contracts !== undefined
        ? contracts.find(c => c.fromSec <= t.tsUs / 1e6 && t.tsUs / 1e6 < c.toSec)?.contract
        : this.contract(t);
      if (contract) a.add(t, contract);
    };
    const state = first < endUs ? recordedOnly
      ? await readRecordedTradeRange({ store: this.deps.store, start: first / 1e6, end: endUs / 1e6,
        signal: this.abort.signal, visit })
      : await this.range(first / 1e6, endUs / 1e6, visit) : historyProgress();
    gaps.push(...state.gaps.map(g => [g.startSec, g.endSec] as [number, number]));
    // Unknown contract intervals are gaps even if there were no prints.
    const verifiedStart = this.timeline[0]?.sinceUs ?? endUs;
    if (contracts !== undefined) {
      for (const segment of coverageSegments(contracts.map(c => [c.fromSec, c.toSec]), first / 1e6, endUs / 1e6))
        if (!segment.covered) gaps.push([segment.start, segment.end]);
    } else if (!this.gc && verifiedStart > first && first < endUs)
      gaps.push([first / 1e6, Math.min(verifiedStart, endUs) / 1e6]);
    return { aggregate: a, gaps: union(gaps.filter(([x, y]) => x < y)), contracts };
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
    return this.diagnostics.run(() => this.runBatch());
  }
  private async runBatch() {
    this.state = "running"; this.error = null;
    if (!this.initialized) {
      await this.diagnostics.stage("repository_initialize", {}, () => this.initializeRepository(),
        () => ({ storedDays: this.repository.records.size }));
      this.rollRows = await this.diagnostics.stage("rolls_read", {}, () => this.repository.rolls(),
        rows => ({ rollCount: rows.length }));
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
      await this.diagnosticMetadata();
      this.initialized = true;
    } else await this.diagnosticMetadata();
    const date = dayAt(this.now());
    if (date !== this.todayDate || !this.todayReady) {
      this.resetToday(date);
      if (date) {
        const target = this.todayDate, cutoff = this.restoreCutoffUs, sequence = this.restoreCutoffSeq;
        const end = Math.min(dayBounds(date).endUs, Math.ceil(cutoff / 1e6) * 1e6);
        const built = await this.diagnostics.stage("today_restore", { date },
          () => this.build(date, end, cutoff, sequence));
        if (this.todayDate === target) {
          this.todayBase = built.aggregate; this.todayGaps = built.gaps; this.todayReady = true;
        }
      }
    }
    const current = this.now(), from = parts(current - WEEK_US).date, to = parts(current).date;
    if (date && current >= atET(date, 17) && current < atET(date, 18, 5) && this.prepared?.date !== date) {
      const upToUs = Math.min(dayBounds(date).endUs, Math.floor(current / 1e6 - 300) * 1e6);
      const built = await this.diagnostics.stage("day_prepare", { date }, () => this.build(date, upToUs));
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
          const state = await this.diagnostics.stage("prepared_tail", { date,
            startSec: prepared.upToUs / 1e6, endSec: dayBounds(date).endUs / 1e6 },
            () => this.range(prepared.upToUs / 1e6, dayBounds(date).endUs / 1e6, t => {
              const contract = this.contract(t);
              if (contract) tail.add(t, contract);
            }), result => ({ trades: tail.count, gapCount: result.gaps.length }));
          built = { aggregate: mergeAggregates(prepared.aggregate, tail),
            gaps: state.gaps.map(g => [g.startSec, g.endSec]) };
        } else built = await this.build(date, dayBounds(date).endUs);
        const data = serializeDay(date, built.aggregate, this.timeline, built.gaps, this.now(), false, this.gc);
        const size = await this.diagnostics.stage("save", { date, complete: data.complete },
          () => this.repository.save(data, this.abort.signal), result => ({ ...result }));
        this.diagnostics.note({ date, decision: "latest_cloud_improves_day",
          action: size.saved ? "save" : "preserve", generation: size.generation });
        if (size.saved) {
          this.deps.log("long_vp_day_saved", { date, complete: data.complete, gaps: data.gaps,
            trades: built.aggregate.count, ...size, elapsedMs: performance.now() - start,
            rss: process.memoryUsage().rss });
          if (this.prepared?.date === date) this.prepared = null;
        } else this.deps.log("long_vp_day_preserved", { date, reason: "rebuild_would_lose_coverage_or_volume" });
      } else this.diagnostics.note({ date, decision: "already_complete", action: "skip" });
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
    await Promise.allSettled([this.job, this.pollJob, this.checkpointJob]);
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
