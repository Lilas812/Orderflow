import { setTimeout as delay } from "node:timers/promises";
import { VolumeProfile } from "./state.ts";
import type { HistorySource } from "../history/client.ts";
import type { LocalStore } from "../store/local.ts";
import type { Metrics } from "../ingest/metrics.ts";
import type { Log } from "../logger.ts";
import { readTradeRange } from "./trade-history.ts";
export { coverageSegments } from "./trade-history.ts";

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
  private async run(L: number) {
    const start = this.profile.start;
    Object.assign(this.state, { state: "running", startSec: start, endSec: L,
      startedAtUs: this.schedule.now() * 1000 });
    this.log("vp_history_started", this.snapshot());
    try {
      this.abort.signal.throwIfAborted();
      await readTradeRange({ store: this.store, source: this.source, metrics: this.metrics,
        nextSeq: this.nextSeq, start, end: L, signal: this.abort.signal,
        visit: trade => this.profile.add(trade), state: this.state, schedule: this.schedule });
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
