import { closeSync, fstatSync, readSync } from "node:fs";
import { MAX_RECORD_BYTES, canonicalObservation, validateObservation,
  type ObservationRecord } from "@workspace/tickstream-adapter/live-observation";
import { check, digest, LOG_NAME, QUOTA_BYTES, ZERO_HASH, privateDirectory, privateRead,
  readManifest, StoreFailure, type Manifest } from "./manifest";

export const MAGIC = Buffer.from("OLABOBS1");
export interface FrameBody {
  sessionId: string;
  position: number;
  previousHash: string;
  record: ObservationRecord;
}
export function encodeFrame(body: FrameBody): { data: Buffer; hash: string } {
  const bytes = Buffer.from(canonicalObservation(body));
  check(bytes.length <= MAX_RECORD_BYTES + 512, "STORE_INVALID_RECORD");
  const hash = digest(bytes), header = Buffer.alloc(12);
  MAGIC.copy(header); header.writeUInt32BE(bytes.length, 8);
  return { data: Buffer.concat([header, bytes, Buffer.from(hash, "hex")]), hash };
}
export interface Recovery {
  readonly status: "VERIFIED" | "TRUNCATED_TAIL" | "UNPUBLISHED_TAIL";
  readonly manifest: Manifest;
  readonly verifiedCount: number;
  readonly persistedCount: number;
  readonly tailBytes: number;
  readonly peakReadBufferBytes: number;
}
/** Full sequential verification every call. No verified-prefix skipping.
 * At most one framed record is in RAM; consumer callbacks cannot change disk.
 * Tail is evidence, NEVER an implicit truncation or a successful commit.
 */
export function recover(directory: string, visit?: (record: ObservationRecord, committed: boolean) => void): Recovery {
  const root = privateDirectory(directory), manifest = readManifest(root);
  const fd = privateRead(root, LOG_NAME, QUOTA_BYTES);
  try {
    const initial = fstatSync(fd), size = initial.size;
    let offset = 0, count = 0, head = ZERO_HASH, boundary = manifest.bytes === 0;
    let partial = false, peak = 12;
    const receiveKeys = new Set<string>(); // finite 1000-frame Gate A only, NOT Trade dedup
    if (boundary) check(manifest.count === 0 && manifest.head === ZERO_HASH, "STORE_CORRUPT");
    const readAt = (length: number): Buffer => {
      const b = Buffer.alloc(length); let n = 0;
      while (n < length) { const k = readSync(fd, b, n, length - n, offset + n); check(k > 0, "STORE_CORRUPT"); n += k; }
      offset += length; return b;
    };
    while (offset < size) {
      const start = offset;
      if (size - offset < 12) { partial = true; break; }
      const header = readAt(12);
      check(header.subarray(0, 8).equals(MAGIC), "STORE_CORRUPT");
      const length = header.readUInt32BE(8);
      check(length > 0 && length <= MAX_RECORD_BYTES + 512, "STORE_CORRUPT");
      if (size - offset < length + 32) { partial = true; offset = start; break; }
      const bytes = readAt(length), hash = readAt(32).toString("hex");
      peak = Math.max(peak, length + 44);
      check(digest(bytes) === hash, "STORE_CORRUPT");
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as FrameBody;
      check(Object.keys(body).length === 4 && body.sessionId === manifest.sessionId &&
        canonicalObservation(body) === bytes.toString("utf8") &&
        body.position === count + 1 && body.previousHash === head && count < 1000, "STORE_CORRUPT");
      const record = validateObservation(body.record);
      check(record.provenance.environment === "SIMULATED", "LIVE_GATE_CLOSED");
      const key = `${record.provenance.connectionEpoch}:${record.provenance.receiveOrdinal}`;
      check(!receiveKeys.has(key), "STORE_CORRUPT"); receiveKeys.add(key);
      head = hash; count++;
      if (offset === manifest.bytes) {
        check(count === manifest.count && head === manifest.head, "STORE_CORRUPT"); boundary = true;
      }
      if (!boundary && offset > manifest.bytes) throw new StoreFailure("STORE_CORRUPT");
    }
    check(boundary && offset >= manifest.bytes, "STORE_CORRUPT");
    const after = fstatSync(fd);
    check(after.size === initial.size && after.mtimeMs === initial.mtimeMs && after.ctimeMs === initial.ctimeMs, "STORE_UNKNOWN");
    const status = partial ? "TRUNCATED_TAIL" : offset > manifest.bytes ? "UNPUBLISHED_TAIL" : "VERIFIED";
    const result: Recovery = Object.freeze({ status, manifest, verifiedCount: count,
      persistedCount: manifest.count, tailBytes: size - manifest.bytes, peakReadBufferBytes: peak });
    // Do not publish records to a visitor before the complete file is verified.
    // A separate bounded pass is intentional, not an incremental-verification optimisation.
    if (visit) {
      check(status === "VERIFIED", "STORE_TAIL");
      let pos = 0, previous = ZERO_HASH;
      while (pos < manifest.bytes) {
        const header = Buffer.alloc(12);
        check(readSync(fd, header, 0, 12, pos) === 12, "STORE_CORRUPT");
        check(header.subarray(0, 8).equals(MAGIC), "STORE_CORRUPT");
        const len = header.readUInt32BE(8);
        check(len > 0 && len <= MAX_RECORD_BYTES + 512, "STORE_CORRUPT");
        const bytes = Buffer.alloc(len), hashBytes = Buffer.alloc(32);
        check(readSync(fd, bytes, 0, len, pos + 12) === len, "STORE_CORRUPT");
        check(readSync(fd, hashBytes, 0, 32, pos + 12 + len) === 32 &&
          digest(bytes) === hashBytes.toString("hex"), "STORE_CORRUPT");
        const body = JSON.parse(bytes.toString("utf8")) as FrameBody;
        check(body.previousHash === previous, "STORE_CORRUPT"); previous = hashBytes.toString("hex");
        const current = fstatSync(fd);
        check(current.size === size && current.mtimeMs === initial.mtimeMs && current.ctimeMs === initial.ctimeMs, "STORE_UNKNOWN");
        visit(validateObservation(body.record), true);
        pos += 44 + len;
      }
      check(fstatSync(fd).size === size && previous === manifest.head, "STORE_UNKNOWN");
    }
    return result;
  } catch (error) {
    if (error instanceof StoreFailure) throw error;
    throw new StoreFailure("STORE_CORRUPT");
  } finally { closeSync(fd); }
}
