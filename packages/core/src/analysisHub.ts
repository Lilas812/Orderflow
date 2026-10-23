import {
  validateMarketEvent, validateDataQualityInterval, validateEventHeader,
  type MarketEvent, type DataQualityInterval, type EventHeader,
} from "./events";
import {
  createMarketQualityState, ingestMarketEvent, ingestMbpBatch, markChannelCondition,
  currentMbpBook, type MarketQualityConfig, type MarketQualityState, type QualityChannel,
} from "./qualityTimeline";
import {
  createTradeStore, ingestTrade, withTradeQuality, tradeScopeKey,
  type TradeStore, type TradeIngestResult,
} from "./tradeStore";
import type { DepthHistory, DepthRecord } from "./timeWeightedDepth";
import type { MbpBook } from "./mbpBook";

/** All limits are required, per finite MOCK scope. No defaults or eviction.
 * normalizedBytes is cumulative UTF-8 JSON input payload, NOT heap/RSS usage.
 * Reducer candidates and defensive read copies also consume temporary memory.
 */
export interface AnalysisBudget {
  readonly inputs: number;
  readonly normalizedBytes: number;
  readonly depthRecords: number;
  readonly depthEvents: number;
  readonly trades: number;
  readonly rawDeliveries: number;
  readonly qualityNotifications: number;
  readonly qualityIntervals: number;
  readonly dedupEntries: number;
  readonly bookLevels: number;
}
export interface AnalysisScope {
  readonly config: MarketQualityConfig;
  readonly startNs: string;
  readonly budget: AnalysisBudget;
  /** Null means unknown, not receive-time == exchange-time. */
  readonly depthTimeAlignmentEvidence: string | null;
  readonly tradeTimeAlignmentEvidence: string | null;
}
export type AnalysisInput =
  | { readonly type: "EVENT"; readonly event: MarketEvent }
  | { readonly type: "BATCH"; readonly events: readonly MarketEvent[] }
  | { readonly type: "CONDITION"; readonly channel: QualityChannel; readonly atNs: string;
      readonly status: "GAP" | "STALE" | "RESYNCING" | "CLOSED" | "OUTSIDE_DEPTH";
      readonly reason: string }
  | { readonly type: "QUALITY_INTERVAL"; readonly interval: DataQualityInterval;
      readonly observedAtNs: string };
export interface AnalysisCounts {
  /** Envelope counts: one complete atomic batch is one input. */
  readonly inputs: number;
  readonly accepted: number;
  readonly duplicate: number;
  readonly rejected: number;
}
export interface AnalysisUsage extends AnalysisBudget {}
export interface AnalysisStop {
  readonly reason: string;
  readonly limit: keyof AnalysisBudget;
  readonly maximum: number;
  readonly attempted: number;
}
export interface AnalysisView {
  readonly label: "MOCK / SIMULATED";
  readonly scope: AnalysisScope;
  readonly revision: number;
  /** Counts every attempted envelope, including rejected/stopped inputs. No durable cursor. */
  readonly inputCursor: number;
  readonly persistenceCursor: null;
  readonly counts: AnalysisCounts;
  readonly usage: AnalysisUsage;
  readonly status: "RUNNING" | "STOPPED";
  readonly stop: AnalysisStop | null;
  readonly qualityState: MarketQualityState;
  readonly book: MbpBook | null;
  readonly tradeStore: TradeStore;
  /** Original explicit observation evidence, including when clock mapping is unknown.
   * Effective TradeStore quality is conservative after any unrecovered Trade failure.
   */
  readonly tradeQualityEvidence: readonly DataQualityInterval[];
  readonly depthRecords: readonly DepthRecord[];
  /** Only offered with explicit event/quality clock alignment. */
  readonly depthHistory: DepthHistory | null;
}
export interface AnalysisDecision {
  readonly revision: number;
  readonly disposition: "ACCEPTED" | "DUPLICATE" | "REJECTED";
  readonly outcome: string;
  readonly reason: string;
  readonly eventCount: number;
  readonly tradeDisposition: TradeIngestResult["disposition"] | null;
  readonly counts: AnalysisCounts;
  readonly stop: AnalysisStop | null;
}

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new TypeError(reason);
}
function ns(value: string): void {
  ensure(typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value), "Invalid UTC ns");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
