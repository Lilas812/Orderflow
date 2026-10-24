import { MAX_RECORD_BYTES, parseObservation, validateObservation, type ObservationRecord, type ReceiveContext } from "./liveObservation";

/**
 * Public-contract boundary, not a connected feed. In particular, root NQ is not
 * an individual contract and a received full image is not continuous L2 history.
 * Sources: /docs/authentication, /docs/streaming, /docs/level2.
 */
export const DOCUMENTED_FEED = Object.freeze({
  endpoint: "wss://stream.tick-stream.xyz/v1/stream",
  symbol: "NQ",
  authentication: "QUERY_KEY_ONLY",
  contractSelection: "AUTOMATIC_FRONT_MONTH",
  timestampUnit: "s",
  bookSemantics: "COALESCED_FULL_SNAPSHOT",
  maxDocumentedLevelsPerSide: 400,
  approximateMaxBookFramesPerSecond: 7,
  providerSequence: null,
  providerTradeId: null,
} as const);

export type Confirmation = "CONFIRMED" | "UNKNOWN" | "DENIED";
export interface AccessEvidence {
  readonly account: Confirmation;
  readonly realtimeL2Plan: Confirmation;
  readonly privateApplicationUse: Confirmation;
  readonly secretPresent: boolean;
}

/** No key, URL construction, network call or credential getter is needed here. */
export function reviewReadOnlyConnection(evidence: AccessEvidence) {
  if (!evidence || typeof evidence.secretPresent !== "boolean" ||
    ![evidence.account, evidence.realtimeL2Plan, evidence.privateApplicationUse]
      .every(v => ["CONFIRMED", "UNKNOWN", "DENIED"].includes(v)))
    throw new Error("INVALID_ACCESS_EVIDENCE");
  const reasons = ["QUERY_AUTH_FORBIDDEN_BY_TASK31"];
  if (evidence.account !== "CONFIRMED") reasons.push("ACCOUNT_NOT_CONFIRMED");
  if (evidence.realtimeL2Plan !== "CONFIRMED") reasons.push("REALTIME_L2_ENTITLEMENT_NOT_CONFIRMED");
  if (evidence.privateApplicationUse !== "CONFIRMED") reasons.push("PRIVATE_APPLICATION_USE_NOT_CONFIRMED");
  if (!evidence.secretPresent) reasons.push("SECRET_MISSING");
  return Object.freeze({ status: "BLOCKED" as const, canConnect: false as const,
    reasons: Object.freeze(reasons), canPersistMarketData: false as const });
}

export function subscriptionFrames(op: "subscribe" | "unsubscribe") {
  if (op !== "subscribe" && op !== "unsubscribe") throw new Error("INVALID_SUBSCRIPTION");
  return Object.freeze((["ticks", "book"] as const).map(channel =>
    Object.freeze({ op, channel, symbols: Object.freeze(["NQ"] as const) })));
}

/** Reuse the existing strict parser; do not invent exchange IDs or clock evidence. */
export function analysisAdmission(input: unknown) {
  const record = validateObservation(input);
  const reasons = ["INDIVIDUAL_CONTRACT_UNRESOLVED", "PROVIDER_SEQUENCE_UNAVAILABLE"];
  if (record.result.status === "REJECTED") reasons.push(record.result.reasonCode);
  else {
    const o = record.result.observation;
    if (o.kind === "BOOK_OBSERVATION") {
      if (o.timestampPrecision === "s") reasons.push("CORE_DEPTH_TIME_PRECISION_NOT_REPRESENTABLE");
      reasons.push("COALESCED_BOOK_NO_CONTINUOUS_COVERAGE");
      if (o.bidAskRelationship === "LOCKED" || o.bidAskRelationship === "CROSSED")
        reasons.push("LOCKED_OR_CROSSED_BOOK");
    } else reasons.push("EXACT_TRADE_ID_UNAVAILABLE", "TRADE_COMPLETENESS_UNKNOWN");
  }
  return Object.freeze({ status: "OBSERVATION_ONLY" as const, analysisInput: null,
    reasons: Object.freeze(reasons) });
}

export interface ObservationBudget {
  readonly maxFrames: number;
  readonly maxBytes: number;
}
export type WireContext = Omit<ReceiveContext, "origin" | "timestampUnit" | "receiveOrdinal">;

