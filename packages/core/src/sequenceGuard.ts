import { validateMarketEvent, type EventHeader, type L2Snapshot } from "./events";

export type SequenceVerification = "CONTIGUOUS" | "ORDER_ONLY" | "UNVERIFIABLE" | "NOT_CHECKED";
/** Guarantee refers to successive normalized events in THIS exact partition, not a vendor by default. */
export type ContinuityRule =
  | { readonly contiguous: false }
  | { readonly contiguous: true; readonly evidence: string };
export type GuardOutcome = "ACCEPTED" | "DUPLICATE" | "CONFLICT" | "OLD" | "GAP" | "UNVERIFIABLE";

interface SequenceHead {
  readonly lastSequence: string | null;
  readonly highWatermark: string | null;
  readonly exchangeTimeNs: string | null;
  readonly blocked: boolean;
}

export interface SequenceGuard {
  readonly heads: ReadonlyMap<string, SequenceHead>;
  readonly seen: ReadonlyMap<string, string>;
}

export interface GuardResult {
  readonly state: SequenceGuard;
  readonly outcome: GuardOutcome;
  readonly verification: SequenceVerification;
  readonly apply: boolean;
  readonly reason: string;
}

export function createSequenceGuard(): SequenceGuard {
  return { heads: new Map(), seen: new Map() };
}

export function sequencePartition(header: EventHeader): string {
  return JSON.stringify([
    header.environment, header.source, header.sourceId, header.canonicalInstrumentId,
    header.sessionId, header.channel, header.sequenceScope,
  ]);
}

// Event identity excludes sequenceScope: changing the scope of the same ID is a conflict.
function idKey(header: EventHeader): string {
  return JSON.stringify([
    header.environment, header.source, header.sourceId, header.canonicalInstrumentId,
    header.sessionId, header.channel, header.eventId,
  ]);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Event content must be JSON-compatible");
  return serialized;
}

function verification(header: EventHeader, rule: ContinuityRule): SequenceVerification {
  if (rule.contiguous && (typeof rule.evidence !== "string" || !rule.evidence.trim())) {
    throw new TypeError("A contiguous sequence guarantee requires evidence");
  }
  if (header.sequenceScope === "NONE" || header.sequence === null) return "UNVERIFIABLE";
  return rule.contiguous ? "CONTIGUOUS" : "ORDER_ONLY";
}

function newer(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  return b !== null && BigInt(b) > BigInt(a) ? b : a;
}

type Head = NonNullable<ReturnType<SequenceGuard["heads"]["get"]>>;
export interface _GuardReadPort {
  readonly heads: Pick<SequenceGuard["heads"], "get">;
  readonly seen: Pick<SequenceGuard["seen"], "get">;
}
export type _GuardDecision = Omit<GuardResult, "state"> & (
  { readonly change: "KEEP" } | { readonly change: "NEXT"; readonly partition: string;
    readonly head: Head; readonly insert: {key: string; fingerprint: string} | null });

/** Shared pure decision kernel: never copies or mutates a Map. @internal */
export function _planGuardEvent(
  state: _GuardReadPort, input: unknown, rule: ContinuityRule = { contiguous: false },
): _GuardDecision {
  const event = validateMarketEvent(input);
  const h = event.header;
  const v = verification(h, rule);
  const partition = sequencePartition(h);
  const previous = state.heads.get(partition);
  const key = idKey(h);
  const fingerprint = canonical(event);
  const saved = state.seen.get(key);
  const result = (outcome: GuardOutcome, apply: boolean, reason: string): _GuardDecision =>
    ({ change: "KEEP", outcome, apply, verification: v, reason });
  if (saved === fingerprint) return result("DUPLICATE", false, "Identical event ID and content");

  let outcome: GuardOutcome = "ACCEPTED";
  let reason = v === "CONTIGUOUS" ? "Contiguous sequence accepted" :
    v === "ORDER_ONLY" ? "Sequence order checked; continuity is not guaranteed" :
      "Sequence verification is unavailable";
  if (saved !== undefined) {
    outcome = "CONFLICT"; reason = "The same event ID has conflicting content";
  } else if (previous && h.sequence !== null && previous.highWatermark !== null &&
      BigInt(h.sequence) <= BigInt(previous.highWatermark)) {
    outcome = "OLD"; reason = "Sequence does not advance the observed high watermark";
  } else if (previous && h.exchangeTimeNs !== null && previous.exchangeTimeNs !== null &&
      BigInt(h.exchangeTimeNs) < BigInt(previous.exchangeTimeNs)) {
    outcome = "OLD"; reason = "Exchange time moved backwards; no reordering was authorized";
  } else if (previous?.blocked) {
    outcome = "GAP"; reason = "Partition requires explicit snapshot resynchronization";
  } else if (rule.contiguous && v === "UNVERIFIABLE") {
    outcome = "UNVERIFIABLE"; reason = "The declared continuity rule cannot verify this event";
  } else if (v === "CONTIGUOUS" && previous?.lastSequence !== null &&
      previous?.lastSequence !== undefined && BigInt(h.sequence!) !== BigInt(previous.lastSequence) + 1n) {
    outcome = "GAP"; reason = `Missing sequence after ${previous.lastSequence}; received ${h.sequence}`;
  }
  const apply = outcome === "ACCEPTED";
  const head: Head = {
    lastSequence: apply ? h.sequence : previous?.lastSequence ?? null,
    highWatermark: saved !== undefined ? previous?.highWatermark ?? null :
      newer(previous?.highWatermark ?? null, h.sequence),
    exchangeTimeNs: saved !== undefined ? previous?.exchangeTimeNs ?? null :
      newer(previous?.exchangeTimeNs ?? null, h.exchangeTimeNs),
    blocked: !apply,
  };
  return { change: "NEXT", partition, head,
    insert: saved === undefined ? { key, fingerprint } : null,
    outcome, apply, verification: v, reason };
}

