import { REASON_CODES } from "@workspace/tickstream-adapter/envelope";
import type { ControlCode } from "./liveControl";
export const LIVE_REASONS = [
  "COMPLETED", "NOT_STARTED", "GATE_B_C_CLOSED", "HANDSHAKE_TIMEOUT", "HEARTBEAT_TIMEOUT",
  "ACTIVE_TIME_LIMIT", "WALL_TIME_LIMIT", "QUEUE_COUNT_LIMIT", "QUEUE_BYTE_LIMIT",
  "STORAGE_QUEUE_LIMIT", "STORAGE_FAILED", "MESSAGE_LIMIT", "PAYLOAD_LIMIT",
  "PARSER_FAILURE", "PARSER_REJECTED", "CHANNEL_MISMATCH", "TIMESTAMP_CONTEXT_MISMATCH",
  "REMOTE_CLOSE", "SOCKET_ERROR", "PROTOCOL_FAILURE", "RECONNECT_LIMIT",
  "MEMORY_THRESHOLD", "MEMORY_NOT_MEASURED", "FORCED_TERMINATION",
  "JSON_PING", "JSON_PONG", "WELCOME_UNVERIFIED", "AUTH_REJECTED", "ENTITLEMENT_REJECTED",
  "SUBSCRIPTION_REJECTED", "CONNECTION_LIMIT", "LAG_WARNING", "FEED_UNVERIFIED",
  "UNKNOWN_CONTROL", "INVALID_JSON", "INVALID_UTF8", "MESSAGE_TOO_LARGE",
] as const;
export type LiveReason = typeof LIVE_REASONS[number] | typeof REASON_CODES[number];
const COUNTERS = [
  "received", "parsed", "accepted", "rejected", "control", "queued", "persisted", "persistenceFailed",
  "unprocessed", "connectionAttempts", "subscriptionAttempts", "reconnectAttempts", "heartbeat",
  "protocolFailures", "parserFailures", "storageFailures", "payloadBytes", "queuePeakCount",
  "queuePeakBytes", "storageQueuePeakCount", "storageQueuePeakBytes", "disconnects",
] as const;
type Counter = typeof COUNTERS[number];
/** Never serialize this mutable instance or upstream errors. report() is the only boundary. */
export class LiveDiagnostics {
  readonly counts: Record<Counter, number> = Object.fromEntries(COUNTERS.map(k => [k, 0])) as Record<Counter, number>;
  private readonly reasons = Object.fromEntries([...LIVE_REASONS, ...REASON_CODES].map(k => [k, 0])) as Record<LiveReason, number>;
  private readonly families = { ticks: 0, book: 0, control: 0 };
  reason: LiveReason = "NOT_STARTED";
  state: "NOT_RUNNING" | "RUNNING" | "STOPPED" | "FAILED" = "NOT_RUNNING";
  memory: "NOT_MEASURED" | "MEASURED" = "NOT_MEASURED";
  sessionRssPeak: number | null = null;
  totalRssPeak: number | null = null;
  note(reason: LiveReason): void { if (Object.hasOwn(this.reasons, reason)) this.reasons[reason]++; }
  family(kind: "ticks" | "book" | "control"): void { this.families[kind]++; }
  control(code: ControlCode): void { this.note(code); }
  report(pendingReceive: number, pendingStorage: number) {
    const c = Object.fromEntries(COUNTERS.map(k => [k, this.counts[k]])) as Record<Counter, number>;
    return {
      schema: "TICKSTREAM_GATE_A_DIAGNOSTICS_V1", network: "LOOPBACK_OR_FAKE_ONLY",
      source: "SYNTHETIC_TEST", state: this.state,
      stopReason: Object.hasOwn(this.reasons, this.reason) ? this.reason : "SOCKET_ERROR",
      authentication: "UNCONFIRMED", subscriptionConfirmed: "UNCONFIRMED",
      firstObservation: c.accepted > 0 ? "OBSERVED_SYNTHETIC_ONLY" : "NOT_OBSERVED",
      counters: c, pendingReceive, pendingStorage,
      reasons: { ...this.reasons }, families: { ...this.families },
      accountingMatches: c.received === c.control + c.parsed + c.unprocessed + pendingReceive &&
        c.parsed === c.accepted + c.rejected &&
        c.parsed === c.persisted + pendingStorage,
      marketMissingEvents: "NOT_MEASURABLE", providerSequence: "UNAVAILABLE",
      contract: null, continuityStatus: "UNKNOWN",
      memory: { measurement: this.memory, sessionRssPeak: this.sessionRssPeak,
        totalRssPeak: this.totalRssPeak, kind: "MONITORING_THRESHOLD_NOT_OS_HARD_LIMIT" },
    };
  }
}
