import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { validateObservation, type ObservationRecord } from "@workspace/tickstream-adapter/live-observation";
import { encodeFrame } from "./recovery";
import { check, LOG_NAME, MANIFEST_RESERVE, QUOTA_BYTES, ZERO_HASH,
  privateDirectory, publishManifest, sealedManifest, StoreFailure,
  syncDirectory, type Manifest } from "./manifest";

export type WritePhase = "BEFORE_APPEND" | "AFTER_APPEND" | "AFTER_LOG_FSYNC" | "AFTER_MANIFEST";
export interface AppendOptions {
  /** Only smaller test budgets; never permits exceeding the safety ceiling. */
  quotaBytes?: number;
  /** Synthetic failure/crash injection. Never receives payload, URL or key. */
  fault?: (phase: WritePhase) => void;
}
export interface PersistenceReceipt {
  readonly position: number;
  readonly head: string;
  readonly bytes: number;
}
/** Gate A ONLY. New empty private directory, one writer, no Live or raw storage.
 * Existing sessions reopen read-only with recover(); no automatic lease breaking,
 * resume, deletion, retention, dedup, migration or tail repair is implemented.
 */
export class AppendStore {
  readonly directory: string;
  private fd: number | undefined;
  private lock: number | undefined;
  private failed = false;
  private readonly quota: number;
  private readonly seen = new Set<string>(); // finite receive keys, never price/content dedup
  private head: Manifest;
  constructor(directory: string, private readonly options: AppendOptions = {}) {
    this.directory = privateDirectory(directory);
    this.quota = options.quotaBytes ?? QUOTA_BYTES;
    check(Number.isSafeInteger(this.quota) && this.quota >= 2 * MANIFEST_RESERVE &&
      this.quota <= QUOTA_BYTES, "STORE_QUOTA");
    check(readdirSync(this.directory).length === 0, "STORE_EXISTS");
    this.head = sealedManifest({ schema: "TICKSTREAM_SYNTHETIC_APPEND_V1",
      mode: "SYNTHETIC_TEST", sessionId: randomUUID(), count: 0, bytes: 0, head: ZERO_HASH });
    try {
      this.lock = openSync(join(this.directory, "writer.lock"), "wx", 0o600);
      this.fd = openSync(join(this.directory, LOG_NAME), "wx", 0o600);
      fsyncSync(this.fd);
      publishManifest(this.directory, this.head);
    } catch {
      this.release(); throw new StoreFailure("STORE_IO");
    }
  }
  get persisted(): number { return this.head.count; }
  append(input: ObservationRecord): PersistenceReceipt {
    check(this.fd !== undefined, "STORE_CLOSED");
    check(!this.failed, "STORE_FAILED");
    let record: ObservationRecord;
    try { record = validateObservation(input); } catch { throw new StoreFailure("STORE_INVALID_RECORD"); }
    check(record.provenance.environment === "SIMULATED", "LIVE_GATE_CLOSED");
    const key = `${record.provenance.connectionEpoch}:${record.provenance.receiveOrdinal}`;
    check(!this.seen.has(key), "STORE_INVALID_RECORD");
    check(this.head.count < 1000, "STORE_QUOTA");
    const frame = encodeFrame({ sessionId: this.head.sessionId, position: this.head.count + 1,
      previousHash: this.head.head, record });
    const files = readdirSync(this.directory);
    check(files.length <= 3 && files.every(name => [LOG_NAME, "manifest.json", "writer.lock"].includes(name)), "STORE_CORRUPT");
    const onDisk = files.reduce((n, name) => n + statSync(join(this.directory, name)).size, 0);
    check(onDisk + frame.data.length + MANIFEST_RESERVE <= this.quota, "STORE_QUOTA");
    try {
      this.options.fault?.("BEFORE_APPEND");
      // writeFully handles partial writes; acknowledgement is after BOTH fsyncs.
      let offset = 0;
      while (offset < frame.data.length) {
        const n = writeChunk(this.fd, frame.data, offset);
        check(n > 0, "STORE_IO"); offset += n;
      }
      this.options.fault?.("AFTER_APPEND");
      fsyncSync(this.fd);
      this.options.fault?.("AFTER_LOG_FSYNC");
      const { checksum: _oldChecksum, ...base } = this.head;
      const candidate = sealedManifest({ ...base, count: this.head.count + 1,
        bytes: this.head.bytes + frame.data.length, head: frame.hash });
      publishManifest(this.directory, candidate);
      this.options.fault?.("AFTER_MANIFEST");
      this.head = candidate; this.seen.add(key);
      return Object.freeze({ position: candidate.count, head: candidate.head, bytes: candidate.bytes });
    } catch {
      // A successful fsync/rename with a lost return is UNKNOWN, not failure proof.
      // Keep old public counters; forbid retry/re-INSERT; reopen independently.
      this.failed = true; throw new StoreFailure("STORE_UNKNOWN");
    }
  }
  close(): void {
    if (this.fd === undefined && this.lock === undefined) return;
    this.release();
    // Evidence is retained after unknown I/O. Never silently remove a stale lease.
    if (!this.failed) {
      try { unlinkSync(join(this.directory, "writer.lock")); syncDirectory(this.directory); }
      catch { throw new StoreFailure("STORE_IO"); }
    }
  }
  private release(): void {
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
    if (this.lock !== undefined) { closeSync(this.lock); this.lock = undefined; }
  }
}
import { writeSync as write } from "node:fs";
function writeChunk(fd: number, bytes: Buffer, offset: number): number {
  return write(fd, bytes, offset, bytes.length - offset);
}
