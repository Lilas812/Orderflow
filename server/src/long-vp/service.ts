import { setTimeout as delay } from "node:timers/promises";
import type { Trade } from "../types.ts";
import type { Log } from "../logger.ts";
import { LongAggregate } from "./aggregate.ts";
import { batchDate, nextBatchUs, session, sessionAt, shiftDate, ZONE } from "./calendar.ts";
import { contractAt, fill, mergeCoverage, missing } from "./fill.ts";
import type { LongSource, Roll } from "./rest.ts";
import type { Gap, LongStore, SessionRecord } from "./store.ts";

const WEEK_US = 7 * 86400_000_000;
export const productionAccumulation = (env: NodeJS.ProcessEnv) => env.REPLIT_DEPLOYMENT === "1";
export class LongVpService {
  private source: LongSource;
  private store: LongStore;
  private log: Log;
  private now: () => number;
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private job: Promise<void> | null = null;
  private records = new Map<string, SessionRecord>();
  private rolls: Roll[] = [];
  private provisional = new LongAggregate();
  private provisionalDate: string | null = null;
  private liveCutoffUs = 0;
  private stopped = false;
  private state: "idle" | "running" | "waiting" | "blocked" | "stopped" = "idle";
  private error: string | null = null;
  private progress: { date: string; startUs: number; endUs: number; gap: boolean } | null = null;
  private ignoredLive = 0;
  private completedBatchDate: string | null = null;
  constructor(source: LongSource, store: LongStore, log: Log, now = () => Date.now() * 1000) {
    this.source = source; this.store = store; this.log = log; this.now = now;
  }
  start() {
    this.liveCutoffUs = Math.floor(this.now() / 1e6) * 1e6;
    this.provisionalDate = sessionAt(this.now())?.date ?? null;
    this.launch(true);
  }
  /** A failed batch waits for the next daily schedule, rather than polling the database. */
  private launch(initial: boolean) {
    if (this.stopped || this.job) return;
    this.job = this.run(initial).catch(() => {
      if (!this.stopped) {
        this.state = "blocked"; this.error ??= "long_vp_batch_failed";
        this.log("long_vp_batch_failed", { reason: this.error });
      }
    }).finally(() => {
      this.job = null;
      if (!this.stopped) {
        const catchUp = this.state === "waiting" && this.completedBatchDate !== null
          && batchDate(this.now()) > this.completedBatchDate;
        const ms = catchUp ? 1 : Math.max(1, (nextBatchUs(this.now()) - this.now()) / 1000);
        this.timer = setTimeout(() => this.launch(false), ms);
      }
    });
  }
  async settled() { await this.job; }
  async run(initial = false) {
    this.state = "running"; this.error = null;
    const signal = this.abort.signal;
    try {
      const now = this.now();
      const existing = await this.store.records();
      this.records = new Map(existing.map(r => [r.date, r]));
      this.rolls = await this.store.rolls();
      const roll = await this.source.roll(signal);
      const previous = this.rolls.find(r => r.sinceUs === roll.sinceUs);
      if (roll.sinceUs > now || (previous && previous.contract !== roll.contract)
        || this.rolls.some(r => r.sinceUs > roll.sinceUs)) throw Error("unverified_contract_metadata");
      if (!previous) this.rolls.push(roll);
      this.log("long_vp_contract", { ...roll });
      // Round forward, not backward: a rolling seven-day REST window must never be silently clamped.
      const cutoff = Math.ceil((now - WEEK_US) / 1e6) * 1e6;
      const lastDate = batchDate(now);
      for (let date = shiftDate(lastDate, -7); date <= lastDate; date = shiftDate(date, 1)) {
        signal.throwIfAborted();
        const s = session(date), old = this.records.get(date);
        if (s.endUs <= cutoff || old?.complete) continue;
        const aggregate = old ? await this.store.load(date) : new LongAggregate();
        aggregate.count = old?.trades ?? 0;
        const coverage = old?.coverage ?? [];
        const ranges = missing(Math.max(s.startUs, cutoff), s.endUs, coverage);
        const fetched = await fill(this.source, aggregate, ranges, this.rolls, signal, (r, gap) => {
          this.progress = { date, ...r, gap: !!gap };
          this.log(gap ? "long_vp_gap" : "long_vp_window", { date, ...r, ...(gap ? { reason: gap.reason } : {}) });
        });
        const combined = mergeCoverage([...coverage, ...fetched.coverage]);
        const gaps: Gap[] = missing(s.startUs, s.endUs, combined).map(r => ({
          ...r, reason: r.endUs <= cutoff ? "expired_before_7_days"
            : fetched.gaps.find(g => g.startUs < r.endUs && g.endUs > r.startUs)?.reason ?? "unavailable",
        }));
        const record: SessionRecord = { ...s, complete: gaps.length === 0, coverage: combined, gaps,
          trades: aggregate.count, updatedUs: this.now() };
        signal.throwIfAborted();
        await this.store.save(record, aggregate, this.rolls);
        this.records.set(date, record);
        this.log("long_vp_session_saved", { date, complete: record.complete, gaps, ...aggregate.snapshot() });
      }
      if (initial) await this.bootstrapProvisional();
      this.completedBatchDate = lastDate;
      this.state = "waiting";
      this.log("long_vp_batch_done", { nextBatchUs: nextBatchUs(this.now()), sessions: this.records.size });
    } catch (e) {
      if (!this.stopped) {
        this.state = "blocked";
        this.error = e instanceof Error && /^(long_rest_|unverified_contract)/.test(e.message)
          ? e.message : "long_vp_batch_failed";
      }
      throw e;
    }
  }
  private async bootstrapProvisional() {
    const s = sessionAt(this.now()), date = this.provisionalDate;
    if (!s || s.date !== date || this.liveCutoffUs <= s.startUs) return;
    const waitMs = (this.liveCutoffUs + 300_000_000 - this.now()) / 1000;
    if (waitMs > 0) await delay(waitMs, undefined, { signal: this.abort.signal });
    if (sessionAt(this.now())?.date !== date || this.provisionalDate !== date) return;
    const result = await fill(this.source, this.provisional,
      [{ startUs: s.startUs, endUs: this.liveCutoffUs }], this.rolls, this.abort.signal,
      (r, gap) => { if (gap) this.log("long_vp_provisional_gap", { ...r, reason: gap.reason }); });
    this.log("long_vp_provisional_ready", { date, gaps: result.gaps, seamUs: this.liveCutoffUs,
      seamIncomplete: true, ...this.provisional.snapshot() });
  }
  trade(t: Trade) {
    if (this.stopped) return;
    const s = sessionAt(t.tsUs);
    // Old/out-of-order session ticks must not reset the current provisional cache.
    const current = sessionAt(this.now());
    if (!s || s.date !== current?.date) { this.ignoredLive++; return; }
    if (s.date !== this.provisionalDate) {
      this.provisionalDate = s.date; this.provisional = new LongAggregate();
      this.liveCutoffUs = s.startUs;
    }
    const contract = contractAt(t.tsUs, this.rolls);
    if (!contract || t.tsUs < this.liveCutoffUs) { this.ignoredLive++; return; }
    this.provisional.add(t, contract);
  }
  snapshot() {
    return { enabled: true, state: this.state, error: this.error, timezone: ZONE, dailyTime: "17:10",
      nextBatchUs: this.stopped ? null : nextBatchUs(this.now()), progress: this.progress,
      contracts: this.rolls, sessions: [...this.records.values()].map(r => ({
        ...r, gaps: r.gaps.map(g => ({ ...g, recoverable: g.endUs > this.now() - WEEK_US })),
      })),
      provisional: { date: this.provisionalDate, authoritative: false, seamIncomplete: true,
        ignoredLive: this.ignoredLive, ...this.provisional.snapshot() } };
  }
  async stop() {
    this.stopped = true; this.state = "stopped";
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
    // Do not wait for a DB network timeout inside the receiver's existing 10-second shutdown budget.
    void this.job?.finally(() => this.store.close()).catch(() => {});
    if (!this.job) await this.store.close();
  }
}