/**
 * Bounded RAM ingress for a future approved Node transport. Does not open a
 * socket, read credentials, persist data, fabricate coverage or call AnalysisHub.
 * Retains at most one complete book and one trade, never a second analysis store.
 */
export function createReadOnlyFeed(
  origin: ReceiveContext["origin"], budget: ObservationBudget,
) {
  if (!["SYNTHETIC_TEST", "ACTUAL_PROVIDER_RESPONSE"].includes(origin) ||
    !Number.isSafeInteger(budget.maxFrames) || budget.maxFrames < 1 || budget.maxFrames > 1000 ||
    !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1 || budget.maxBytes > 64 * 1024 * 1024)
    throw new Error("INVALID_FEED_BUDGET");
  // Copy caller-owned configuration before any ingress.
  const maxFrames = budget.maxFrames, maxBytes = budget.maxBytes;
  let generation = 1, frames = 0, bytes = 0, accepted = 0, rejected = 0;
  let closed = false, stopped: string | null = null;
  let book: ObservationRecord | null = null, trade: ObservationRecord | null = null;
  const reject = (reason: string) => {
    rejected++;
    return Object.freeze({ status: "REJECTED" as const, reason });
  };
  return Object.freeze({
    observe(raw: string | Uint8Array, context: WireContext) {
      if (closed || stopped) return Object.freeze({ status: "REJECTED" as const, reason: stopped ?? "CLOSED" });
      if (frames >= maxFrames) { stopped = "FINITE_FEED_BUDGET_EXCEEDED"; return reject(stopped); }
      if ((typeof raw === "string" && raw.length > MAX_RECORD_BYTES) ||
        (raw instanceof Uint8Array && raw.byteLength > MAX_RECORD_BYTES)) {
        frames++; return reject("FRAME_TOO_LARGE");
      }
      const size = typeof raw === "string" ? new TextEncoder().encode(raw).length :
        raw instanceof Uint8Array ? raw.byteLength : -1;
      if (size > maxBytes - bytes) {
        stopped = "FINITE_FEED_BUDGET_EXCEEDED"; return reject(stopped);
      }
      frames++;
      if (size > MAX_RECORD_BYTES) return reject("FRAME_TOO_LARGE");
      if (size < 0) return reject("INVALID_PAYLOAD_TYPE");
      bytes += size;
      if (!context) return reject("INVALID_RECEIVE_CONTEXT");
      if (context.connectionEpoch !== generation) return reject("FOREIGN_CONNECTION_GENERATION");
      let record: ObservationRecord;
      try {
        record = parseObservation(raw, { ...context, origin, timestampUnit: "s", receiveOrdinal: frames });
      } catch { return reject("INVALID_RECEIVE_CONTEXT"); }
      if (record.result.status === "REJECTED") return reject(record.result.reasonCode);
      const o = record.result.observation, previous = o.kind === "BOOK_OBSERVATION" ? book : trade;
      // Local supported UTC/Date range, NOT unit guessing or a provider promise.
      // In particular do not silently interpret a microsecond value as seconds.
      if (BigInt(o.timestampNs) > 8_640_000_000_000_000_000_000n)
        return reject("TIMESTAMP_OUTSIDE_SUPPORTED_UTC_RANGE");
      if (previous?.result.status === "ACCEPTED_OBSERVATION" &&
        BigInt(o.timestampNs) < BigInt(previous.result.observation.timestampNs))
        return reject("OUT_OF_ORDER_SOURCE_TIME");
      // Equal-second arrivals are NOT exact duplicates: the provider has no
      // documented trade ID. Count deliveries, not supposedly unique trades.
      if (o.kind === "BOOK_OBSERVATION") book = record; else trade = record;
      accepted++;
      return Object.freeze({ status: "OBSERVED" as const, record, admission: analysisAdmission(record) });
    },
    nextGeneration(next: number) {
      if (closed || stopped || !Number.isSafeInteger(next) || next <= generation)
        throw new Error("INVALID_CONNECTION_GENERATION");
      generation = next; book = null; trade = null;
      // Whole-session budgets stay cumulative across reconnects.
    },
    close() { closed = true; book = null; trade = null; },
    snapshot() {
      return Object.freeze({ generation, frames, bytes, accepted, rejected, closed, stopped,
        quality: "UNKNOWN" as const, continuity: "UNVERIFIED" as const,
        sequence: null, exactDedup: "UNAVAILABLE" as const, latestBook: book, latestTrade: trade });
    },
  });
}
