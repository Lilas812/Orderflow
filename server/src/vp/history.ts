import { setTimeout as delay } from "node:timers/promises";
import { VolumeProfile } from "./state.ts";
import { historyTrades, inWindow } from "../history/decode.ts";
import { WindowUnavailableError } from "../history/client.ts";
import type { HistorySource } from "../history/client.ts";
import type { LocalStore } from "../store/local.ts";
import type { Metrics } from "../ingest/metrics.ts";
import type { Log } from "../logger.ts";

export function coverageSegments(ranges: readonly [number, number][], start: number, end: number) {
  const result: { start: number; end: number; covered: boolean }[] = [];
  for (let a = start; a < end;) {
    const covered = ranges.some(([x, y]) => x <= a && a < y);
    const boundaries = ranges.flat().filter(x => x > a && x < end);
    const b = Math.min(end, ...boundaries);
    result.push({ start: a, end: b, covered }); a = b;
  }
  return result;
}

export class VpHistory {
  readonly state = {
    state: "waiting" as "waiting" | "running" | "complete" | "failed" | "stopped",
    startSec: null as number | null, endSec: null as number | null,
    startedAtUs: null as number | null, finishedAtUs: null as number | null,
    elapsedMs: 0, fileSeconds: 0, apiSeconds: 0, fileReadMs: 0, apiMs: 0,
    fileWindows: 0, apiWindows: 0, splitRequests: 0, emptyRetries: 0,
    importedTrades: 0, pendingMaturityUntilUs: null as number | null,
    gaps: [] as { startSec: number; endSec: number; reason: string }[],
    noData: [] as { startSec: number; endSec: number; attempts: number }[],
    lastError: null as string | null,
  };
  private abort = new AbortController();
  private task: Promise<void> | null = null;
  private profile: VolumeProfile;
  private source: HistorySource;
  private store: LocalStore;
  private metrics: Metrics;
  private nextSeq: () => number;
  private log: Log;
  private schedule: { now(): number; wait(ms: number, signal: AbortSignal): Promise<void> };
  constructor(profile: VolumeProfile, source: HistorySource, store: LocalStore,
    metrics: Metrics, nextSeq: () => number, log: Log,
    schedule = { now: Date.now, wait: async (ms: number, signal: AbortSignal) => { await delay(ms, undefined, { signal }); } }) {
    this.profile = profile; this.source = source; this.store = store; this.metrics = metrics;
    this.nextSeq = nextSeq; this.log = log; this.schedule = schedule;
  }
  start(L: number, preceding: Promise<void>) {
    if (this.task) return;
    this.task = preceding.then(() => this.run(L));
  }
  snapshot() {
    return { ...this.state, elapsedMs: this.state.state === "running"
      ? this.schedule.now() - this.state.startedAtUs! / 1000 : this.state.elapsedMs,
    gaps: this.state.gaps.map(g => ({ ...g })), noData: this.state.noData.map(g => ({ ...g })) };
  }
  private async take(start: number, end: number, retry = 0): Promise<void> {
    this.abort.signal.throwIfAborted();
    const wait = (end + 300) * 1000 - this.schedule.now();
    if (wait > 0) {
      this.state.pendingMaturityUntilUs = (end + 300) * 1e6;
      await this.schedule.wait(wait, this.abort.signal);
      this.state.pendingMaturityUntilUs = null;
    }
    let response;
    const before = this.schedule.now();
    try {
      this.state.apiWindows++;
      response = await this.source.get("tick", start, end, this.abort.signal);
    } catch (error) {
      if (!(error instanceof WindowUnavailableError)) throw error;
      const gap = { startSec: start, endSec: end, reason: error.reason };
      this.state.gaps.push(gap); this.log("vp_history_gap", gap); return;
    } finally { this.state.apiMs += this.schedule.now() - before; }
    if (response.truncated) {
      if (end - start <= 1) {
        const gap = { startSec: start, endSec: end, reason: "truncated_at_one_second" };
        this.state.gaps.push(gap); this.log("vp_history_gap", gap); return;
      }
      this.state.splitRequests++;
      const middle = start + Math.floor((end - start) / 2);
      await this.take(start, middle); await this.take(middle, end); return;
    }
    if (!response.rows.some(r => inWindow(r, start, end))) {
      if ((retry > 0 || end >= this.schedule.now() / 1000 - 600) && retry < 3) {
        this.state.emptyRetries++;
        await this.schedule.wait(120000, this.abort.signal);
        return this.take(start, end, retry + 1);
      }
      this.state.noData.push({ startSec: start, endSec: end, attempts: retry + 1 });
    }
    const trades = historyTrades(response.rows, start, end, this.metrics, this.nextSeq);
    // Replace only the previously uncovered interval. Partial old files must not
    // cause duplicate rows after fetching that interval again.
    await this.store.replaceTradeRange(start, end, trades);
    for (const trade of trades) this.profile.add(trade);
    this.state.importedTrades += trades.length; this.state.apiSeconds += end - start;
    this.log("vp_history_window", { startSec: start, endSec: end, trades: trades.length, retry });
  }
  private async run(L: number) {
    const start = this.profile.start;
    Object.assign(this.state, { state: "running", startSec: start, endSec: L,
      startedAtUs: this.schedule.now() * 1000 });
    this.log("vp_history_started", this.snapshot());
    try {
      this.abort.signal.throwIfAborted();
      const coverage = await this.store.recordedTickCoverage();
      for (const segment of coverageSegments(coverage, start, L)) {
        for (let a = segment.start; a < segment.end; a += 900) {
          this.abort.signal.throwIfAborted();
          const b = Math.min(a + 900, segment.end);
          if (segment.covered) {
            const before = this.schedule.now();
            await this.store.visitTrades(a, b, trade => {
              this.profile.add(trade); this.state.importedTrades++;
            });
            this.state.fileReadMs += this.schedule.now() - before;
            this.state.fileWindows++; this.state.fileSeconds += b - a;
          } else await this.take(a, b);
        }
      }
      this.state.state = "complete";
      this.profile.complete(start);
    } catch (error) {
      this.state.state = this.abort.signal.aborted ? "stopped" : "failed";
      this.state.lastError = this.abort.signal.aborted ? "shutdown"
        : error instanceof Error ? error.message : "vp_history_failed";
      // Unexpected/storage errors remain visibly loading/failed, not a false success.
    } finally {
      this.state.finishedAtUs = this.schedule.now() * 1000;
      this.state.elapsedMs = (this.state.finishedAtUs - this.state.startedAtUs!) / 1000;
      this.log("vp_history_finished", this.snapshot());
    }
  }
  async stop() { this.abort.abort(); await this.task; }
  async settled() { await this.task; }
}
