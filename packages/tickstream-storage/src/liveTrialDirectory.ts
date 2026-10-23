import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, realpathSync, rmdirSync, statfsSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalObservation } from "@workspace/tickstream-adapter/live-observation";
import { writeFully } from "./manifest";
import { digest, directorySync, LIVE_FILES, LIVE_LOG, MANIFEST_RESERVE, QUOTA_BYTES } from "./liveManifest";
import { authorizeLiveStorage, MAX_RETENTION_MS, TRIAL_ID, type CaptureMode, type LiveAuthorization } from "./liveAuthorization";

export const DEFAULT_LIVE_ROOT = join(homedir(), ".local/state/orderflow-lab-live");
const MARKER = "trial.json";
const LEASE = "session.lock";
export class TrialDirectoryFailure extends Error {
  constructor(readonly code: "TRIAL_PATH_REJECTED" | "TRIAL_CONTENT_REJECTED" | "TRIAL_QUOTA" |
    "TRIAL_EXPIRED_CLEANUP_REQUIRED" | "TRIAL_DELETE_FAILED" | "TRIAL_IO" | "TRIAL_ACTIVE") { super(code); }
}
function requireTrial(value: unknown, code: TrialDirectoryFailure["code"]): asserts value {
  if (!value) throw new TrialDirectoryFailure(code);
}
export interface TrialMarker {
  readonly schema: "TICKSTREAM_TRIAL_DIRECTORY_V1";
  readonly trialId: string;
  readonly captureMode: CaptureMode;
  readonly issuedAtMs: number;
  readonly deleteByMs: number;
  readonly checksum: string;
}
export interface TrialPaths {
  readonly root: string;
  readonly trialId: string;
  readonly directory: string;
  readonly data: string;
  readonly marker: TrialMarker;
}
function directoryIdentity(path: string, privateMode: boolean): void {
  const st = lstatSync(path);
  requireTrial(st.isDirectory() && !st.isSymbolicLink() && realpathSync(path) === path &&
    (process.getuid === undefined || st.uid === process.getuid()) &&
    (privateMode ? (st.mode & 0o777) === 0o700 : (st.mode & 0o022) === 0), "TRIAL_PATH_REJECTED");
}
/** Check every ancestor, not just the final component. Root-owned ancestors are
 * trusted only above the user's home/test root; no group/world-writable parents. */
