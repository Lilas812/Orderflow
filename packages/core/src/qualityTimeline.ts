import {
  validateMarketEvent, type BookSide, type DataQualityStatus, type DepthScope,
  type EventHeader, type L2PriceUpdate,
} from "./events";
import {
  applyMbpBatch, applyMbpEvent, createMbpBook, readMbpLevel,
  type LevelObservation, type MbpBook,
} from "./mbpBook";
import {
  createSequenceGuard, guardEvent, rebaseSequenceGuard,
  type ContinuityRule, type GuardResult, type SequenceGuard, type SequenceVerification,
} from "./sequenceGuard";

export type QualityChannel = "L1" | "L2_MBP" | "TRADES";
// R03 extends quality without changing R01's persisted event schema/validator.
export type QualityStatus = DataQualityStatus | "RESYNCING";
export interface QualityInterval {
  readonly channel: QualityChannel;
  readonly startNs: string;
  readonly endNs: string | null;
  readonly status: QualityStatus;
  readonly reason: string;
  readonly sequenceVerification: SequenceVerification;
}
export type QualityTimeline = Readonly<Record<QualityChannel, readonly QualityInterval[]>>;
const channels: readonly QualityChannel[] = ["L1", "L2_MBP", "TRADES"];

function requireQuality(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new TypeError(reason);
}
function ns(time: string): bigint {
  requireQuality(typeof time === "string" && /^-?(0|[1-9]\d*)$/.test(time), "Invalid UTC ns string");
  return BigInt(time);
}
function checkChannel(channel: QualityChannel): void {
  requireQuality(channels.includes(channel), "Unsupported quality channel");
}

export function createQualityTimeline(startNs: string): QualityTimeline {
  ns(startNs);
  const entry = (channel: QualityChannel): readonly QualityInterval[] => [{
    channel, startNs, endNs: null, status: "NOT_INITIALIZED",
    reason: "No valid initial event", sequenceVerification: "NOT_CHECKED",
  }];
  return { L1: entry("L1"), L2_MBP: entry("L2_MBP"), TRADES: entry("TRADES") };
}

export function currentQuality(timeline: QualityTimeline, channel: QualityChannel): QualityInterval {
  checkChannel(channel);
  return timeline[channel][timeline[channel].length - 1];
}

/** Detection/notification time (UTC ns), not an invented missing-event exchange time. */
export function transitionQuality(
  timeline: QualityTimeline, channel: QualityChannel, status: QualityStatus,
  atNs: string, reason: string, verification?: SequenceVerification,
): QualityTimeline {
  checkChannel(channel);
  requireQuality(["NOT_INITIALIZED", "VALID", "GAP", "STALE", "RESYNCING", "CLOSED", "OUTSIDE_DEPTH"]
    .includes(status), "Invalid quality status");
  requireQuality(typeof reason === "string" && reason.trim().length > 0, "Quality reason is required");
  const previous = currentQuality(timeline, channel);
  requireQuality(ns(atNs) >= ns(previous.startNs), "Quality transitions cannot move backwards");
  const nextVerification = verification ?? previous.sequenceVerification;
  requireQuality(["NOT_CHECKED", "CONTIGUOUS", "ORDER_ONLY", "UNVERIFIABLE"]
    .includes(nextVerification), "Invalid sequence verification state");
  if (previous.status === status && previous.reason === reason &&
      previous.sequenceVerification === nextVerification) return timeline;
  // Preserve even simultaneous transitions as zero-length markers; never rewrite a past GAP.
  const intervals = [...timeline[channel].slice(0, -1), { ...previous, endNs: atNs }, {
    channel, startNs: atNs, endNs: null, status, reason, sequenceVerification: nextVerification,
  }];
  return { ...timeline, [channel]: intervals };
}

export type MarketIdentity = Pick<EventHeader,
  "environment" | "source" | "sourceId" | "canonicalInstrumentId" | "sessionId">;
export interface ChannelRule {
  readonly scope: EventHeader["sequenceScope"];
  readonly continuity: ContinuityRule;
}
export interface MarketQualityConfig {
  readonly identity: MarketIdentity;
  readonly depthScope: DepthScope;
  readonly rules: Readonly<Record<QualityChannel, ChannelRule>>;
  /** Evidence for the supported header-sequence == covered-sequence alignment. */
  readonly snapshotAlignmentEvidence: string;
}
export interface MarketQualityState {
  readonly config: MarketQualityConfig;
  readonly timeline: QualityTimeline;
  readonly guard: SequenceGuard;
  /** Historical diagnostic state only. Always use currentMbpBook/readCurrentMbpLevel for publication. */
  readonly lastGoodBook: MbpBook;
}
export interface MarketResult {
  readonly state: MarketQualityState;
  readonly applied: boolean;
  readonly outcome: string;
  readonly reason: string;
}

export function createMarketQualityState(config: MarketQualityConfig, startNs: string): MarketQualityState {
  // Clone config so caller changes cannot change the contract of an existing state.
  const copy = JSON.parse(JSON.stringify(config)) as MarketQualityConfig;
  return { config: copy, timeline: createQualityTimeline(startNs),
    guard: createSequenceGuard(), lastGoodBook: createMbpBook() };
}

