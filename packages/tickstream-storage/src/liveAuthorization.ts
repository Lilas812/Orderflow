/** Process-local capability. Persisted metadata is evidence of scope, NOT an
 * authorization token. A fresh explicit authorization is required after restart. */
export const AUTHORIZED_LIVE_MODE = "AUTHORIZED_LIVE_TRIAL" as const;
export const MAX_RETENTION_MS = 24 * 60 * 60 * 1000;
export const TRIAL_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export type CaptureMode = "PRODUCTION" | "ARTIFICIAL_PROTOCOL_TEST";
export type AuthorizationCode = "LIVE_AUTH_REQUIRED" | "LIVE_AUTH_EXPIRED" | "LIVE_AUTH_SCOPE";
export class LiveAuthorizationFailure extends Error {
  constructor(readonly code: AuthorizationCode) { super(code); }
}
export interface LiveAuthorization {
  readonly mode: typeof AUTHORIZED_LIVE_MODE;
  readonly captureMode: CaptureMode;
  readonly trialId: string;
  readonly directory: string;
  readonly issuedAtMs: number;
  readonly deleteByMs: number;
}
const issued = new WeakSet<object>();
export function authorizeLiveStorage(input: {
  explicitMode: "GATE_B2B";
  dataPermission: boolean;
  replitStoragePermission: boolean;
  manualCleanupConfirmed: boolean;
  captureMode: CaptureMode;
  trialId: string;
  directory: string;
  issuedAtMs: number;
  deleteByMs: number;
}, nowMs = Date.now()): LiveAuthorization {
  if (input?.explicitMode !== "GATE_B2B" || input.dataPermission !== true ||
    input.replitStoragePermission !== true || input.manualCleanupConfirmed !== true) {
    throw new LiveAuthorizationFailure("LIVE_AUTH_REQUIRED");
  }
  if (!["PRODUCTION", "ARTIFICIAL_PROTOCOL_TEST"].includes(input.captureMode) ||
    !TRIAL_ID.test(input.trialId) || typeof input.directory !== "string" ||
    !input.directory.startsWith("/") || input.directory.includes("\0") ||
    !Number.isSafeInteger(input.issuedAtMs) || !Number.isSafeInteger(input.deleteByMs) ||
    input.issuedAtMs < 0 || input.deleteByMs <= input.issuedAtMs ||
    input.deleteByMs - input.issuedAtMs > MAX_RETENTION_MS ||
    input.issuedAtMs > nowMs || !Number.isSafeInteger(nowMs)) {
    throw new LiveAuthorizationFailure("LIVE_AUTH_SCOPE");
  }
  if (nowMs >= input.deleteByMs) throw new LiveAuthorizationFailure("LIVE_AUTH_EXPIRED");
  const authorization = Object.freeze({ mode: AUTHORIZED_LIVE_MODE, captureMode: input.captureMode,
    trialId: input.trialId, directory: input.directory, issuedAtMs: input.issuedAtMs, deleteByMs: input.deleteByMs });
  issued.add(authorization); return authorization;
}
export function assertLiveAuthorization(input: unknown, nowMs = Date.now()): asserts input is LiveAuthorization {
  if (!input || typeof input !== "object" || !issued.has(input)) throw new LiveAuthorizationFailure("LIVE_AUTH_REQUIRED");
  const a = input as LiveAuthorization;
  if (!Number.isSafeInteger(nowMs) || nowMs < a.issuedAtMs) throw new LiveAuthorizationFailure("LIVE_AUTH_SCOPE");
  if (nowMs >= a.deleteByMs) throw new LiveAuthorizationFailure("LIVE_AUTH_EXPIRED");
}