// Copy Maps as well as objects: callers cannot mutate private reducer state even
// by casting a public ReadonlyMap to Map. Copies are owned by the reader.
function copy<T>(value: T): T {
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, copy(v)])) as T;
  if (Array.isArray(value)) return Object.freeze(value.map(copy)) as T;
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, copy(v)]),
  )) as T;
  return value;
}
/** No TextEncoder/Node/browser dependency. Count UTF-8 of the normalized JSON. */
export function analysisInputBytes(input: AnalysisInput): number {
  const text = JSON.stringify(input);
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
const budgetKeys: readonly (keyof AnalysisBudget)[] = [
  "inputs", "normalizedBytes", "depthRecords", "depthEvents", "trades", "rawDeliveries",
  "qualityNotifications", "qualityIntervals", "dedupEntries", "bookLevels",
];

/**
 * One exact identity per instance; multiple sources/contracts/sessions require
 * independent instances. Synchronous RAM-only boundary, no storage imports,
 * COMMIT, React, transport, implicit timers, or process-global mutable selector.
 */
export function createAnalysisHub(definition: AnalysisScope, monotonicNowMs: () => number) {
  const scope = freeze(JSON.parse(JSON.stringify(definition)) as AnalysisScope);
  ensure(scope.config.identity.environment === "MOCK" &&
    scope.config.identity.source === "MOCK_DETERMINISTIC", "Only normalized MOCK is allowed");
  for (const key of budgetKeys) ensure(Number.isSafeInteger(scope.budget[key]) &&
    scope.budget[key] >= 0, `Finite nonnegative budget required: ${key}`);
  for (const evidence of [scope.depthTimeAlignmentEvidence, scope.tradeTimeAlignmentEvidence]) {
    ensure(evidence === null || typeof evidence === "string" && !!evidence.trim(),
      "Alignment must be explicit evidence or null");
  }
  const header: EventHeader = {
    ...scope.config.identity, schemaVersion: 1, channel: "TRADES",
    exchangeTimeNs: null, receiveTimeNs: scope.startNs, sourceTimePrecision: "unknown",
    sequenceScope: scope.config.rules.TRADES.scope, sequence: null,
    eventId: "MOCK-ANALYSIS-INITIALIZATION", quality: "VALID",
  };
  validateEventHeader(header);
  let quality = createMarketQualityState(scope.config, scope.startNs);
  let store = createTradeStore(header);
  let depth: readonly DepthRecord[] = [];
  let evidence: readonly DataQualityInterval[] = [];
  let counts: AnalysisCounts = { inputs: 0, accepted: 0, duplicate: 0, rejected: 0 };
  let usage: AnalysisUsage = Object.fromEntries(budgetKeys.map(k => [k, 0])) as unknown as AnalysisUsage;
  usage = { ...usage, qualityIntervals: 3 };
  ensure(scope.budget.qualityIntervals >= 3, "Budget must cover initial quality intervals");
  let stop: AnalysisStop | null = null;
  let revision = 0;
  let lastPoll: number | null = null;
  let lastNotification: number | null = null;
  let published = 0;

  function view(): AnalysisView {
    const state = copy(quality);
    const records = copy(depth);
    return Object.freeze({
      label: "MOCK / SIMULATED", scope, revision, inputCursor: counts.inputs,
      persistenceCursor: null, counts: copy(counts), usage: copy(usage),
      status: stop ? "STOPPED" : "RUNNING", stop: copy(stop), qualityState: state,
      book: stop ? null : currentMbpBook(state), tradeStore: copy(store),
      tradeQualityEvidence: copy(evidence), depthRecords: records,
      depthHistory: scope.depthTimeAlignmentEvidence === null ? null : Object.freeze({
        events: records, qualityState: state,
        qualityTimeAlignmentEvidence: scope.depthTimeAlignmentEvidence,
      }),
    });
  }
  function overflow(next: AnalysisUsage): AnalysisStop | null {
    for (const key of budgetKeys) if (next[key] > scope.budget[key]) return {
      limit: key, maximum: scope.budget[key], attempted: next[key],
      reason: `Finite MOCK budget exceeded: ${key}`,
    };
    return null;
  }
  function ingest(input: AnalysisInput): AnalysisDecision {
    let disposition: AnalysisDecision["disposition"] = "REJECTED";
    let outcome = "STOPPED", reason = stop?.reason ?? "Rejected input";
    let tradeDisposition: AnalysisDecision["tradeDisposition"] = null;
    let eventCount = 0;
    ensure(Number.isSafeInteger(counts.inputs + 1) && Number.isSafeInteger(revision + 1),
      "Analysis cursor/revision exhausted");
    if (!stop) {
      // Detect payload/input overflow before validation/reducer allocation.
      let pending = { ...usage, inputs: usage.inputs + 1 };
      try {
        pending = { ...pending,
          normalizedBytes: usage.normalizedBytes + analysisInputBytes(input) };
        stop = overflow(pending);
        if (!stop) {
          const value = freeze(JSON.parse(JSON.stringify(input)) as AnalysisInput);
          ensure(["EVENT", "BATCH", "CONDITION", "QUALITY_INTERVAL"].includes(value.type),
            "Unsupported analysis input");
          const events = value.type === "EVENT" ? [value.event] : value.type === "BATCH" ? value.events : [];
          ensure(Array.isArray(events), "Expected events array");
          eventCount = events.length;
          if (value.type === "BATCH") ensure(events.length > 0, "Complete nonempty batch required");
          for (const event of events) {
            validateMarketEvent(event);
            ensure(tradeScopeKey(event.header) === tradeScopeKey(scope.config.identity),
              "Foreign source/symbol/contract/session or non-MOCK identity");
            ensure(event.kind !== "L1_QUOTE", "Analysis accepts L2 and Trades only");
            if (event.header.channel === "L2_MBP") ensure(event.header.exchangeTimeNs !== null &&
              event.header.sourceTimePrecision !== "unknown", "Depth requires explicit event time/precision");
          }
          let nextQuality = quality, nextStore = store, nextDepth = depth, nextEvidence = evidence;
          let applied = false, duplicate = false;
          if (value.type === "EVENT" || value.type === "BATCH") {
            if (value.type === "BATCH") {
              const h = events[0].header;
              ensure(events.every(e => (e.kind === "L2_SET_LEVEL" || e.kind === "L2_DELETE_LEVEL") &&
                e.header.exchangeTimeNs === h.exchangeTimeNs && e.header.receiveTimeNs === h.receiveTimeNs),
              "Complete L2 batch requires one event/detection time");
            }
            const result = value.type === "BATCH" ? ingestMbpBatch(quality, events) :
              ingestMarketEvent(quality, events[0]);
            nextQuality = result.state;
            applied = result.applied; duplicate = result.outcome === "DUPLICATE";
            outcome = result.outcome; reason = result.reason;
            const event = events[0];
            if (event.kind === "TRADE" || event.kind === "TRADE_CANCEL" || event.kind === "TRADE_CORRECTION") {
              if (applied || duplicate) {
                const trade = ingestTrade(store, event);
                nextStore = trade.store; tradeDisposition = trade.disposition;
                duplicate ||= trade.disposition === "DUPLICATE";
                applied &&= trade.disposition === "ACCEPTED";
              }
              if (event.kind !== "TRADE" || tradeDisposition === "CONFLICTING_TRADE_ID") {
                outcome = event.kind !== "TRADE" ? "UNSUPPORTED_REVISION" : "CONFLICTING_TRADE_ID";
                reason = "Audit only; no conflicting Trade or correction/cancel application";
                applied = false; duplicate = false;
                nextQuality = markChannelCondition(nextQuality, "TRADES", "GAP",
                  event.header.receiveTimeNs, outcome);
              }
            } else if (applied) {
              nextDepth = [...depth, value.type === "BATCH"
                ? { batch: events as readonly import("./events").L2PriceUpdate[] }
                : event as DepthRecord];
            }
          } else if (value.type === "CONDITION") {
            nextQuality = markChannelCondition(quality, value.channel, value.status, value.atNs, value.reason);
            applied = true; outcome = "CONDITION"; reason = value.reason;
          } else {
            const q = validateDataQualityInterval(value.interval);
            ns(value.observedAtNs);
            ensure(BigInt(value.observedAtNs) >= BigInt(scope.startNs), "Observation precedes scope");
            // Preserve explicit Trade evidence; never derive VALID from R03 reception.
            if (q.channel === "TRADES") {
              nextEvidence = [...evidence, q];
              const checked = withTradeQuality(store, nextEvidence);
              nextStore = scope.tradeTimeAlignmentEvidence === null ? store : checked;
            }
            if (["GAP", "STALE", "CLOSED", "OUTSIDE_DEPTH"].includes(q.status)) {
              nextQuality = markChannelCondition(quality, q.channel,
                q.status as "GAP" | "STALE" | "CLOSED" | "OUTSIDE_DEPTH",
                value.observedAtNs, q.reason);
            }
            applied = true; outcome = "QUALITY_INTERVAL"; reason = q.reason;
          }
          // Any detected Trade gap invalidates downstream evidence conservatively.
          // Only later VALID metadata cannot restore the R03 channel or erase a gap.
          const tradeLane = nextQuality.timeline.TRADES.at(-1)!;
          if ((tradeLane.status !== "VALID" && tradeLane.status !== "NOT_INITIALIZED" ||
              tradeLane.status === "VALID" && tradeLane.sequenceVerification !== "CONTIGUOUS" ||
              nextStore.trades.some(t => t.header.sourceTimePrecision === "unknown")) &&
              nextStore.quality.some(q => q.status === "VALID")) {
            nextStore = withTradeQuality(nextStore, nextEvidence.map(q =>
              q.status === "VALID" ? { ...q, status: "GAP" as const,
                reason: "Trade channel invalid; explicit evidence is insufficient for recovery" } : q));
          }
          pending = {
            ...pending, depthRecords: nextDepth.length,
            depthEvents: nextDepth.reduce((n, r) => n + ("batch" in r ? r.batch.length : 1), 0),
            trades: nextStore.trades.length, rawDeliveries: nextStore.rawEvents.length,
            qualityNotifications: usage.qualityNotifications +
              (value.type === "CONDITION" || value.type === "QUALITY_INTERVAL" ? 1 : 0),
            qualityIntervals: Object.values(nextQuality.timeline).reduce((n, a) => n + a.length, 0) +
              nextEvidence.length,
            dedupEntries: nextQuality.guard.seen.size + nextStore.trades.length,
            bookLevels: nextQuality.lastGoodBook.bids.size + nextQuality.lastGoodBook.asks.size,
          };
          stop = overflow(pending);
          if (!stop) {
            quality = nextQuality; store = nextStore; depth = nextDepth; evidence = nextEvidence;
            disposition = applied ? "ACCEPTED" : duplicate ? "DUPLICATE" : "REJECTED";
          }
        }
        if (stop) { outcome = "BUDGET_EXCEEDED"; reason = stop.reason; tradeDisposition = null; }
      } catch (error) {
        outcome = "INVALID_INPUT"; reason = error instanceof Error ? error.message : "Invalid input";
        tradeDisposition = null;
        // Failed validation does not install a partially computed reducer candidate.
        pending = { ...usage, inputs: pending.inputs, normalizedBytes: pending.normalizedBytes };
      }
      if (!stop) usage = pending;
    }
    counts = { inputs: counts.inputs + 1,
      accepted: counts.accepted + (disposition === "ACCEPTED" ? 1 : 0),
      duplicate: counts.duplicate + (disposition === "DUPLICATE" ? 1 : 0),
      rejected: counts.rejected + (disposition === "REJECTED" ? 1 : 0) };
    revision++;
    return freeze({ revision, disposition, outcome, reason, eventCount, tradeDisposition, counts, stop });
  }
  /** Caller-controlled notification pump: data application never waits for it.
   * First dirty poll publishes immediately; later publications are >=250ms apart.
   * No subscription callbacks/reentrancy and no wall-clock or automatic timer.
   */
  function pollNotification(): AnalysisView | null {
    const now = monotonicNowMs();
    ensure(Number.isFinite(now) && (lastPoll === null || now >= lastPoll), "Clock must be monotonic");
    lastPoll = now;
    if (revision === published || lastNotification !== null && now - lastNotification < 250) return null;
    published = revision; lastNotification = now;
    return view();
  }
  return Object.freeze({ ingest, read: view, pollNotification });
}
