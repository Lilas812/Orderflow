import { constants, closeSync, fstatSync, fsyncSync, openSync, readSync, renameSync } from "node:fs";
import { join } from "node:path";
import { canonicalObservation } from "@workspace/tickstream-adapter/live-observation";
import { digest, MANIFEST_RESERVE, privateDirectory, privateRead, QUOTA_BYTES, writeFully, ZERO_HASH } from "./manifest";
import { liveCheck, LiveFailure, OFFLINE_LIVE_MODE } from "./liveRecord";
import { AUTHORIZED_LIVE_MODE, MAX_RETENTION_MS, TRIAL_ID, type CaptureMode } from "./liveAuthorization";

export { digest, MANIFEST_RESERVE, QUOTA_BYTES, ZERO_HASH };
export const LIVE_LOG = "live-ticks.bin";
export const LIVE_MANIFEST = "live-manifest.json";
export const LIVE_TEMP = "live-manifest.next";
export const LIVE_LOCK = "live-writer.lock";
export const LIVE_FILES = [LIVE_LOG, LIVE_MANIFEST, LIVE_TEMP, LIVE_LOCK] as const;
export type LiveWritePhase = "BEFORE_APPEND" | "AFTER_PARTIAL_APPEND" | "AFTER_APPEND" |
  "BEFORE_LOG_FSYNC" | "AFTER_LOG_FSYNC" | "BEFORE_MANIFEST_FSYNC" | "AFTER_MANIFEST_FSYNC" |
  "BEFORE_MANIFEST_RENAME" | "BEFORE_DIRECTORY_FSYNC" | "AFTER_DIRECTORY_FSYNC" | "AFTER_MANIFEST";
export type LiveFault = (phase: LiveWritePhase) => void;
export interface LiveManifest {
  readonly schema: "TICKSTREAM_LIVE_APPEND_V1" | "TICKSTREAM_LIVE_APPEND_V2";
  readonly mode: typeof OFFLINE_LIVE_MODE | typeof AUTHORIZED_LIVE_MODE;
  readonly environment: "LIVE";
  readonly sessionId: string;
  readonly count: number;
  readonly bytes: number;
  readonly head: string;
  readonly checksum: string;
  readonly trialId?: string;
  readonly captureMode?: CaptureMode;
  readonly issuedAtMs?: number;
  readonly deleteByMs?: number;
}
export function liveDirectory(directory: string): string {
  try { return privateDirectory(directory); } catch { throw new LiveFailure("LIVE_PRIVATE_DIRECTORY"); }
}
export function liveRead(root: string, name: string, max: number): number {
  try { return privateRead(root, name, max); } catch { throw new LiveFailure("LIVE_STORE_CORRUPT"); }
}
export function sealLiveManifest(base: Omit<LiveManifest, "checksum">): LiveManifest {
  return Object.freeze({ ...base, checksum: digest(canonicalObservation(base)) });
}
export function directorySync(root: string, fault?: LiveFault): void {
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fault?.("BEFORE_DIRECTORY_FSYNC"); fsyncSync(fd); fault?.("AFTER_DIRECTORY_FSYNC"); }
  finally { closeSync(fd); }
}
/** Separate schema and files. Gate A's publisher/readers remain untouched. */
export function publishLiveManifest(root: string, manifest: LiveManifest, fault?: LiveFault): void {
  const bytes = Buffer.from(canonicalObservation(manifest));
  liveCheck(bytes.length <= MANIFEST_RESERVE, "LIVE_STORE_QUOTA");
  const fd = openSync(join(root, LIVE_TEMP), "wx", 0o600);
  try {
    writeFully(fd, bytes);
    fault?.("BEFORE_MANIFEST_FSYNC"); fsyncSync(fd); fault?.("AFTER_MANIFEST_FSYNC");
  } finally { closeSync(fd); }
  fault?.("BEFORE_MANIFEST_RENAME");
  renameSync(join(root, LIVE_TEMP), join(root, LIVE_MANIFEST));
  directorySync(root, fault);
}
export function readLiveManifest(root: string): LiveManifest {
  const fd = liveRead(root, LIVE_MANIFEST, MANIFEST_RESERVE);
  try {
    const bytes = Buffer.alloc(fstatSync(fd).size);
    let n = 0;
    while (n < bytes.length) { const k = readSync(fd, bytes, n, bytes.length - n, n); liveCheck(k > 0, "LIVE_STORE_CORRUPT"); n += k; }
    const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as LiveManifest;
    const { checksum, ...base } = m;
    const offline = Object.keys(m).length === 8 && m.schema === "TICKSTREAM_LIVE_APPEND_V1" && m.mode === OFFLINE_LIVE_MODE;
    const authorized = Object.keys(m).length === 12 && m.schema === "TICKSTREAM_LIVE_APPEND_V2" &&
      m.mode === AUTHORIZED_LIVE_MODE && typeof m.trialId === "string" && TRIAL_ID.test(m.trialId) &&
      ["PRODUCTION", "ARTIFICIAL_PROTOCOL_TEST"].includes(m.captureMode!) &&
      Number.isSafeInteger(m.issuedAtMs) && m.issuedAtMs! >= 0 && Number.isSafeInteger(m.deleteByMs) &&
      m.deleteByMs! > m.issuedAtMs! && m.deleteByMs! - m.issuedAtMs! <= MAX_RETENTION_MS;
    liveCheck((offline || authorized) && m.environment === "LIVE" &&
      typeof m.sessionId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(m.sessionId) &&
      Number.isSafeInteger(m.count) && m.count >= 0 && m.count <= 1000 &&
      Number.isSafeInteger(m.bytes) && m.bytes >= 0 && m.bytes <= QUOTA_BYTES &&
      typeof m.head === "string" && /^[a-f0-9]{64}$/.test(m.head) &&
      checksum === digest(canonicalObservation(base)) &&
      canonicalObservation(m) === bytes.toString("utf8"), "LIVE_STORE_CORRUPT");
    return Object.freeze(m);
  } catch { throw new LiveFailure("LIVE_STORE_CORRUPT"); }
  finally { closeSync(fd); }
}
