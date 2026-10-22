import { REASON_CODES } from "@workspace/tickstream-adapter/envelope";
import { LIMITS } from "./transport";

export const GATE_B_ENDPOINTS = Object.freeze([
  "wss://stream.tick-stream.xyz/v1/stream", "wss://stream.tick-stream.xyz/v1",
] as const);
export interface GateBReview {
  readonly endpoint: typeof GATE_B_ENDPOINTS[number] | null;
  readonly authority: "UNCONFIRMED" | "PROVIDER_REPLY" | "CONSISTENT_OFFICIAL_DOCUMENTATION" |
    "USER_SELECTED_OFFICIAL_STREAMING";
  readonly evidenceReference: string;
  readonly replitRamReceivePermissionConfirmed: boolean;
}
/** Current public documents still disagree. No CLI/env override can alter this
 * review. A future evidence-backed change needs user review, not URL probing. */
export const GATE_B_REVIEW: GateBReview = Object.freeze({
  endpoint: null, authority: "UNCONFIRMED",
  evidenceReference: "STREAMING_V1_STREAM_VS_AUTHENTICATION_V1_UNEXPLAINED",
  replitRamReceivePermissionConfirmed: false,
});
/** Explicit one-session trial selection. NOT a finding that the documentation
 * discrepancy is resolved, and never used by the normal/default operation. */