function matches(state: MarketQualityState, header: EventHeader): boolean {
  const id = state.config.identity;
  return (["environment", "source", "sourceId", "canonicalInstrumentId", "sessionId"] as const)
    .every((field) => id[field] === header[field]);
}
function matchingDepth(a: DepthScope, b: DepthScope): boolean {
  return a.type === b.type && (a.type === "FULL" ||
    (a.type === "TOP_N" && b.type === "TOP_N" && a.n === b.n) ||
    (a.type === "PRICE_RANGE" && b.type === "PRICE_RANGE" &&
      a.minTick === b.minTick && a.maxTick === b.maxTick));
}
function result(state: MarketQualityState, applied: boolean, outcome: string, reason: string): MarketResult {
  return { state, applied, outcome, reason };
}

/** Notifications never restore validity, and affect only the specified channel. */
export function markChannelCondition(
  state: MarketQualityState, channel: QualityChannel,
  status: "GAP" | "STALE" | "RESYNCING" | "CLOSED" | "OUTSIDE_DEPTH",
  atNs: string, reason: string,
): MarketQualityState {
  requireQuality(["GAP", "STALE", "RESYNCING", "CLOSED", "OUTSIDE_DEPTH"].includes(status),
    "Notifications cannot restore VALID");
  return { ...state, timeline: transitionQuality(state.timeline, channel, status, atNs, reason) };
}

function rejectGuard(
  state: MarketQualityState, guard: GuardResult, channel: QualityChannel, atNs: string,
): MarketResult {
  const next = { ...state, guard: guard.state };
  if (guard.outcome === "DUPLICATE") return result(next, false, guard.outcome, guard.reason);
  return result({
    ...next, timeline: transitionQuality(next.timeline, channel, "GAP", atNs,
      guard.reason, guard.verification),
  }, false, guard.outcome, guard.reason);
}

/** A matching, new, covering snapshot is the only L2 recovery path. */
export function resynchronizeMbp(state: MarketQualityState, input: unknown): MarketResult {
  // Malformed raw input throws before altering the immutable state.
  const event = validateMarketEvent(input);
  if (event.kind !== "L2_SNAPSHOT" || !matches(state, event.header)) {
    return result(state, false, "RESYNC_REJECTED", "Snapshot identity does not match subscription");
  }
  const failed = (outcome: string, reason: string, verification: SequenceVerification): MarketResult => {
    const current = currentQuality(state.timeline, "L2_MBP");
    const status = outcome === "CONFLICT" || current.status === "GAP" ? "GAP" : "RESYNCING";
    return result({ ...state, timeline: transitionQuality(state.timeline, "L2_MBP", status,
      event.header.receiveTimeNs, reason, verification) }, false, outcome, reason);
  };
  if (event.header.sequenceScope !== state.config.rules.L2_MBP.scope ||
      !matchingDepth(event.depthScope, state.config.depthScope)) {
    return failed("RESYNC_REJECTED", "Snapshot scope/depth does not match subscription", "UNVERIFIABLE");
  }
  const sync = rebaseSequenceGuard(state.guard, event,
    state.config.rules.L2_MBP.continuity, state.config.snapshotAlignmentEvidence);
  if (!sync.apply) {
    if (sync.outcome === "DUPLICATE") return result(state, false, sync.outcome, sync.reason);
    return failed(sync.outcome, sync.reason, sync.verification);
  }
  let book: MbpBook;
  try {
    // Reuse R02 snapshot validation, including duplicate levels and depth consistency.
    book = applyMbpEvent(state.lastGoodBook, event);
  } catch (error) {
    return failed("RESYNC_REJECTED",
      error instanceof Error ? error.message : "Invalid snapshot", sync.verification);
  }
  const timeline = transitionQuality(state.timeline, "L2_MBP", "VALID",
    event.header.receiveTimeNs, "Snapshot synchronized", sync.verification);
  return result({ ...state, guard: sync.state, timeline, lastGoodBook: book },
    true, "ACCEPTED", sync.reason);
}

