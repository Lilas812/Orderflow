import type { EventPipeline } from "./eventPipeline";
import { Latencies } from "./metrics";

export type CommitPolicy = "immediate" | "coalesced";
export interface CommitFrame {
  id: number; events: readonly unknown[]; bytes: number; submittedMonoNs: string;
}
export interface FrameReceipt {
  id: number; count: number; bytes: number; submittedMonoNs: string; receivedMs: number;
}
interface OwnedFrame { receipt: FrameReceipt; events: unknown[] }
type Reason = "immediate" | "capacity" | "timer" | "end" | "retry";
export interface SchedulerOptions {
  policy: CommitPolicy;
  clock?: () => number;
  maxPendingEvents?: number;
  maxPendingBytes?: number;
  onReceived?: (receipt: FrameReceipt) => void;
  onCommitted?: (receipt: FrameReceipt, completedMs: number) => void;
  onFailure?: (message: string) => void;
}

/** Owns whole IPC frames until the existing FULL commit returns. No persistent-format changes. */
export class CommitScheduler {
  readonly maxTransactionEvents = 128;
  readonly targetWaitMs = 10;
  private readonly frames: OwnedFrame[] = [];
  private staged: OwnedFrame[] | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastId = 0;
  private failed = false;
  private admissionFailed = false;
  private ended = false;
  private disposed = false;
  private count = 0;
  private bytes = 0;
  private readonly clock: () => number;
  readonly maxPendingEvents: number;
  readonly maxPendingBytes: number;
  private peakEvents = 0;
  private peakBytes = 0;
  private attempts = 0;
  private committedGroups = 0;
  private committedEvents = 0;
  private maxCommittedEvents = 0;
  private rejectedEvents = 0;
  private failures = 0;
  private readonly reasons: Partial<Record<Reason, number>> = {};
  private readonly firstToRequest = new Latencies();
  private readonly requestToStart = new Latencies();
  private readonly firstToStart = new Latencies();
  private readonly firstToCommit = new Latencies();
  private readonly eventToCommit = new Latencies();
  private readonly timerLateness = new Latencies();
  constructor(private readonly pipeline: Pick<EventPipeline, "receive" | "drain">,
    private readonly scope: string, private readonly options: SchedulerOptions) {
    this.clock = options.clock ?? (() => performance.now());
    this.maxPendingEvents = options.maxPendingEvents ?? 2048;
    this.maxPendingBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
    if (!["immediate", "coalesced"].includes(options.policy) ||
      !Number.isSafeInteger(this.maxPendingEvents) || this.maxPendingEvents < 1 || this.maxPendingEvents > 2048 ||
      !Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes < 1 || this.maxPendingBytes > 8 * 1024 * 1024)
      throw new TypeError("Scheduler limits cannot exceed the approved envelope");
  }
  get pendingEvents() { return this.count; }
  get blocked() { return this.failed; }
  accept(frame: CommitFrame, receivedMs = this.clock()): boolean {
    const count = Array.isArray(frame.events) ? frame.events.length : 0;
    if (this.disposed || this.ended || this.failed || frame.id !== this.lastId + 1 ||
      count < 1 || count > 128 || !Number.isSafeInteger(frame.bytes) || frame.bytes < 1 ||
      !/^[0-9]+$/.test(frame.submittedMonoNs) || !Number.isFinite(receivedMs) || receivedMs > this.clock() ||
      this.count + count > this.maxPendingEvents || this.bytes + frame.bytes > this.maxPendingBytes) {
      this.rejectedEvents += count;
      throw new Error("IPC_NOT_ADMITTED: order/state/capacity invalid; each message must contain 1..128 events");
    }
    // Private ownership copy is equally applied to both comparison policies.
    const owned: OwnedFrame = { events: structuredClone(frame.events) as unknown[],
      receipt: { id: frame.id, count, bytes: frame.bytes, submittedMonoNs: frame.submittedMonoNs, receivedMs } };
    this.frames.push(owned); this.lastId = frame.id;
    this.count += count; this.bytes += frame.bytes;
    this.peakEvents = Math.max(this.peakEvents, this.count); this.peakBytes = Math.max(this.peakBytes, this.bytes);
    this.options.onReceived?.({ ...owned.receipt });
    if (this.options.policy === "immediate") return this.flushOne("immediate");
    // A whole next frame may not fit: commit the maximal whole-frame prefix, never split it.
    while (this.count >= 128) if (!this.flushOne("capacity")) return false;
    this.arm();
    return true;
  }
  private cancelTimer() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private arm() {
    this.cancelTimer();
    if (!this.frames.length || this.failed || this.disposed || this.ended) return;
    const remaining = Math.ceil(Math.max(0, this.frames[0].receipt.receivedMs + 10 - this.clock()));
    this.timer = setTimeout(() => {
      this.timer = null;
      if(this.clock()<this.frames[0].receipt.receivedMs+10){this.arm();return;}
      if (!this.flushOne("timer")) return;
      this.arm();
    }, remaining);
  }
  private fail(message: string): false {
    this.failed = true; this.failures++; this.cancelTimer();
    this.options.onFailure?.(message);
    return false;
  }
  private flushOne(reason: Reason): boolean {
    if (this.failed || this.disposed) return false;
    if (!this.frames.length) return true;
    this.cancelTimer();
    const requested = this.clock(), oldest = this.frames[0].receipt.receivedMs;
    this.firstToRequest.add(Math.max(0, requested - oldest));
    if (reason === "timer") this.timerLateness.add(Math.max(0, requested - oldest - 10));
    if (!this.staged) {
      const group: OwnedFrame[] = []; let count = 0;
      for (const f of this.frames) {
        if (count + f.receipt.count > 128) break;
        group.push(f); count += f.receipt.count;
      }
      this.staged = group;
      // Never re-enqueue this group on a storage retry. EventPipeline retains its own copy on failure.
      for (const f of group) for (const event of f.events) if (!this.pipeline.receive(this.scope, event)) {
        this.admissionFailed = true;
        return this.fail("PIPELINE_ADMISSION_FAILED: owned group retained; automatic retry prohibited");
      }
    }
    const begin = this.clock();
    this.requestToStart.add(Math.max(0, begin - requested));
    this.firstToStart.add(Math.max(0, begin - oldest)); this.attempts++;
    let ok: boolean;
    try { ok = this.pipeline.drain(); } catch (error) { return this.fail(`STORAGE_ERROR: ${error}`); }
    if (!ok) return this.fail("STORAGE_ERROR: group retained without commit acknowledgement");
    const completed = this.clock(), group = this.staged;
    const count = group.reduce((n, f) => n + f.receipt.count, 0);
    this.committedGroups++; this.committedEvents += count; this.maxCommittedEvents = Math.max(this.maxCommittedEvents, count);
    this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
    this.firstToCommit.add(Math.max(0, completed - oldest));
    this.frames.splice(0, group.length); this.staged = null; this.count -= count;
    this.bytes -= group.reduce((n, f) => n + f.receipt.bytes, 0);
    for (const f of group) {
      for (let i = 0; i < f.receipt.count; i++) this.eventToCommit.add(Math.max(0, completed - f.receipt.receivedMs));
      this.options.onCommitted?.({ ...f.receipt }, completed);
    }
    return true;
  }
  finish(): boolean {
    this.ended = true; this.cancelTimer();
    while (this.frames.length) if (!this.flushOne("end")) return false;
    return !this.failed;
  }
  retry(): boolean {
    if (this.disposed || this.admissionFailed) return false;
    this.failed = false;
    while (this.frames.length) if (!this.flushOne("retry")) return false;
    if (!this.ended) this.arm();
    return true;
  }
  dispose(): void { this.cancelTimer(); this.disposed = true; } // Does not discard pending ownership.
  snapshot() {
    return { policy: this.options.policy, targetWaitMs: 10, maxTransactionEvents: 128,
      pendingEvents: this.count, pendingBytes: this.bytes, peakPendingEvents: this.peakEvents, peakPendingBytes: this.peakBytes,
      blocked: this.failed, rejectedEvents: this.rejectedEvents, failures: this.failures, attempts: this.attempts,
      committedGroups: this.committedGroups, committedEvents: this.committedEvents,
      meanTransactionEvents: this.committedGroups ? this.committedEvents / this.committedGroups : null,
      maxCommittedTransactionEvents: this.maxCommittedEvents, flushReasons: { ...this.reasons },
      firstEventToFlushRequestMs: this.firstToRequest.report(), requestToFlushStartMs: this.requestToStart.report(),
      firstEventToFlushStartMs: this.firstToStart.report(), firstEventToCommitMs: this.firstToCommit.report(),
      eventToCommitMs: this.eventToCommit.report(), timerRequestLatenessMs: this.timerLateness.report(),
      timingNote: "10ms is a request target, not an event-loop guarantee. Flush start is before existing synchronous drain; timings overlap." };
  }
}