export const GATE_B_SELECTED_TRIAL: GateBReview = Object.freeze({
  endpoint: "wss://stream.tick-stream.xyz/v1/stream",
  authority: "USER_SELECTED_OFFICIAL_STREAMING",
  evidenceReference: "USER_APPROVED_OFFICIAL_STREAMING_RAM_ONLY_TRIAL",
  replitRamReceivePermissionConfirmed: true,
});
export const HOLD_REASONS = [
  "EXECUTION_NOT_APPROVED", "ENDPOINT_UNCONFIRMED", "REPLIT_PERMISSION_UNCONFIRMED",
  "KEY_NOT_CHECKED", "KEY_NOT_CONFIGURED",
] as const;
export type HoldReason = typeof HOLD_REASONS[number];
export function reviewGateB(review: GateBReview, explicitExecution: boolean): readonly HoldReason[] {
  const reasons: HoldReason[] = [];
  if (!explicitExecution) reasons.push("EXECUTION_NOT_APPROVED");
  const selectedTrial = review.authority === "USER_SELECTED_OFFICIAL_STREAMING" &&
    review.endpoint === GATE_B_SELECTED_TRIAL.endpoint &&
    review.evidenceReference === GATE_B_SELECTED_TRIAL.evidenceReference;
  if (!GATE_B_ENDPOINTS.includes(review.endpoint as typeof GATE_B_ENDPOINTS[number]) ||
    (!["PROVIDER_REPLY", "CONSISTENT_OFFICIAL_DOCUMENTATION"].includes(review.authority) && !selectedTrial) ||
    !review.evidenceReference || review.evidenceReference.length > 256) reasons.push("ENDPOINT_UNCONFIRMED");
  if (!review.replitRamReceivePermissionConfirmed) reasons.push("REPLIT_PERMISSION_UNCONFIRMED");
  return Object.freeze(reasons);
}
export const B_PHASES = [
  "NOT_RUNNING", "CONNECTING", "SOCKET_OPEN", "SUBSCRIBE_SENT", "SUBSCRIPTION_UNCONFIRMED",
  "FIRST_VALID_TICK_RECEIVED", "OBSERVING", "STOPPING", "STOPPED", "FAILED",
] as const;
export type BPhase = typeof B_PHASES[number];
export const B_REASONS = [
  "HOLD", "COMPLETED", "MESSAGE_LIMIT", "PAYLOAD_LIMIT", "MESSAGE_TOO_LARGE",
  "QUEUE_COUNT_LIMIT", "QUEUE_BYTE_LIMIT", "HANDSHAKE_TIMEOUT", "HEARTBEAT_TIMEOUT",
  "ACTIVE_TIME_LIMIT", "WALL_TIME_LIMIT", "RECONNECT_LIMIT", "SOCKET_ERROR",
  "PROTOCOL_FAILURE", "PARSER_REJECTED", "PARSER_FAILURE", "TIMESTAMP_CONTEXT_MISMATCH",
  "CHANNEL_MISMATCH", "AUTH_REJECTED", "ENTITLEMENT_REJECTED", "SUBSCRIPTION_REJECTED",
  "CONNECTION_LIMIT", "UNKNOWN_CONTROL", "INVALID_UTF8", "INVALID_JSON", "LAG_WARNING",
  "FEED_UNVERIFIED", "MEMORY_THRESHOLD", "MEMORY_NOT_MEASURED", "FORCED_TERMINATION",
  "IPC_INVALID", "CHILD_FAILURE", "CTRL_C",
  "DNS_FAILURE", "TLS_FAILURE", "NETWORK_FAILURE", "HTTP_HANDSHAKE_REJECTED",
] as const;
export type BReason = typeof B_REASONS[number];
export const B_COUNTERS = [
  "received", "validTicks", "rejected", "parserAccepted", "parserRejected", "contextRejected", "control", "unprocessed", "pending",
  "payloadBytes", "queuePeakCount", "queuePeakBytes", "connectionAttempts", "subscriptionAttempts",
  "subscriptionSends", "reconnectAttempts", "heartbeat", "disconnects", "protocolFailures",
  "outOfOrderProviderTimes", "equalProviderTimes",
  "queueOverflows",
] as const;
export type BCounters = Record<typeof B_COUNTERS[number], number>;
export type BExecution = "NOT_RUN" | "LOOPBACK_TEST" | "PRODUCTION";
export interface GateBReport {
  schema: "TICKSTREAM_GATE_B1_V1";
  execution: BExecution;
  phase: BPhase;
  stopReason: BReason;
  holdReasons: readonly HoldReason[];
  persistence: "DISABLED";
  channel: "ticks";
  symbol: "NQ";
  authentication: "NOT_CHECKED" | "UNCONFIRMED" | "DATA_ACCESS_OBSERVED" | "REFUSED";
  subscription: "NOT_SENT" | "SENT_UNCONFIRMED" | "DATA_OBSERVED_NO_ACK" | "REFUSED";
  counters: BCounters | null;
  phaseVisits: Record<BPhase, number> | null;
  parserReasons: Record<typeof REASON_CODES[number], number> | null;
  schemaCompatibility: "NOT_TESTED" | "OBSERVED_COMPATIBLE" | "REJECTED";
  localSchemaProfile: "WS_TICK_LIVE_V1";
  providerSchemaVersion: "NOT_PROVIDED";
  timestampUnit: "s";
  timestampConfidence: "DOCUMENTED_NOT_OBSERVED" | "DOCUMENTED_SECONDS_CONTEXT_CHECKED";
  marketMissingEvents: "NOT_MEASURABLE";
  contract: null;
  providerTradeId: null;
  providerSequence: "UNAVAILABLE";
  continuity: "UNKNOWN";
  accountingMatches: boolean | null;
  supervisorForcedTermination: boolean;
  rssBoundary: "SAMPLED_MONITOR_NOT_OS_HARD_LIMIT";
  endpointBasis: "UNCONFIRMED" | "USER_SELECTED_OFFICIAL_STREAMING" | "INDEPENDENTLY_CONFIRMED" | "LOOPBACK_TEST";
  elapsedWallMs: number | null;
  activeBudgetElapsedMs: number | null;
  memory: { measurement: "NOT_MEASURED" | "MEASURED"; childRssPeak: number | null; totalRssPeak: number | null };
}
export function emptyGateBReport(stopReason: BReason = "HOLD", holds: readonly HoldReason[] = []): GateBReport {
  return {
    schema: "TICKSTREAM_GATE_B1_V1", execution: "NOT_RUN", phase: stopReason === "HOLD" ? "NOT_RUNNING" : "FAILED",
    stopReason, holdReasons: [...holds], persistence: "DISABLED", channel: "ticks", symbol: "NQ",
    authentication: "NOT_CHECKED", subscription: "NOT_SENT", counters: null, phaseVisits: null, parserReasons: null,
    schemaCompatibility: "NOT_TESTED", localSchemaProfile: "WS_TICK_LIVE_V1", providerSchemaVersion: "NOT_PROVIDED",
    timestampUnit: "s", timestampConfidence: "DOCUMENTED_NOT_OBSERVED", marketMissingEvents: "NOT_MEASURABLE",
    contract: null, providerTradeId: null, providerSequence: "UNAVAILABLE", continuity: "UNKNOWN",
    accountingMatches: null, supervisorForcedTermination: false, rssBoundary: "SAMPLED_MONITOR_NOT_OS_HARD_LIMIT",
    endpointBasis: "UNCONFIRMED", elapsedWallMs: null, activeBudgetElapsedMs: null,
    memory: { measurement: "NOT_MEASURED", childRssPeak: null, totalRssPeak: null },
  };
}
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const member = (v: unknown, items: readonly unknown[]) => items.includes(v);
function fixedCounters<K extends string>(input: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !integer(descriptor.value)) return null;
    out[key] = descriptor.value;
  }
  return out;
}
/** Child IPC/normal output whitelist; no raw data, exception, URL or free text. */
export function readGateBReport(input: unknown): GateBReport | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const r = input as GateBReport, base = emptyGateBReport();
    for (const key of ["schema", "persistence", "channel", "symbol", "localSchemaProfile",
      "providerSchemaVersion", "timestampUnit", "marketMissingEvents", "contract", "providerTradeId",
      "providerSequence", "continuity", "rssBoundary"] as const) if (r[key] !== base[key]) return null;
    if (!member(r.execution, ["NOT_RUN", "LOOPBACK_TEST", "PRODUCTION"]) || !member(r.phase, B_PHASES) ||
      !member(r.stopReason, B_REASONS) ||
      !member(r.authentication, ["NOT_CHECKED", "UNCONFIRMED", "DATA_ACCESS_OBSERVED", "REFUSED"]) ||
      !member(r.subscription, ["NOT_SENT", "SENT_UNCONFIRMED", "DATA_OBSERVED_NO_ACK", "REFUSED"]) ||
      !member(r.schemaCompatibility, ["NOT_TESTED", "OBSERVED_COMPATIBLE", "REJECTED"]) ||
      !member(r.timestampConfidence, ["DOCUMENTED_NOT_OBSERVED", "DOCUMENTED_SECONDS_CONTEXT_CHECKED"]) ||
      !Array.isArray(r.holdReasons) || r.holdReasons.length > HOLD_REASONS.length ||
      r.holdReasons.some(h => !member(h, HOLD_REASONS))) return null;
    const counters = r.counters === null ? null : fixedCounters(r.counters, B_COUNTERS);
    const phaseVisits = r.phaseVisits === null ? null : fixedCounters(r.phaseVisits, B_PHASES);
    const parserReasons = r.parserReasons === null ? null : fixedCounters(r.parserReasons, REASON_CODES);
    if ((r.counters !== null && !counters) || (r.phaseVisits !== null && !phaseVisits) ||
      (r.parserReasons !== null && !parserReasons) || (!!counters !== !!phaseVisits) || (!!counters !== !!parserReasons)) return null;
    if (typeof r.supervisorForcedTermination !== "boolean" ||
      (!counters && !["NOT_RUNNING", "FAILED"].includes(r.phase))) return null;
    if (!member(r.endpointBasis, ["UNCONFIRMED", "USER_SELECTED_OFFICIAL_STREAMING", "INDEPENDENTLY_CONFIRMED", "LOOPBACK_TEST"]) ||
      ![r.elapsedWallMs, r.activeBudgetElapsedMs].every(n => n === null || integer(n))) return null;
    if (counters && (counters.parserAccepted !== counters.validTicks + counters.contextRejected ||
      counters.rejected !== counters.parserRejected + counters.contextRejected ||
      Object.values(parserReasons!).reduce((a, b) => a + b, 0) !== counters.parserRejected)) return null;
    if (!r.memory || !member(r.memory.measurement, ["NOT_MEASURED", "MEASURED"]) ||
      ![r.memory.childRssPeak, r.memory.totalRssPeak].every(n => n === null || integer(n))) return null;
    const accounting = counters === null ? null :
      counters.received === counters.validTicks + counters.rejected + counters.control + counters.unprocessed + counters.pending;
    if (r.accountingMatches !== accounting) return null;
    return {
      ...base, execution: r.execution, phase: r.phase, stopReason: r.stopReason, holdReasons: [...r.holdReasons],
      authentication: r.authentication, subscription: r.subscription, counters, phaseVisits, parserReasons,
      schemaCompatibility: r.schemaCompatibility, timestampConfidence: r.timestampConfidence,
      accountingMatches: accounting, supervisorForcedTermination: r.supervisorForcedTermination,
      endpointBasis: r.endpointBasis, elapsedWallMs: r.elapsedWallMs, activeBudgetElapsedMs: r.activeBudgetElapsedMs,
      memory: { measurement: r.memory.measurement, childRssPeak: r.memory.childRssPeak, totalRssPeak: r.memory.totalRssPeak },
    };
  } catch { return null; }
}
export { LIMITS };
