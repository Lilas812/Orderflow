import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { canonicalObservation } from "@workspace/tickstream-adapter/live-observation";
import { writeFully } from "./manifest";
import { directorySync, LIVE_FILES, LIVE_LOCK, LIVE_LOG, LIVE_TEMP, liveDirectory, liveRead,
  MANIFEST_RESERVE, publishLiveManifest, QUOTA_BYTES, readLiveManifest, sealLiveManifest,
  ZERO_HASH, type LiveFault, type LiveManifest } from "./liveManifest";
import { assertReceiveOrder, liveCheck, LiveFailure, OFFLINE_LIVE_MODE, validateLiveRecord, type LiveTickRecord } from "./liveRecord";
import { encodeLiveFrame } from "./liveRecovery";

export interface LiveAppendOptions {
  readonly testMode: typeof OFFLINE_LIVE_MODE;
  readonly quotaBytes?: number;
  readonly fault?: LiveFault;
}
export interface LiveReceipt { readonly position: number; readonly head: string; readonly bytes: number }
/** B-2A ONLY: new empty offline-test directory, no resume, no production mode.
 * Once an append has an unknown outcome the writer is permanently poisoned. */
export class LiveAppendStore {
  readonly directory: string;
  private fd: number | undefined;
  private lock: number | undefined;
  private failed = false;
  private closed = false;
  private readonly quota: number;
  private head: LiveManifest;
  private previous: LiveTickRecord | undefined;
  constructor(directory: string, private readonly options: LiveAppendOptions) {
    liveCheck(options?.testMode === OFFLINE_LIVE_MODE &&
      Object.keys(options).every(k => ["testMode", "quotaBytes", "fault"].includes(k)), "LIVE_PRODUCTION_DISABLED");
    this.directory = liveDirectory(directory);
    this.quota = options.quotaBytes ?? QUOTA_BYTES;
    liveCheck(Number.isSafeInteger(this.quota) && this.quota >= MANIFEST_RESERVE * 2 &&
      this.quota <= QUOTA_BYTES, "LIVE_STORE_QUOTA");
    try { liveCheck(readdirSync(this.directory).length === 0, "LIVE_STORE_EXISTS"); }
    catch (error) {
      if (error instanceof LiveFailure) throw error;
      throw new LiveFailure("LIVE_STORE_IO");
    }
    this.head = sealLiveManifest({ schema: "TICKSTREAM_LIVE_APPEND_V1", mode: OFFLINE_LIVE_MODE,
      environment: "LIVE", sessionId: randomUUID(), count: 0, bytes: 0, head: ZERO_HASH });
    try {
      this.lock = openSync(join(this.directory, LIVE_LOCK), "wx", 0o600);
      this.fd = openSync(join(this.directory, LIVE_LOG), "wx", 0o600);
      fsyncSync(this.fd);
      publishLiveManifest(this.directory, this.head);
    } catch { this.release(); throw new LiveFailure("LIVE_STORE_IO"); }
  }
  get persisted(): number { return this.head.count; }
  append(input: LiveTickRecord): LiveReceipt {
    liveCheck(!this.closed && this.fd !== undefined, "LIVE_STORE_CLOSED");
    liveCheck(!this.failed, "LIVE_STORE_FAILED");
    // Even a definite validation/quota failure ends this session; no silent skip.
    let writing = false;
    try {
      const record = validateLiveRecord(input);
      assertReceiveOrder(this.previous, record);
      liveCheck(this.head.count < 1000, "LIVE_STORE_QUOTA");
      const frame = encodeLiveFrame({ sessionId: this.head.sessionId, position: this.head.count + 1,
        previousHash: this.head.head, record });
      const files = readdirSync(this.directory);
      liveCheck(files.every(n => (LIVE_FILES as readonly string[]).includes(n)) && !files.includes(LIVE_TEMP),
        "LIVE_STORE_CORRUPT");
      let disk = 0;
      for (const name of files) {
        const fd = liveRead(this.directory, name, name === LIVE_LOG ? QUOTA_BYTES : MANIFEST_RESERVE);
        try { disk += fstatSync(fd).size; } finally { closeSync(fd); }
      }
      const pathStat = lstatSync(join(this.directory, LIVE_LOG)), fdStat = fstatSync(this.fd);
      liveCheck(pathStat.ino === fdStat.ino && pathStat.dev === fdStat.dev && fdStat.size === this.head.bytes &&
        canonicalObservation(readLiveManifest(this.directory)) === canonicalObservation(this.head), "LIVE_STORE_CORRUPT");
      liveCheck(disk + frame.data.length + MANIFEST_RESERVE <= this.quota, "LIVE_STORE_QUOTA");
      writing = true;
      this.options.fault?.("BEFORE_APPEND");
      // Two pieces provide an actual partially written tail for crash testing.
      const split = Math.floor(frame.data.length / 2);
      writeFully(this.fd, frame.data.subarray(0, split));
      this.options.fault?.("AFTER_PARTIAL_APPEND");
      writeFully(this.fd, frame.data.subarray(split));
      this.options.fault?.("AFTER_APPEND");
      this.options.fault?.("BEFORE_LOG_FSYNC"); fsyncSync(this.fd); this.options.fault?.("AFTER_LOG_FSYNC");
      const { checksum: _, ...base } = this.head;
      const next = sealLiveManifest({ ...base, count: this.head.count + 1,
        bytes: this.head.bytes + frame.data.length, head: frame.hash });
      publishLiveManifest(this.directory, next, this.options.fault);
      this.options.fault?.("AFTER_MANIFEST");
      this.head = next; this.previous = record;
      return Object.freeze({ position: next.count, head: next.head, bytes: next.bytes });
    } catch (error) {
      this.failed = true;
      if (!writing && error instanceof LiveFailure) throw error;
      throw new LiveFailure("LIVE_STORE_UNKNOWN");
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.release();
      if (!this.failed) { unlinkSync(join(this.directory, LIVE_LOCK)); directorySync(this.directory, this.options.fault); }
    } catch { this.failed = true; throw new LiveFailure("LIVE_STORE_IO"); }
  }
  private release(): void {
    const fd = this.fd, lock = this.lock;
    this.fd = undefined; this.lock = undefined;
    try { if (fd !== undefined) closeSync(fd); }
    finally { if (lock !== undefined) closeSync(lock); }
  }
}