export function ingestMarketEvent(state: MarketQualityState, input: unknown): MarketResult {
  const event = validateMarketEvent(input);
  requireQuality(event.header.channel !== "MBO", "MBO is outside R03");
  if (!matches(state, event.header)) return result(state, false, "IDENTITY_MISMATCH", "Foreign market identity");
  const channel = event.header.channel as QualityChannel;
  const rule = state.config.rules[channel];
  if (event.header.sequenceScope !== rule.scope) {
    return result({ ...state, timeline: transitionQuality(state.timeline, channel, "GAP",
      event.header.receiveTimeNs, "Sequence scope differs from configured partition", "UNVERIFIABLE") },
    false, "SCOPE_MISMATCH", "Sequence scope differs from configured partition");
  }
  if (event.kind === "L2_SNAPSHOT") return resynchronizeMbp(state, event);
  if (event.kind === "L2_SET_LEVEL" || event.kind === "L2_DELETE_LEVEL") {
    requireQuality(event.updateBatchId === undefined, "Complete tagged batches require ingestMbpBatch");
    return ingestMbpBatch(state, [event]);
  }
  const guarded = guardEvent(state.guard, event, rule.continuity);
  if (!guarded.apply) return rejectGuard(state, guarded, channel, event.header.receiveTimeNs);
  if (event.header.quality !== "VALID") {
    return result({ ...state, guard: guarded.state,
      timeline: transitionQuality(state.timeline, channel, "GAP", event.header.receiveTimeNs,
        "Event quality is not VALID", guarded.verification) },
    false, "QUALITY_REJECTED", "Event quality is not VALID");
  }
  const current = currentQuality(state.timeline, channel);
  if (current.status !== "NOT_INITIALIZED" && current.status !== "VALID") {
    return result({ ...state, guard: guarded.state }, false, "RECOVERY_REQUIRED",
      "Invalid channel is not restored by an ordinary event");
  }
  return result({ ...state, guard: guarded.state,
    timeline: transitionQuality(state.timeline, channel, "VALID", event.header.receiveTimeNs,
      guarded.reason, guarded.verification) }, true, guarded.outcome, guarded.reason);
}

/** One complete logical batch, fully validated before guard/book changes are published. */
export function ingestMbpBatch(state: MarketQualityState, inputs: readonly unknown[]): MarketResult {
  requireQuality(Array.isArray(inputs) && inputs.length > 0, "A complete nonempty batch is required");
  const updates: L2PriceUpdate[] = inputs.map((input) => {
    const event = validateMarketEvent(input);
    requireQuality(event.kind === "L2_SET_LEVEL" || event.kind === "L2_DELETE_LEVEL", "L2 updates required");
    return event;
  });
  for (const event of updates) {
    if (!matches(state, event.header)) return result(state, false, "IDENTITY_MISMATCH", "Foreign market identity");
    if (event.header.sequenceScope !== state.config.rules.L2_MBP.scope) {
      return result({ ...state, timeline: transitionQuality(state.timeline, "L2_MBP", "GAP",
        event.header.receiveTimeNs, "Foreign sequence scope", "UNVERIFIABLE") },
      false, "SCOPE_MISMATCH", "Foreign sequence scope");
    }
  }
  const atNs = updates[updates.length - 1].header.receiveTimeNs;
  let guard = state.guard;
  let last: GuardResult | undefined;
  let duplicateCount = 0;
  const accepted: L2PriceUpdate[] = [];
  for (const event of updates) {
    const checked = guardEvent(guard, event, state.config.rules.L2_MBP.continuity);
    guard = checked.state;
    if (checked.outcome === "DUPLICATE") { duplicateCount++; continue; }
    if (!checked.apply) return rejectGuard(state, checked, "L2_MBP", atNs);
    if (event.header.quality !== "VALID") {
      return result({ ...state, guard, timeline: transitionQuality(state.timeline, "L2_MBP", "GAP",
        atNs, "Event quality is not VALID", checked.verification) },
      false, "QUALITY_REJECTED", "Event quality is not VALID");
    }
    accepted.push(event);
    last = checked;
  }
  if (!last) return result(state, false, "DUPLICATE", "All events already seen");
  if (duplicateCount > 0) {
    return result({ ...state, guard, timeline: transitionQuality(state.timeline, "L2_MBP", "GAP", atNs,
      "Partially duplicated logical batch requires resynchronization", last.verification) },
    false, "BATCH_REJECTED", "Cannot apply a partial duplicate batch");
  }
  if (currentQuality(state.timeline, "L2_MBP").status !== "VALID") {
    return result({ ...state, guard }, false, "RECOVERY_REQUIRED", "A synchronized snapshot is required");
  }
  let book: MbpBook;
  try {
    book = applyMbpBatch(state.lastGoodBook, accepted);
  } catch (error) {
    return result({ ...state, guard, timeline: transitionQuality(state.timeline, "L2_MBP", "GAP", atNs,
      "MBP batch validation failed", last.verification) },
    false, "BATCH_REJECTED", error instanceof Error ? error.message : "Invalid MBP batch");
  }
  return result({ ...state, guard, lastGoodBook: book,
    timeline: transitionQuality(state.timeline, "L2_MBP", "VALID", atNs,
      "Contiguous L2 updates accepted", last.verification) }, true, "ACCEPTED", "Complete batch applied");
}

export function currentMbpBook(state: MarketQualityState): MbpBook | null {
  const quality = currentQuality(state.timeline, "L2_MBP");
  return quality.status === "VALID" && quality.sequenceVerification === "CONTIGUOUS" &&
    state.lastGoodBook.status === "READY" ? state.lastGoodBook : null;
}

export function readCurrentMbpLevel(
  state: MarketQualityState, side: BookSide, priceTicks: number,
): LevelObservation | { readonly status: Exclude<QualityStatus, "VALID">; readonly qty: null } {
  const book = currentMbpBook(state);
  if (book) return readMbpLevel(book, side, priceTicks);
  const status = currentQuality(state.timeline, "L2_MBP").status;
  return { status: status === "VALID" ? "RESYNCING" : status, qty: null };
}
