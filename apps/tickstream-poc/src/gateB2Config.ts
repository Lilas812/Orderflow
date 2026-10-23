import { assertLiveAuthorization, type LiveAuthorization } from "@workspace/tickstream-storage/live-authorization";
import { LIVE_CODES } from "@workspace/tickstream-storage/live-record";
import type { LiveQueueReport } from "@workspace/tickstream-storage/live-queue";
import { B_REASONS, readGateBReport, type GateBReport } from "./gateBConfig";
import type { BOfflineStoragePort } from "./gateBTransport";

export const B2_ENDPOINT = "wss://stream.tick-stream.xyz/v1/stream" as const;
/** B-2B only. Both transport and supervisor enforce these immutable limits. */
export const B2_CONNECTION_POLICY = Object.freeze({
  effectiveReconnectLimit: 0, maxConnectionAttempts: 1,
  reconnectSchedulerDisabled: true, parentRestartDisabled: true,
} as const);
export type B2ConnectionPolicy = typeof B2_CONNECTION_POLICY;
export function assertB2ConnectionPolicy(input: unknown = B2_CONNECTION_POLICY): B2ConnectionPolicy {
  const p = input as B2ConnectionPolicy | null;
  if (!p || p.effectiveReconnectLimit !== 0 || p.maxConnectionAttempts !== 1 ||
    p.reconnectSchedulerDisabled !== true || p.parentRestartDisabled !== true) {
    throw Object.assign(Error("B2_CONNECTION_POLICY_HOLD"), { code: "B2_CONNECTION_POLICY_HOLD" });
  }
  return B2_CONNECTION_POLICY;
}
export const LIVE_FLAGS = [
  "--execute-live-storage-trial", "--confirm-nq-ticks-permission",
  "--confirm-replit-storage", "--confirm-manual-cleanup", "--user-selected-streaming",
] as const;
export const B2_EXTRA_REASONS = [
  "B2_CONNECTION_POLICY_HOLD",
  "LIVE_MODE_REQUIRED", "B2_IPC_INVALID", "B2_CHILD_FAILURE", "B2_PRIVATE_PROBE_FAILED", "B2_VERIFY_FAILED",
  "B2_DELETE_FAILED", "B2_RECOVERY_MISMATCH", "TRIAL_PATH_REJECTED", "TRIAL_CONTENT_REJECTED",
  "TRIAL_QUOTA", "TRIAL_EXPIRED_CLEANUP_REQUIRED", "TRIAL_DELETE_FAILED", "TRIAL_IO", "TRIAL_ACTIVE", "KEY_NOT_CONFIGURED",
] as const;
export type B2Reason = typeof B2_EXTRA_REASONS[number] | typeof B_REASONS[number] | typeof LIVE_CODES[number];
export const B2_REASONS: readonly string[] = [...B2_EXTRA_REASONS, ...B_REASONS, ...LIVE_CODES];
export function parseB2Mode(args: readonly string[]) {
  if (args.length === LIVE_FLAGS.length && args.every((s, i) => s === LIVE_FLAGS[i])) return "LIVE" as const;
  if (args.length === 1 && args[0] === "--offline-trial") return "OFFLINE" as const;
  if (args.length === 1 && args[0] === "--preflight-storage") return "PREFLIGHT" as const;
  if (args.length === 2 && args[0] === "--purge-trial" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args[1])) return "PURGE" as const;
  return "HOLD" as const;
}
export interface BLiveStoragePort extends Omit<BOfflineStoragePort, "testOnly"> {
  readonly mode: "AUTHORIZED_LIVE_TRIAL";
}
const ports = new WeakMap<object, LiveAuthorization>();
export function bindLiveStoragePort(queue: Omit<BOfflineStoragePort, "testOnly">, authorization: LiveAuthorization): BLiveStoragePort {
  assertLiveAuthorization(authorization);
  const port = Object.freeze({ mode: "AUTHORIZED_LIVE_TRIAL" as const, accept: queue.accept.bind(queue),
    finish: queue.finish.bind(queue), abort: queue.abort.bind(queue), onFailure: queue.onFailure.bind(queue) });
  ports.set(port, authorization); return port;
}
export function assertLiveStoragePort(port: BLiveStoragePort, execution: string): void {
  const a = ports.get(port); assertLiveAuthorization(a);
  if (execution !== (a.captureMode === "PRODUCTION" ? "PRODUCTION" : "LOOPBACK_TEST")) throw Error("LIVE_AUTH_SCOPE");
}
export type B2TransportReport = Omit<GateBReport, "schema" | "persistence">;
export interface B2CaptureReport {
  schema: "TICKSTREAM_GATE_B2B_CAPTURE_V1";
  connectionPolicy: B2ConnectionPolicy;
  captureMode: LiveAuthorization["captureMode"];
  phase: "STOPPED" | "FAILED";
  reason: B2Reason;
  transport: B2TransportReport;
  storage: LiveQueueReport;
  commit: { position: number; bytes: number; head: string };
}
const number = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const hash = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
/** IPC whitelist: no paths, raw bytes, wire prices, exception messages or keys. */
export function readB2Capture(input: unknown): B2CaptureReport | null {
  try {
    if (!input || typeof input !== "object") return null;
    const r = input as B2CaptureReport;
    if (!r.connectionPolicy) return null;
    const connectionPolicy = assertB2ConnectionPolicy(r.connectionPolicy);
    if (r.schema !== "TICKSTREAM_GATE_B2B_CAPTURE_V1" ||
      !["PRODUCTION", "ARTIFICIAL_PROTOCOL_TEST"].includes(r.captureMode) ||
      !["STOPPED", "FAILED"].includes(r.phase) || !B2_REASONS.includes(r.reason)) return null;
    const base = readGateBReport({ ...r.transport, schema: "TICKSTREAM_GATE_B1_V1", persistence: "DISABLED" });
    if (!base || base.execution !== (r.captureMode === "PRODUCTION" ? "PRODUCTION" : "LOOPBACK_TEST") ||
      base.phase !== r.phase || !base.counters || base.counters.connectionAttempts > connectionPolicy.maxConnectionAttempts ||
      base.counters.reconnectAttempts !== connectionPolicy.effectiveReconnectLimit) return null;
    const s = r.storage;
    if (!s || s.mode !== "AUTHORIZED_LIVE_TRIAL" || !["STOPPED", "FAILED", "ABORTED"].includes(s.phase) ||
      s.reason !== null && !LIVE_CODES.includes(s.reason) || typeof s.accountingMatches !== "boolean") return null;
    if (r.phase === "STOPPED" && (s.phase !== "STOPPED" || s.reason !== "LIVE_FINISHED" ||
      s.pending !== 0 || s.unknown !== 0 || s.refused !== 0) ||
      s.phase === "FAILED" && (r.phase !== "FAILED" || r.reason !== s.reason) ||
      s.phase !== "FAILED" && r.reason !== base.stopReason) return null;
    const names = ["offered", "enqueued", "persisted", "pending", "pendingBytes", "unknown", "refused", "unpersisted",
      "peakCount", "peakBytes"] as const;
    if (names.some(k => !number(s[k])) || s.peakCount > 128 || s.peakBytes > 8 * 1024 * 1024 ||
      s.pending > 128 || s.pendingBytes > 8 * 1024 * 1024 || s.unknown > s.pending ||
      s.persisted > 1000 || s.enqueued !== s.persisted + s.pending || s.offered !== s.enqueued + s.refused ||
      s.unpersisted !== s.offered - s.persisted || s.accountingMatches !== true ||
      s.offered !== base.counters?.validTicks) return null;
    const c = r.commit;
    if (!c || !number(c.position) || !number(c.bytes) || !hash(c.head) ||
      c.position !== s.persisted || c.bytes > 64 * 1024 * 1024) return null;
    const { schema: _, persistence: _p, ...transport } = base;
    return { schema: r.schema, connectionPolicy, captureMode: r.captureMode, phase: r.phase, reason: r.reason, transport,
      storage: { mode: s.mode, phase: s.phase, reason: s.reason,
        ...Object.fromEntries(names.map(k => [k, s[k]])), accountingMatches: true } as LiveQueueReport,
      commit: { position: c.position, bytes: c.bytes, head: c.head } };
  } catch { return null; }
}
export function b2FailureReason(error: unknown, fallback: B2Reason): B2Reason {
  try {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    return typeof code === "string" && B2_REASONS.includes(code) ? code as B2Reason : fallback;
  } catch { return fallback; }
}
