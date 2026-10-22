import { parsePublicSample } from "./parsePublicSample";
import { REASON_CODES, type ParseResult, type ReasonCode, type SampleOrigin } from "./envelope";

export const PARSER_VERSION = "tickstream-observation-wrapper-1";
export const MAX_RECORD_BYTES = 1024 * 1024;
const CHECKED_AT = "2026-10-22T18:53:44Z";
export interface ReceiveContext {
  readonly origin: Exclude<SampleOrigin, "DOCUMENTATION_ILLUSTRATIVE">;
  readonly channel: "ticks" | "book";
  readonly timestampUnit: "s" | "us";
  readonly receivedAtUtcNs: string;
  readonly receivedAtMonotonicNs: string;
  readonly connectionEpoch: number;
  readonly receiveOrdinal: number;
}
type StoredResult = Extract<ParseResult, { status: "ACCEPTED_OBSERVATION" }> |
  { readonly status: "REJECTED"; readonly reasonCode: ReasonCode };
export interface ObservationRecord {
  readonly schema: "TICKSTREAM_OBSERVATION_V1";
  readonly provenance: {
    readonly provider: "TICKSTREAM";
    readonly environment: "LIVE" | "SIMULATED";
    readonly sampleOrigin: ReceiveContext["origin"];
    readonly channel: ReceiveContext["channel"];
    readonly requestedSymbol: "NQ";
    readonly providerSymbol: "NQ" | null;
    readonly individualContract: null;
    readonly providerTimestamp: number | null;
    readonly providerTimestampUnit: ReceiveContext["timestampUnit"];
    readonly providerTimestampPrecision: ReceiveContext["timestampUnit"];
    readonly receivedAtUtcNs: string;
    readonly receivedAtUtcPrecision: "ms";
    readonly receivedAtMonotonicNs: string;
    readonly connectionEpoch: number;
    /** Local storage identity only, never a Trade ID or provider sequence. */
    readonly receiveOrdinal: number;
    readonly schemaProfile: "WS_TICK_LIVE_V1" | "WS_BOOK_LIVE_V1";
    readonly parserVersion: typeof PARSER_VERSION;
    readonly validationStatus: "ACCEPTED_OBSERVATION" | "REJECTED";
    readonly reasonCode: ReasonCode | null;
    readonly sequenceStatus: "UNAVAILABLE";
    readonly continuityStatus: "UNKNOWN";
  };
  readonly result: StoredResult;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function canonicalObservation(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalObservation).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(k => `${JSON.stringify(k)}:${canonicalObservation((value as Record<string, unknown>)[k])}`).join(",")}}`;
  const s = JSON.stringify(value);
  if (s === undefined) throw new Error("OBSERVATION_INVALID");
  return s;
}
function validContext(c: ReceiveContext): void {
  if (!c || !["SYNTHETIC_TEST", "ACTUAL_PROVIDER_RESPONSE"].includes(c.origin) ||
    !["ticks", "book"].includes(c.channel) || !["s", "us"].includes(c.timestampUnit) ||
    ![c.receivedAtUtcNs, c.receivedAtMonotonicNs].every(s => typeof s === "string" && /^(0|[1-9][0-9]{0,29})$/.test(s)) ||
    BigInt(c.receivedAtUtcNs) % 1_000_000n !== 0n ||
    ![c.connectionEpoch, c.receiveOrdinal].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("OBSERVATION_CONTEXT");
  }
}
/** Explicit caller provenance. Wire fields cannot set origin, epoch or ordinal. */
export function parseObservation(raw: string | Uint8Array, c: ReceiveContext): ObservationRecord {
  validContext(c);
  const schemaProfile = c.channel === "ticks" ? "WS_TICK_LIVE_V1" : "WS_BOOK_LIVE_V1";
  let result = parsePublicSample({
    raw, schemaProfile, instrument: { kind: "CORE_NQ", symbol: "NQ" },
    provenance: { sourceUrl: `https://tick-stream.xyz/docs/${c.channel === "ticks" ? "streaming" : "level2"}`,
      documentationCheckedAt: CHECKED_AT, sampleOrigin: c.origin, timestampUnit: c.timestampUnit },
  });
  if (result.status === "ACCEPTED_OBSERVATION" && result.observation.rawSymbol !== "NQ") {
    result = { status: "REJECTED_UNSUPPORTED", reasonCode: "UNSUPPORTED_INSTRUMENT",
      fieldPath: "$", explanation: "NQ only.", schemaProfile };
  }
  if (result.status === "ACCEPTED_OBSERVATION" && result.observation.kind === "BOOK_OBSERVATION" &&
    (result.observation.bids.length > 400 || result.observation.asks.length > 400)) {
    result = { status: "REJECTED_UNSUPPORTED", reasonCode: "INVALID_FIELD",
      fieldPath: "$", explanation: "Reviewed depth bound exceeded.", schemaProfile };
  }
  const acceptedResult = result.status === "ACCEPTED_OBSERVATION" ? result : null;
  const reason = result.status === "ACCEPTED_OBSERVATION" ? null : result.reasonCode;
  const accepted = acceptedResult !== null;
  return freeze({
    schema: "TICKSTREAM_OBSERVATION_V1",
    provenance: {
      provider: "TICKSTREAM", environment: c.origin === "SYNTHETIC_TEST" ? "SIMULATED" : "LIVE",
      sampleOrigin: c.origin, channel: c.channel, requestedSymbol: "NQ",
      providerSymbol: accepted ? "NQ" : null, individualContract: null,
      providerTimestamp: acceptedResult ? acceptedResult.observation.rawTimestamp : null,
      providerTimestampUnit: c.timestampUnit, providerTimestampPrecision: c.timestampUnit,
      receivedAtUtcNs: c.receivedAtUtcNs, receivedAtUtcPrecision: "ms",
      receivedAtMonotonicNs: c.receivedAtMonotonicNs, connectionEpoch: c.connectionEpoch,
      receiveOrdinal: c.receiveOrdinal, schemaProfile, parserVersion: PARSER_VERSION,
      validationStatus: accepted ? "ACCEPTED_OBSERVATION" : "REJECTED",
      reasonCode: reason,
      sequenceStatus: "UNAVAILABLE", continuityStatus: "UNKNOWN",
    },
    result: acceptedResult ?? { status: "REJECTED", reasonCode: reason! },
  } as ObservationRecord);
}
/**
 * Revalidate stored structured data, without retaining original wire payload.
 * Exact reconstruction rejects added fields and inconsistent derived Tick/ns data.
 */
