import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, fsyncSync, lstatSync,
  readSync, realpathSync, renameSync, writeSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalObservation } from "@workspace/tickstream-adapter/live-observation";

export const QUOTA_BYTES = 64 * 1024 * 1024;
export const MANIFEST_RESERVE = 4096;
export const ZERO_HASH = "0".repeat(64);
export const LOG_NAME = "observations.bin";
export const MANIFEST_NAME = "manifest.json";
export type StoreCode = "PRIVATE_DIRECTORY" | "STORE_EXISTS" | "STORE_CLOSED" | "STORE_FAILED" |
  "STORE_QUOTA" | "STORE_IO" | "STORE_CORRUPT" | "STORE_TAIL" | "STORE_UNKNOWN" |
  "STORE_INVALID_RECORD" | "LIVE_GATE_CLOSED";
export class StoreFailure extends Error {
  constructor(readonly code: StoreCode) { super(code); }
}
export function check(value: unknown, code: StoreCode): asserts value {
  if (!value) throw new StoreFailure(code);
}
export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export interface Manifest {
  schema: "TICKSTREAM_SYNTHETIC_APPEND_V1";
  sessionId: string;
  mode: "SYNTHETIC_TEST";
  count: number;
  bytes: number;
  head: string;
  checksum: string;
}
export function sealedManifest(value: Omit<Manifest, "checksum">): Manifest {
  return Object.freeze({ ...value, checksum: digest(canonicalObservation(value)) });
}
export function privateDirectory(directory: string): string {
  try {
    const root = resolve(directory), workspace = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
    const rel = relative(workspace, root);
    const st = lstatSync(root);
    check(isAbsolute(directory) && realpathSync(root) === root && st.isDirectory() &&
      !st.isSymbolicLink() && (st.mode & 0o077) === 0 &&
      (process.getuid === undefined || st.uid === process.getuid()) &&
      (rel === ".." || rel.startsWith("../") || isAbsolute(rel)), "PRIVATE_DIRECTORY");
    return root;
  } catch { throw new StoreFailure("PRIVATE_DIRECTORY"); }
}
export function privateRead(root: string, name: string, max: number): number {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    check(st.isFile() && st.nlink === 1 && (st.mode & 0o077) === 0 && st.size <= max, "STORE_CORRUPT");
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new StoreFailure("STORE_CORRUPT");
  }
}
export function writeFully(fd: number, data: Uint8Array): void {
  let n = 0;
  while (n < data.length) {
    const written = writeSync(fd, data, n, data.length - n);
    check(written > 0, "STORE_IO"); n += written;
  }
}
export function syncDirectory(root: string): void {
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Failure leaves old manifest intact or a new independently verifiable head.
 * Never roll back the log, silently remove a temp file, or return an I/O error. */
export function publishManifest(root: string, manifest: Manifest): void {
  const bytes = Buffer.from(canonicalObservation(manifest));
  check(bytes.length <= MANIFEST_RESERVE, "STORE_QUOTA");
  const fd = openSync(join(root, "manifest.next"), "wx", 0o600);
  try { writeFully(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(join(root, "manifest.next"), join(root, MANIFEST_NAME));
  syncDirectory(root);
}
export function readManifest(root: string): Manifest {
  const fd = privateRead(root, MANIFEST_NAME, MANIFEST_RESERVE);
  try {
    const bytes = Buffer.alloc(fstatSync(fd).size);
    let n = 0;
    while (n < bytes.length) { const k = readSync(fd, bytes, n, bytes.length - n, n); check(k > 0, "STORE_CORRUPT"); n += k; }
    const m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Manifest;
    const { checksum, ...base } = m;
    check(m.schema === "TICKSTREAM_SYNTHETIC_APPEND_V1" && m.mode === "SYNTHETIC_TEST" &&
      /^[a-f0-9-]{36}$/.test(m.sessionId) &&
      Number.isSafeInteger(m.count) && m.count >= 0 && m.count <= 1000 &&
      Number.isSafeInteger(m.bytes) && m.bytes >= 0 && m.bytes <= QUOTA_BYTES &&
      /^[a-f0-9]{64}$/.test(m.head) && checksum === digest(canonicalObservation(base)) &&
      Object.keys(m).length === 7, "STORE_CORRUPT");
    return Object.freeze(m);
  } catch { throw new StoreFailure("STORE_CORRUPT"); }
  finally { closeSync(fd); }
}