/**
 * Supported alignment contract: header sequence == snapshotCoversSequence.
 * Caller must attest this rule separately; it is NOT assumed for real feeds.
 */
export function _planRebaseSequenceGuard(
  state: _GuardReadPort, input: unknown, rule: ContinuityRule, alignmentEvidence: string,
): _GuardDecision {
  const event = validateMarketEvent(input);
  if (event.kind !== "L2_SNAPSHOT") throw new TypeError("Resync requires an L2 snapshot");
  const snapshot: L2Snapshot = event;
  const h = snapshot.header;
  const v = verification(h, rule);
  const fail = (reason: string): _GuardDecision => ({
    change: "KEEP", outcome: "UNVERIFIABLE", apply: false, verification: v, reason,
  });
  if (!alignmentEvidence.trim() || v !== "CONTIGUOUS") {
    return fail("Resync needs explicit continuity and snapshot alignment evidence");
  }
  if (h.quality !== "VALID" || snapshot.snapshotCoversSequence === null ||
      h.sequence === null || BigInt(snapshot.snapshotCoversSequence) !== BigInt(h.sequence)) {
    return fail("Snapshot coverage does not match the declared sequence alignment rule");
  }
  const key = idKey(h);
  const fingerprint = canonical(snapshot);
  const saved = state.seen.get(key);
  if (saved !== undefined) {
    return { change: "KEEP", outcome: saved === fingerprint ? "DUPLICATE" : "CONFLICT", apply: false,
      verification: v, reason: "Snapshot must be new and must not conflict with an existing ID" };
  }
  const previous = state.heads.get(sequencePartition(h));
  if (previous?.highWatermark !== null && previous?.highWatermark !== undefined &&
      BigInt(snapshot.snapshotCoversSequence) < BigInt(previous.highWatermark)) {
    return fail("Snapshot does not cover the most recently observed sequence");
  }
  if (previous?.exchangeTimeNs !== null && previous?.exchangeTimeNs !== undefined &&
      (h.exchangeTimeNs === null || BigInt(h.exchangeTimeNs) < BigInt(previous.exchangeTimeNs))) {
    return fail("Snapshot precedes previously observed exchange time");
  }
  const head: Head = {
    lastSequence: snapshot.snapshotCoversSequence, highWatermark: snapshot.snapshotCoversSequence,
    exchangeTimeNs: h.exchangeTimeNs, blocked: false,
  };
  return { change: "NEXT", partition: sequencePartition(h), head, insert: { key, fingerprint },
    outcome: "ACCEPTED", apply: true,
    verification: v, reason: "Snapshot coverage and declared alignment verified" };
}

/** Public immutable adapter; retained independently of owned session storage. */
export function guardEvent(
  state: SequenceGuard, input: unknown, rule: ContinuityRule = { contiguous: false },
): GuardResult {
  const plan = _planGuardEvent(state, input, rule);
  if (plan.change === "KEEP") return { state, outcome: plan.outcome, apply: plan.apply,
    reason: plan.reason, verification: plan.verification };
  const heads = new Map(state.heads); heads.set(plan.partition, plan.head);
  const seen = new Map(state.seen);
  if (plan.insert) seen.set(plan.insert.key, plan.insert.fingerprint);
  return { state: { heads, seen }, outcome: plan.outcome, apply: plan.apply,
    reason: plan.reason, verification: plan.verification };
}
export function rebaseSequenceGuard(
  state: SequenceGuard, input: unknown, rule: ContinuityRule, alignmentEvidence: string,
): GuardResult {
  const plan = _planRebaseSequenceGuard(state, input, rule, alignmentEvidence);
  if (plan.change === "KEEP") return { state, outcome: plan.outcome, apply: plan.apply,
    reason: plan.reason, verification: plan.verification };
  const heads = new Map(state.heads); heads.set(plan.partition, plan.head);
  const seen = new Map(state.seen);
  if (plan.insert) seen.set(plan.insert.key, plan.insert.fingerprint);
  return { state: { heads, seen }, outcome: plan.outcome, apply: plan.apply,
    reason: plan.reason, verification: plan.verification };
}

