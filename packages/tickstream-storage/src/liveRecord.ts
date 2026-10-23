import { canonicalObservation, parseObservation, PARSER_VERSION, validateObservation,
  type ObservationRecord } from "@workspace/tickstream-adapter/live-observation";

/** B-2A is NOT evidence of live provenance. Both the file and each record carry
 * this discriminator; actual-provider records are forbidden in this stage. */
export const OFFLINE_LIVE_MODE = "OFFLINE_SYNTHETIC_LIVE_EQUIVALENT" as const;
export const LIVE_RECORD_BYTES = 4096;
export const LIVE_CODES = [
  "LIVE_RECORD_INVALID", "LIVE_PRODUCTION_DISABLED", "LIVE_PRIVATE_DIRECTORY",
  "LIVE_STORE_EXISTS", "LIVE_STORE_CLOSED", "LIVE_STORE_FAILED", "LIVE_STORE_IO",
  "LIVE_STORE_UNKNOWN", "LIVE_STORE_CORRUPT", "LIVE_STORE_TAIL", "LIVE_STORE_QUOTA",
  "LIVE_RECEIVE_ID_INVALID", "LIVE_QUEUE_COUNT_LIMIT", "LIVE_QUEUE_BYTE_LIMIT",
  "LIVE_QUEUE_CLOSED", "LIVE_QUEUE_ABORTED", "LIVE_QUEUE_FAILED", "LIVE_FINISHED",
] as const;
export type LiveCode = typeof LIVE_CODES[number];
export class LiveFailure extends Error {
  constructor(readonly code: LiveCode) { super(code); }
}
export function liveCheck(value: unknown, code: LiveCode): asserts value {
  if (!value) throw new LiveFailure(code);
}
export interface LiveTickRecord {
  readonly schema: "TICKSTREAM_LIVE_TICK_RECORD_V1";
  readonly testMode: typeof OFFLINE_LIVE_MODE;
  readonly inputOrigin: "SYNTHETIC_TEST";
  /** Target storage domain, not an assertion that this test used real data. */
  readonly environment: "LIVE";
  readonly provider: "TICKSTREAM";
  readonly channel: "ticks";
  readonly requestedSymbol: "NQ";
  readonly providerSymbol: "NQ";
  readonly individualContract: null;
  readonly providerTimestamp: number;
  readonly providerTimestampUnit: "s";
  readonly providerTimestampPrecision: "s";
  readonly receivedAtUtcNs: string;
  readonly clockPrecision: "ms";
  readonly receivedAtMonotonicNs: string;
  readonly connectionEpoch: number;
  readonly receiveOrdinal: number;
  readonly price: number;
  readonly priceTicks: number;
  readonly size: number;
  readonly side: "BUY" | "SELL" | "UNKNOWN";
  readonly exchange: "CME";
  readonly schemaProfile: "WS_TICK_LIVE_V1";
  readonly parserVersion: typeof PARSER_VERSION;
  readonly validationStatus: "ACCEPTED_OBSERVATION";
  readonly qualityStatus: "COMPLETENESS_UNKNOWN";
  readonly tradeId: null;
  readonly providerSequence: "UNAVAILABLE";
  readonly continuityStatus: "UNKNOWN";
}
/** Projection only after the existing parser's strict round-trip validation.
 * No free text, rejected raw bytes, credentials or provider identity synthesis. */
export function offlineLiveRecord(input: ObservationRecord): LiveTickRecord {
  try {
    const r = validateObservation(input), p = r.provenance;
    liveCheck(p.sampleOrigin === "SYNTHETIC_TEST" && p.environment === "SIMULATED", "LIVE_PRODUCTION_DISABLED");
    liveCheck(r.result.status === "ACCEPTED_OBSERVATION" &&
      r.result.observation.kind === "TRADE_OBSERVATION" && p.channel === "ticks" &&
      p.providerTimestampUnit === "s", "LIVE_RECORD_INVALID");
    const o = r.result.observation;
    liveCheck(o.exchange === "CME", "LIVE_RECORD_INVALID");
    const age = BigInt(p.receivedAtUtcNs) - BigInt(o.timestampNs);
    liveCheck(age >= -5_000_000_000n && age <= 86_400_000_000_000n, "LIVE_RECORD_INVALID");
    return Object.freeze({
      schema: "TICKSTREAM_LIVE_TICK_RECORD_V1", testMode: OFFLINE_LIVE_MODE, inputOrigin: "SYNTHETIC_TEST",
      environment: "LIVE", provider: p.provider, channel: "ticks", requestedSymbol: p.requestedSymbol,
      providerSymbol: "NQ", individualContract: null, providerTimestamp: o.rawTimestamp,
      providerTimestampUnit: "s", providerTimestampPrecision: "s", receivedAtUtcNs: p.receivedAtUtcNs,
      clockPrecision: "ms", receivedAtMonotonicNs: p.receivedAtMonotonicNs,
      connectionEpoch: p.connectionEpoch, receiveOrdinal: p.receiveOrdinal,
      price: o.price, priceTicks: o.priceTicks, size: o.size, side: o.side, exchange: "CME",
      schemaProfile: "WS_TICK_LIVE_V1", parserVersion: PARSER_VERSION, validationStatus: "ACCEPTED_OBSERVATION",
      qualityStatus: "COMPLETENESS_UNKNOWN", tradeId: null, providerSequence: "UNAVAILABLE", continuityStatus: "UNKNOWN",
    });
  } catch (error) {
    if (error instanceof LiveFailure) throw error;
    throw new LiveFailure("LIVE_RECORD_INVALID");
  }
}
/** Reconstruct the exact reviewed parser input and compare EVERY stored field.
 * Extra properties, false provenance and modified derived values are rejected. */
export function validateLiveRecord(input: unknown): LiveTickRecord {
  try {
    const text = canonicalObservation(input);
    liveCheck(Buffer.byteLength(text) <= LIVE_RECORD_BYTES, "LIVE_RECORD_INVALID");
    const r = JSON.parse(text) as LiveTickRecord;
    const observation = parseObservation(JSON.stringify({
      type: "tick", symbol: r.providerSymbol, ts: r.providerTimestamp,
      price: r.price, size: r.size,
      side: r.side === "BUY" ? "buy" : r.side === "SELL" ? "sell" : r.side === "UNKNOWN" ? "unknown" : null,
      exch: r.exchange,
    }), { origin: "SYNTHETIC_TEST", channel: "ticks", timestampUnit: "s",
      receivedAtUtcNs: r.receivedAtUtcNs, receivedAtMonotonicNs: r.receivedAtMonotonicNs,
      connectionEpoch: r.connectionEpoch, receiveOrdinal: r.receiveOrdinal });
    const expected = offlineLiveRecord(observation);
    liveCheck(canonicalObservation(expected) === text, "LIVE_RECORD_INVALID");
    return expected;
  } catch { throw new LiveFailure("LIVE_RECORD_INVALID"); }
}
export function assertReceiveOrder(previous: LiveTickRecord | undefined, record: LiveTickRecord): void {
  liveCheck(!previous || record.connectionEpoch > previous.connectionEpoch ||
    record.connectionEpoch === previous.connectionEpoch && record.receiveOrdinal > previous.receiveOrdinal,
  "LIVE_RECEIVE_ID_INVALID");
}
