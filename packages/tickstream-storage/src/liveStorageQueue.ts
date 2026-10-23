import { canonicalObservation, type ObservationRecord } from "@workspace/tickstream-adapter/live-observation";
import { LiveAppendStore } from "./liveAppendStore";
import { LIVE_CODES, liveCheck, LiveFailure, offlineLiveRecord, OFFLINE_LIVE_MODE,
  validateLiveRecord, type LiveCode, type LiveTickRecord } from "./liveRecord";

export interface LiveQueueReport {
  readonly mode: typeof OFFLINE_LIVE_MODE;
  readonly phase: "OPEN" | "STOPPED" | "FAILED" | "ABORTED";
  readonly reason: LiveCode | null;
  readonly offered: number;
  readonly enqueued: number;
  readonly persisted: number;
  readonly pending: number;
  readonly pendingBytes: number;
  /** Subset of pending; never interpreted as proof of commit failure/success. */
  readonly unknown: number;
  readonly refused: number;
  readonly unpersisted: number;
  readonly peakCount: number;
  readonly peakBytes: number;
  readonly accountingMatches: boolean;
}
export interface LiveQueueOptions {
  readonly maxCount?: number;
  readonly maxBytes?: number;
  readonly manualDrain?: boolean;
  readonly schedule?: (callback: () => void) => () => void;
}
/** Owns at most 128 records/8MiB. A failed head remains owned; no auto retry.
 * No market records or free-text exceptions are returned by diagnostics. */
export class LiveStorageQueue {
  readonly testOnly = true as const;
  private readonly entries: { record: LiveTickRecord; bytes: number }[] = [];
  private bytes = 0;
  private phase: LiveQueueReport["phase"] = "OPEN";
  private reason: LiveCode | null = null;
  private offered = 0;
  private enqueued = 0;
  private refused = 0;
  private unknown = 0;
  private peakCount = 0;
  private peakBytes = 0;
  private cancel: (() => void) | undefined;
  private failureHandler: (() => void) | undefined;
  private readonly maxCount: number;
  private readonly maxBytes: number;
  constructor(private readonly store: LiveAppendStore, private readonly options: LiveQueueOptions = {}) {
    this.maxCount = options.maxCount ?? 128; this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    liveCheck(Number.isInteger(this.maxCount) && this.maxCount >= 1 && this.maxCount <= 128, "LIVE_QUEUE_COUNT_LIMIT");
    liveCheck(Number.isInteger(this.maxBytes) && this.maxBytes >= 1 && this.maxBytes <= 8 * 1024 * 1024, "LIVE_QUEUE_BYTE_LIMIT");
    liveCheck(store.persisted === 0, "LIVE_STORE_EXISTS");
  }
  onFailure(callback: () => void): void { this.failureHandler = callback; }
  report(): LiveQueueReport {
    return Object.freeze({ mode: OFFLINE_LIVE_MODE, phase: this.phase, reason: this.reason,
      offered: this.offered, enqueued: this.enqueued, persisted: this.store.persisted,
      pending: this.entries.length, pendingBytes: this.bytes, unknown: this.unknown,
      refused: this.refused, unpersisted: this.offered - this.store.persisted,
      peakCount: this.peakCount, peakBytes: this.peakBytes,
      accountingMatches: this.offered === this.refused + this.entries.length + this.store.persisted });
  }
  accept(input: ObservationRecord): void {
    this.ensureOpen();
    let record: LiveTickRecord;
    try { record = offlineLiveRecord(input); }
    catch (error) { this.offered++; this.refused++; this.fail(error); throw new LiveFailure(this.reason!); }
    this.enqueue(record);
  }
  enqueue(input: LiveTickRecord): void {
    this.ensureOpen(); this.offered++;
    let record: LiveTickRecord, bytes: number;
    try {
      record = validateLiveRecord(input); bytes = Buffer.byteLength(canonicalObservation(record));
      liveCheck(this.offered <= 1000, "LIVE_STORE_QUOTA");
      liveCheck(this.entries.length < this.maxCount, "LIVE_QUEUE_COUNT_LIMIT");
      liveCheck(this.bytes + bytes <= this.maxBytes, "LIVE_QUEUE_BYTE_LIMIT");
    } catch (error) { this.refused++; this.fail(error); throw new LiveFailure(this.reason!); }
    this.entries.push({ record, bytes }); this.enqueued++; this.bytes += bytes;
    this.peakCount = Math.max(this.peakCount, this.entries.length); this.peakBytes = Math.max(this.peakBytes, this.bytes);
    if (!this.options.manualDrain && !this.cancel) {
      const schedule = this.options.schedule ?? ((callback: () => void) => {
        const id = setImmediate(callback); return () => clearImmediate(id);
      });
      try { this.cancel = schedule(() => { this.cancel = undefined; this.drain(); }); }
      catch (error) { this.fail(error); throw new LiveFailure(this.reason!); }
    }
  }
  drain(): void {
    if (this.phase !== "OPEN") return;
    this.cancel?.(); this.cancel = undefined;
    while (this.entries.length) {
      const entry = this.entries[0];
      try { this.store.append(entry.record); }
      catch (error) {
        this.unknown = error instanceof LiveFailure && error.code === "LIVE_STORE_UNKNOWN" ? 1 : 0;
        this.fail(error); return;
      }
      this.entries.shift(); this.bytes -= entry.bytes;
    }
  }
  finish(): void {
    if (this.phase === "STOPPED") return;
    this.ensureOpen(); this.drain();
    if (this.phase !== "OPEN") throw new LiveFailure(this.reason!);
    try { this.store.close(); }
    catch (error) { this.fail(error); throw new LiveFailure(this.reason!); }
    this.phase = "STOPPED"; this.reason = "LIVE_FINISHED";
  }
  abort(): void {
    if (this.phase === "STOPPED" || this.phase === "ABORTED") return;
    this.cancel?.(); this.cancel = undefined;
    const failed = this.phase === "FAILED";
    try { this.store.close(); } catch (error) { this.fail(error); return; }
    if (!failed) { this.phase = "ABORTED"; this.reason = "LIVE_QUEUE_ABORTED"; }
    // Pending records are deliberately retained and counted, never auto flushed.
  }
  private ensureOpen(): void {
    liveCheck(this.phase === "OPEN", this.phase === "FAILED" ? "LIVE_QUEUE_FAILED" : "LIVE_QUEUE_CLOSED");
  }
  private fail(error: unknown): void {
    if (this.phase === "FAILED") return;
    this.phase = "FAILED";
    this.reason = error instanceof LiveFailure && LIVE_CODES.includes(error.code) ? error.code : "LIVE_STORE_IO";
    this.cancel?.(); this.cancel = undefined;
    try { this.failureHandler?.(); } catch { /* do not leak callback exceptions or change the first failure */ }
  }
}
