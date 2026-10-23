import { closeSync, fstatSync, lstatSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { canonicalObservation } from "@workspace/tickstream-adapter/live-observation";
import { digest, LIVE_FILES, LIVE_LOG, LIVE_TEMP, liveDirectory, liveRead,
  MANIFEST_RESERVE, QUOTA_BYTES, readLiveManifest, ZERO_HASH, type LiveManifest } from "./liveManifest";
import { assertReceiveOrder, LIVE_RECORD_BYTES, liveCheck, LiveFailure, validateLiveRecord, type LiveTickRecord } from "./liveRecord";

export const LIVE_MAGIC = Buffer.from("OLABLIV1");
export interface LiveFrameBody {
  sessionId: string;
  position: number;
  previousHash: string;
  record: LiveTickRecord;
}
export function encodeLiveFrame(body: LiveFrameBody): { data: Buffer; hash: string } {
  const bytes = Buffer.from(canonicalObservation(body));
  liveCheck(bytes.length > 0 && bytes.length <= LIVE_RECORD_BYTES + 512, "LIVE_RECORD_INVALID");
  const hash = digest(bytes), header = Buffer.alloc(12);
  LIVE_MAGIC.copy(header); header.writeUInt32BE(bytes.length, 8);
  return { data: Buffer.concat([header, bytes, Buffer.from(hash, "hex")]), hash };
}
export interface LiveRecovery {
  readonly status: "VERIFIED" | "TRUNCATED_TAIL" | "UNPUBLISHED_TAIL" | "PUBLISH_INTERRUPTED";
  readonly manifest: LiveManifest;
  readonly persistedCount: number;
  readonly verifiedCount: number;
  readonly tailBytes: number;
  readonly pendingManifest: boolean;
  readonly writerLockPresent: boolean;
  readonly peakReadBufferBytes: number;
}
/** Two bounded passes; all bytes checked before a visitor sees any record.
 * No repair, continuation, deletion, retained Trade list or skipped prefix. */
export function recoverLive(directory: string, visit?: (record: LiveTickRecord) => void): LiveRecovery {
  try { return scanLive(directory, visit); }
  catch (error) {
    if (error instanceof LiveFailure) throw error;
    throw new LiveFailure("LIVE_STORE_CORRUPT");
  }
}
function scanLive(directory: string, visit?: (record: LiveTickRecord) => void): LiveRecovery {
  const root = liveDirectory(directory), names = readdirSync(root);
  liveCheck(names.every(n => (LIVE_FILES as readonly string[]).includes(n)), "LIVE_STORE_CORRUPT");
  let diskBytes = 0;
  for (const name of names) {
    const st = lstatSync(join(root, name));
    liveCheck(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && (st.mode & 0o077) === 0, "LIVE_STORE_CORRUPT");
    liveCheck(name === LIVE_LOG || st.size <= MANIFEST_RESERVE, "LIVE_STORE_CORRUPT");
    diskBytes += st.size;
  }
  liveCheck(diskBytes <= QUOTA_BYTES, "LIVE_STORE_QUOTA");
  const manifest = readLiveManifest(root), fd = liveRead(root, LIVE_LOG, QUOTA_BYTES);
  try {
    const initial = fstatSync(fd), manifestText = canonicalObservation(manifest);
    const unchanged = () => {
      const current = fstatSync(fd), path = lstatSync(join(root, LIVE_LOG));
      liveCheck(current.size === initial.size &&
        current.mtimeMs === initial.mtimeMs && current.ctimeMs === initial.ctimeMs &&
        path.ino === initial.ino && path.dev === initial.dev && !path.isSymbolicLink() &&
        canonicalObservation(readLiveManifest(root)) === manifestText, "LIVE_STORE_UNKNOWN");
    };
    const readAt = (offset: number, length: number) => {
      const bytes = Buffer.alloc(length); let n = 0;
      while (n < length) { const k = readSync(fd, bytes, n, length - n, offset + n); liveCheck(k > 0, "LIVE_STORE_CORRUPT"); n += k; }
      return bytes;
    };
    let peak = 12;
    const pass = (publish: boolean) => {
      let offset = 0, count = 0, head = ZERO_HASH, partial = false, previous: LiveTickRecord | undefined;
      let boundary = manifest.bytes === 0;
      if (boundary) liveCheck(manifest.count === 0 && manifest.head === ZERO_HASH, "LIVE_STORE_CORRUPT");
      while (offset < initial.size) {
        const start = offset;
        if (initial.size - offset < 12) { partial = true; break; }
        const header = readAt(offset, 12); offset += 12;
        liveCheck(header.subarray(0, 8).equals(LIVE_MAGIC), "LIVE_STORE_CORRUPT");
        const length = header.readUInt32BE(8);
        liveCheck(length > 0 && length <= LIVE_RECORD_BYTES + 512, "LIVE_STORE_CORRUPT");
        if (initial.size - offset < length + 32) { partial = true; offset = start; break; }
        const bytes = readAt(offset, length), hash = readAt(offset + length, 32).toString("hex");
        offset += length + 32; peak = Math.max(peak, length + 44);
        liveCheck(digest(bytes) === hash, "LIVE_STORE_CORRUPT");
        const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as LiveFrameBody;
        liveCheck(Object.keys(body).length === 4 && body.sessionId === manifest.sessionId &&
          canonicalObservation(body) === bytes.toString("utf8") &&
          body.position === count + 1 && body.previousHash === head && count < 1000, "LIVE_STORE_CORRUPT");
        const record = validateLiveRecord(body.record);
        assertReceiveOrder(previous, record); previous = record;
        head = hash; count++;
        if (offset === manifest.bytes) {
          liveCheck(count === manifest.count && head === manifest.head, "LIVE_STORE_CORRUPT"); boundary = true;
        }
        liveCheck(boundary || offset < manifest.bytes, "LIVE_STORE_CORRUPT");
        if (publish) { unchanged(); visit!(record); unchanged(); }
      }
      liveCheck(boundary && offset >= manifest.bytes, "LIVE_STORE_CORRUPT"); unchanged();
      return { partial, offset, count };
    };
    const scanned = pass(false), pendingManifest = names.includes(LIVE_TEMP);
    const status = scanned.partial ? "TRUNCATED_TAIL" : scanned.offset > manifest.bytes ? "UNPUBLISHED_TAIL" :
      pendingManifest ? "PUBLISH_INTERRUPTED" : "VERIFIED";
    if (visit) {
      liveCheck(status === "VERIFIED", "LIVE_STORE_TAIL");
      pass(true);
    }
    return Object.freeze({ status, manifest, persistedCount: manifest.count, verifiedCount: scanned.count,
      tailBytes: initial.size - manifest.bytes, pendingManifest, writerLockPresent: names.includes("live-writer.lock"),
      peakReadBufferBytes: peak });
  } catch (error) {
    if (error instanceof LiveFailure && ["LIVE_STORE_UNKNOWN", "LIVE_STORE_TAIL"].includes(error.code)) throw error;
    throw new LiveFailure("LIVE_STORE_CORRUPT");
  } finally { closeSync(fd); }
}