export function prepareTrialRoot(root = DEFAULT_LIVE_ROOT, create = false): string {
  try {
    requireTrial(resolve(root) === root && !root.includes("\0"), "TRIAL_PATH_REJECTED");
    const workspace = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
    requireTrial(root !== workspace && !root.startsWith(workspace + sep), "TRIAL_PATH_REJECTED");
    const parent = dirname(root);
    let current = parent;
    while (current !== dirname(current)) {
      const st = lstatSync(current);
      requireTrial(st.isDirectory() && !st.isSymbolicLink() && realpathSync(current) === current &&
        (st.mode & 0o022) === 0 &&
        (st.uid === 0 || process.getuid === undefined || st.uid === process.getuid()), "TRIAL_PATH_REJECTED");
      // /tmp is permitted ONLY for artificial unit tests, never the default
      // production root. Its sticky shared ancestor is checked separately.
      current = dirname(current);
      if (current === tmpdir() && root !== DEFAULT_LIVE_ROOT) break;
    }
    directoryIdentity(parent, false);
    if (!existsSync(root)) {
      requireTrial(create, "TRIAL_PATH_REJECTED");
      mkdirSync(root, { mode: 0o700 }); directorySync(parent);
    }
    directoryIdentity(root, true); return root;
  } catch (error) {
    if (error instanceof TrialDirectoryFailure) throw error;
    throw new TrialDirectoryFailure("TRIAL_PATH_REJECTED");
  }
}
function trialPath(root: string, trialId: string): string {
  requireTrial(TRIAL_ID.test(trialId), "TRIAL_PATH_REJECTED");
  return join(prepareTrialRoot(root), trialId);
}
function readMarker(path: string): TrialMarker {
  let fd: number | undefined;
  try {
    fd = openSync(join(path, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    requireTrial(st.isFile() && st.nlink === 1 && (st.mode & 0o777) === 0o600 && st.size <= MANIFEST_RESERVE &&
      (process.getuid === undefined || st.uid === process.getuid()), "TRIAL_CONTENT_REJECTED");
    const bytes = Buffer.alloc(st.size); let n = 0;
    while (n < bytes.length) {
      const k = readSync(fd, bytes, n, bytes.length - n, n); requireTrial(k > 0, "TRIAL_CONTENT_REJECTED"); n += k;
    }
    const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as TrialMarker;
    const { checksum, ...base } = m;
    requireTrial(Object.keys(m).length === 6 && m.schema === "TICKSTREAM_TRIAL_DIRECTORY_V1" &&
      TRIAL_ID.test(m.trialId) && ["PRODUCTION", "ARTIFICIAL_PROTOCOL_TEST"].includes(m.captureMode) &&
      Number.isSafeInteger(m.issuedAtMs) && m.issuedAtMs >= 0 &&
      Number.isSafeInteger(m.deleteByMs) && m.deleteByMs > m.issuedAtMs &&
      m.deleteByMs - m.issuedAtMs <= MAX_RETENTION_MS &&
      checksum === digest(canonicalObservation(base)) && canonicalObservation(m) === bytes.toString("utf8"),
    "TRIAL_CONTENT_REJECTED");
    return Object.freeze(m);
  } catch (error) {
    if (error instanceof TrialDirectoryFailure) throw error;
    throw new TrialDirectoryFailure("TRIAL_CONTENT_REJECTED");
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function inspectTrial(root: string, trialId: string): TrialPaths {
  try {
    const path = trialPath(root, trialId); directoryIdentity(path, true);
    const marker = readMarker(path);
    const names = readdirSync(path);
    requireTrial(marker.trialId === trialId && names.every(n => [MARKER, "data", LEASE].includes(n)), "TRIAL_CONTENT_REJECTED");
    const data = join(path, "data");
    if (names.includes("data")) directoryIdentity(data, true);
    return Object.freeze({ root, trialId, directory: path, data, marker });
  } catch (error) {
    if (error instanceof TrialDirectoryFailure) throw error;
    throw new TrialDirectoryFailure("TRIAL_PATH_REJECTED");
  }
}
export function createTrial(root: string, trialId: string, captureMode: CaptureMode,
  nowMs = Date.now(), retentionMs = MAX_RETENTION_MS): TrialPaths {
  try {
    requireTrial(TRIAL_ID.test(trialId) && ["PRODUCTION", "ARTIFICIAL_PROTOCOL_TEST"].includes(captureMode) &&
      Number.isSafeInteger(nowMs) && nowMs >= 0 && Number.isSafeInteger(retentionMs) &&
      retentionMs > 0 && retentionMs <= MAX_RETENTION_MS && Number.isSafeInteger(nowMs + retentionMs), "TRIAL_PATH_REJECTED");
    requireTrial(captureMode !== "PRODUCTION" || root === DEFAULT_LIVE_ROOT, "TRIAL_PATH_REJECTED");
    prepareTrialRoot(root, true);
    const disk = statfsSync(root);
    requireTrial(disk.bavail * disk.bsize >= QUOTA_BYTES + 4 * MANIFEST_RESERVE, "TRIAL_QUOTA");
    const path = trialPath(root, trialId);
    mkdirSync(path, { mode: 0o700 });
    const base = { schema: "TICKSTREAM_TRIAL_DIRECTORY_V1" as const, trialId, captureMode, issuedAtMs: nowMs,
      // Conservative: at most 24h FROM START, never extends an unknown finish.
      deleteByMs: nowMs + retentionMs };
    const fd = openSync(join(path, MARKER), "wx", 0o600);
    try { writeFully(fd, Buffer.from(canonicalObservation({ ...base, checksum: digest(canonicalObservation(base)) }))); fsyncSync(fd); }
    finally { closeSync(fd); }
    mkdirSync(join(path, "data"), { mode: 0o700 }); directorySync(path); directorySync(root);
    return inspectTrial(root, trialId);
  } catch (error) {
    if (error instanceof TrialDirectoryFailure) throw error;
    throw new TrialDirectoryFailure("TRIAL_IO");
  }
}
export function trialAuthorization(paths: TrialPaths, confirmation: {
  explicitMode: "GATE_B2B"; dataPermission: boolean; replitStoragePermission: boolean; manualCleanupConfirmed: boolean;
}, nowMs = Date.now()): LiveAuthorization {
  const current = inspectTrial(paths.root, paths.trialId);
  return authorizeLiveStorage({ ...confirmation, ...current.marker, directory: current.data }, nowMs);
}
/** Metadata only: expired log bytes are NEVER opened or interpreted. No deletion
 * or recovery is attempted. Caller must HOLD and request explicit one-trial purge. */
export function scanExpiredTrials(root = DEFAULT_LIVE_ROOT, nowMs = Date.now()): readonly string[] {
  if (!existsSync(root)) return [];
  prepareTrialRoot(root);
  const names = readdirSync(root);
  requireTrial(names.length <= 128, "TRIAL_CONTENT_REJECTED");
  return Object.freeze(names.filter(id => inspectTrial(root, id).marker.deleteByMs <= nowMs));
}
function leasePid(p: TrialPaths): number | null {
  if (!readdirSync(p.directory).includes(LEASE)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(join(p.directory, LEASE), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    requireTrial(st.isFile() && st.nlink === 1 && (st.mode & 0o777) === 0o600 && st.size <= 128 &&
      (process.getuid === undefined || st.uid === process.getuid()), "TRIAL_CONTENT_REJECTED");
    const bytes = Buffer.alloc(st.size);
    requireTrial(readSync(fd, bytes, 0, bytes.length, 0) === bytes.length, "TRIAL_CONTENT_REJECTED");
    const m = JSON.parse(bytes.toString("utf8"));
    requireTrial(Object.keys(m).length === 2 && m.trialId === p.trialId &&
      Number.isSafeInteger(m.pid) && m.pid > 0, "TRIAL_CONTENT_REJECTED"); return m.pid;
  } catch { throw new TrialDirectoryFailure("TRIAL_CONTENT_REJECTED"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function claimTrialLease(p: TrialPaths): void {
  inspectTrial(p.root, p.trialId);
  const fd = openSync(join(p.directory, LEASE), "wx", 0o600);
  try { writeFully(fd, Buffer.from(JSON.stringify({ trialId: p.trialId, pid: process.pid }))); fsyncSync(fd); }
  finally { closeSync(fd); }
  directorySync(p.directory);
}
export function releaseTrialLease(p: TrialPaths): void {
  requireTrial(leasePid(p) === process.pid, "TRIAL_ACTIVE");
  unlinkSync(join(p.directory, LEASE)); directorySync(p.directory);
}
/** No recursive rm, wildcard, all-trials switch or arbitrary path. Prevalidate
 * every file BEFORE the first unlink. Partial deletion retains the marker so a
 * retry can validate the same identity. Never breaks a lease on another trial. */
export function purgeTrial(root: string, trialId: string): { deleted: true; remainingFiles: 0; trialId: string } {
  try {
    const p = inspectTrial(root, trialId), pid = leasePid(p);
    if (pid !== null) {
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      requireTrial(!alive, "TRIAL_ACTIVE");
    }
    const dataPresent = readdirSync(p.directory).includes("data"), files = dataPresent ? readdirSync(p.data) : [];
    requireTrial(files.every(n => (LIVE_FILES as readonly string[]).includes(n)), "TRIAL_CONTENT_REJECTED");
    for (const name of files) {
      const st = lstatSync(join(p.data, name));
      requireTrial(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && (st.mode & 0o777) === 0o600 &&
        (process.getuid === undefined || st.uid === process.getuid()) &&
        st.size <= (name === LIVE_LOG ? QUOTA_BYTES : MANIFEST_RESERVE), "TRIAL_CONTENT_REJECTED");
    }
    for (const name of files) unlinkSync(join(p.data, name));
    if (dataPresent) { directorySync(p.data); rmdirSync(p.data); directorySync(p.directory); }
    if (pid !== null) unlinkSync(join(p.directory, LEASE));
    unlinkSync(join(p.directory, MARKER)); directorySync(p.directory);
    rmdirSync(p.directory); directorySync(root);
    requireTrial(!existsSync(p.directory), "TRIAL_DELETE_FAILED");
    return { deleted: true, remainingFiles: 0, trialId };
  } catch (error) {
    if (error instanceof TrialDirectoryFailure) throw error;
    throw new TrialDirectoryFailure("TRIAL_DELETE_FAILED");
  }
}