export function validateObservation(input: unknown): ObservationRecord {
  try {
    const text = canonicalObservation(input);
    if (new TextEncoder().encode(text).length > MAX_RECORD_BYTES) throw new Error();
    const r = JSON.parse(text) as ObservationRecord, p = r.provenance;
    const c: ReceiveContext = { origin: p.sampleOrigin, channel: p.channel, timestampUnit: p.providerTimestampUnit,
      receivedAtUtcNs: p.receivedAtUtcNs, receivedAtMonotonicNs: p.receivedAtMonotonicNs,
      connectionEpoch: p.connectionEpoch, receiveOrdinal: p.receiveOrdinal };
    validContext(c);
    let expected: ObservationRecord;
    if (r.result.status === "ACCEPTED_OBSERVATION") {
      const o = r.result.observation;
      const wire = o.kind === "TRADE_OBSERVATION" ?
        { type: "tick", symbol: o.rawSymbol, ts: o.rawTimestamp, price: o.price, size: o.size, side: o.rawSide, exch: o.exchange } :
        { type: "book", symbol: o.rawSymbol, ts: o.rawTimestamp, imbalance: o.imbalance,
          bids: o.bids.map(l => [l.price, l.size]), asks: o.asks.map(l => [l.price, l.size]) };
      expected = parseObservation(JSON.stringify(wire), c);
    } else {
      if (!REASON_CODES.includes(r.result.reasonCode)) throw new Error();
      // A rejection record has no raw bytes; validate its metadata/shape, not
      // pretend to re-prove the discarded input's semantic rejection.
      const base = parseObservation("{}", c);
      expected = freeze({ ...base, provenance: { ...base.provenance, reasonCode: r.result.reasonCode },
        result: { status: "REJECTED", reasonCode: r.result.reasonCode } });
    }
    if (canonicalObservation(expected) !== text) throw new Error();
    return expected;
  } catch { throw new Error("OBSERVATION_INVALID"); }
}
