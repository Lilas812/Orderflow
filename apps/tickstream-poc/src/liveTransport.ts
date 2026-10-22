import { canonicalObservation, parseObservation, type ObservationRecord, type ReceiveContext } from "@workspace/tickstream-adapter/live-observation";
import type { PersistenceReceipt } from "@workspace/tickstream-storage";
import { LIMITS, type Clock, type Socket, type SocketEvent } from "./transport";
import { watchdog } from "./session";
import { classifyMessage } from "./liveControl";
import { LiveDiagnostics, type LiveReason } from "./liveDiagnostics";

export type LiveSocketEvent = SocketEvent | { type: "entitlementRejected" | "connectionLimit" };
export interface GateASocket extends Omit<Socket, "listen"> {
  listen(listener: (event: LiveSocketEvent) => void): void;
}
export interface ObservationSink { append(record: ObservationRecord): PersistenceReceipt }
interface Entry { bytes: Uint8Array; context: ReceiveContext }
export interface TransportOptions {
  channel: "ticks" | "book";
  manualDrain?: boolean;
  finishAfter?: number;
}
/** Separate observation pipeline. Never changes the old canonical MarketEvent,
 * quality, dedup or MBP algorithms. All construction here is SYNTHETIC Gate A.
 */
export class ObservationTransport {
  readonly diagnostics = new LiveDiagnostics();
  private readonly receiveQueue: Entry[] = [];
  private readonly storageQueue: { record: ObservationRecord; bytes: number }[] = [];
  private inflight: ObservationRecord | null = null;
  private receiveBytes = 0;
  private storageBytes = 0;
  private ordinal = 0;
  private epoch = 0;
  private socket: GateASocket | undefined;
  private readonly timers = new Map<string, () => void>();
  private startedAt = 0n;
  private activeAt: bigint | null = null;
  private started = false;
  private terminalCallback: (() => void) | undefined;
  constructor(private readonly clock: Clock, private readonly factory: () => GateASocket,
    private readonly sink: ObservationSink, private readonly options: TransportOptions) {
    if (!["ticks", "book"].includes(options.channel) || (options.finishAfter !== undefined &&
      (!Number.isInteger(options.finishAfter) || options.finishAfter < 1 || options.finishAfter > LIMITS.messages))) {
      throw new Error("GATE_A_OPTIONS");
    }
  }
  get terminal(): boolean { return this.diagnostics.state === "STOPPED" || this.diagnostics.state === "FAILED"; }
  get capacity() { return {
    count: Math.max(this.receiveQueue.length, this.storageQueue.length),
    bytes: Math.max(this.receiveBytes, this.storageBytes),
  }; }
  get pendingStorage(): number { return this.storageQueue.length + (this.inflight ? 1 : 0); }
  report() { return this.diagnostics.report(this.receiveQueue.length, this.pendingStorage); }
  onTerminal(callback: () => void): void { this.terminalCallback = callback; }
  private timer(name: string, ms: number, callback: () => void): void {
    this.timers.get(name)?.();
    this.timers.set(name, this.clock.schedule(ms, () => {
      this.timers.delete(name); if (!this.terminal) callback();
    }));
  }
  start(): void {
    if (this.started) throw new Error("GATE_A_ALREADY_STARTED");
    this.started = true; this.startedAt = this.clock.monoNs();
    this.diagnostics.state = "RUNNING";
    this.timer("wall", LIMITS.wallMs, () => this.stop("WALL_TIME_LIMIT"));
    this.connect();
  }
  private connect(): void {
    if (this.terminal) return;
    this.epoch++;
    this.diagnostics.counts.connectionAttempts++;
    this.timer("handshake", LIMITS.handshakeMs, () => this.stop("HANDSHAKE_TIMEOUT"));
    try {
      const epoch = this.epoch, socket = this.factory(); this.socket = socket;
      socket.listen(event => { if (!this.terminal && epoch === this.epoch) this.event(event); });
      socket.connect();
    } catch { this.stop("SOCKET_ERROR"); }
  }
  private heartbeat(): void {
    this.timer("heartbeat", LIMITS.heartbeatMs, () => this.stop("HEARTBEAT_TIMEOUT"));
  }
  /** Synchronous filesystem work may delay timer callbacks. Check observed
   * deadlines between every unit of work too; this is NOT an OS preemption bound. */
  private withinDeadline(): boolean {
    const now = this.clock.monoNs();
    if (now - this.startedAt >= BigInt(LIMITS.wallMs) * 1_000_000n) {
      this.stop("WALL_TIME_LIMIT"); return false;
    }
    if (this.activeAt !== null && now - this.activeAt >= BigInt(LIMITS.activeMs) * 1_000_000n) {
      this.stop("ACTIVE_TIME_LIMIT"); return false;
    }
    return !this.terminal;
  }
  private event(event: LiveSocketEvent): void {
    const c = this.diagnostics.counts;
    switch (event.type) {
      case "open":
        this.timers.get("handshake")?.(); this.timers.delete("handshake");
        if (this.activeAt === null) {
          this.activeAt = this.clock.monoNs();
          this.timer("active", LIMITS.activeMs, () => this.stop("ACTIVE_TIME_LIMIT", false));
        }
        this.heartbeat(); c.subscriptionAttempts++;
        try { this.socket?.subscribe(); } catch { this.stop("SOCKET_ERROR"); }
        return;
      case "subscribed": return; // Never turn a fake/local signal into provider ACK.
      case "authRejected": this.stop("AUTH_REJECTED"); return;
      case "entitlementRejected": this.stop("ENTITLEMENT_REJECTED"); return;
      case "connectionLimit": this.stop("CONNECTION_LIMIT"); return;
      case "subscriptionRejected": this.stop("SUBSCRIPTION_REJECTED"); return;
      case "wsPing": case "wsPong":
        c.heartbeat++; this.heartbeat(); return; // native autoPong is sole protocol-pong owner
      case "protocolError": case "fragment":
        c.protocolFailures++; this.stop("PROTOCOL_FAILURE"); return;
      case "error": this.stop("SOCKET_ERROR"); return;
      case "close":
        c.disconnects++;
        if (c.reconnectAttempts >= LIMITS.reconnects) { this.stop("RECONNECT_LIMIT"); return; }
        this.timers.get("heartbeat")?.(); this.timers.delete("heartbeat");
        this.timers.get("handshake")?.(); this.timers.delete("handshake");
        this.socket?.terminate(); this.epoch++; // stale callbacks cannot re-enter
        c.reconnectAttempts++;
        this.timer("reconnect", LIMITS.reconnectMs, () => this.connect());
        return;
      case "text": this.receive(event.bytes); return;
    }
  }
  private receive(bytes: Uint8Array): void {
    const c = this.diagnostics.counts;
    c.received++; c.payloadBytes += bytes.byteLength;
    if (!this.withinDeadline()) { c.unprocessed++; return; }
    if (bytes.byteLength > LIMITS.messageBytes) { c.unprocessed++; this.stop("MESSAGE_TOO_LARGE"); return; }
    if (c.received > LIMITS.messages || c.payloadBytes > LIMITS.payloadBytes) {
      c.unprocessed++; this.stop(c.received > LIMITS.messages ? "MESSAGE_LIMIT" : "PAYLOAD_LIMIT"); return;
    }
    this.heartbeat();
    const classification = classifyMessage(bytes);
    if (classification.kind === "control") {
      c.control++; this.diagnostics.family("control"); this.diagnostics.control(classification.code);
      if (classification.code === "JSON_PING") { c.heartbeat++; this.socket?.pong("JSON"); }
      if (classification.code === "JSON_PONG") c.heartbeat++;
      if (classification.stop) this.stop(classification.code);
      else if (c.received === LIMITS.messages) this.finish("MESSAGE_LIMIT");
      return;
    }
    this.diagnostics.family(classification.channel);
    if (classification.channel !== this.options.channel) {
      c.unprocessed++; this.stop("CHANNEL_MISMATCH"); return;
    }
    if (this.receiveQueue.length >= LIMITS.queueCount || this.receiveBytes + bytes.length > LIMITS.queueBytes) {
      c.unprocessed++; this.stop(this.receiveQueue.length >= LIMITS.queueCount ? "QUEUE_COUNT_LIMIT" : "QUEUE_BYTE_LIMIT");
      return;
    }
    this.receiveQueue.push({
      bytes: Uint8Array.from(bytes),
      context: { origin: "SYNTHETIC_TEST", channel: classification.channel, timestampUnit: "s",
        receivedAtUtcNs: (BigInt(this.clock.utcMs()) * 1_000_000n).toString(),
        receivedAtMonotonicNs: this.clock.monoNs().toString(),
        connectionEpoch: this.epoch, receiveOrdinal: ++this.ordinal },
    });
    this.receiveBytes += bytes.length; c.queued++;
    c.queuePeakCount = Math.max(c.queuePeakCount, this.receiveQueue.length);
    c.queuePeakBytes = Math.max(c.queuePeakBytes, this.receiveBytes);
    if (!this.options.manualDrain) this.timer("drain", 0, () => {
      this.drainReceive(); this.drainStorage();
      if (!this.terminal && ((this.options.finishAfter !== undefined && c.parsed >= this.options.finishAfter) ||
        c.received === LIMITS.messages)) this.finish(c.received === LIMITS.messages ? "MESSAGE_LIMIT" : "COMPLETED");
    });
  }
  drainReceive(): void {
    const c = this.diagnostics.counts;
    while (this.receiveQueue.length && !this.terminal) {
      if (!this.withinDeadline()) return;
      const entry = this.receiveQueue[0];
      let record: ObservationRecord;
      try { record = parseObservation(entry.bytes, entry.context); }
      catch { c.parserFailures++; this.stop("PARSER_FAILURE"); return; }
      this.receiveQueue.shift(); this.receiveBytes -= entry.bytes.length;
      c.parsed++;
      if (record.result.status === "REJECTED") {
        c.rejected++; c.parserFailures++; this.diagnostics.note(record.result.reasonCode);
      } else c.accepted++;
      this.inflight = record; // ownership precedes all fallible queue/storage work
      const size = Buffer.byteLength(canonicalObservation(record));
      if (this.storageQueue.length >= LIMITS.queueCount || this.storageBytes + size > LIMITS.queueBytes) {
        this.stop("STORAGE_QUEUE_LIMIT"); return;
      }
      this.storageQueue.push({ record, bytes: size }); this.storageBytes += size; this.inflight = null;
      c.storageQueuePeakCount = Math.max(c.storageQueuePeakCount, this.storageQueue.length);
      c.storageQueuePeakBytes = Math.max(c.storageQueuePeakBytes, this.storageBytes);
      if (record.result.status === "REJECTED") {
        this.drainStorage(); if (!this.terminal) this.stop("PARSER_REJECTED"); return;
      }
      const age = BigInt(record.result.observation.timestampNs) - BigInt(entry.context.receivedAtUtcNs);
      if (age > 5_000_000_000n || age < -86_400_000_000_000n) {
        this.stop("TIMESTAMP_CONTEXT_MISMATCH"); return;
      }
    }
  }
  drainStorage(): void {
    while (this.storageQueue.length && !this.terminal) {
      if (!this.withinDeadline()) return;
      try { this.sink.append(this.storageQueue[0].record); }
      catch {
        this.diagnostics.counts.persistenceFailed++; this.diagnostics.counts.storageFailures++;
        this.stop("STORAGE_FAILED"); return; // record stays owned, never retry blindly
      }
      this.diagnostics.counts.persisted++;
      this.storageBytes -= this.storageQueue.shift()!.bytes;
      if (!this.withinDeadline()) return;
    }
  }
  checkMemory(sessionRss: number | null, totalRss: number | null): void {
    const action = watchdog({ elapsedMs: Number(this.clock.monoNs() - this.startedAt) / 1e6,
      stopElapsedMs: null, sessionRss, totalRss });
    if (sessionRss !== null && totalRss !== null && Number.isSafeInteger(sessionRss) &&
      Number.isSafeInteger(totalRss) && sessionRss >= 0 && totalRss >= sessionRss) {
      this.diagnostics.memory = "MEASURED";
      this.diagnostics.sessionRssPeak = Math.max(this.diagnostics.sessionRssPeak ?? 0, sessionRss);
      this.diagnostics.totalRssPeak = Math.max(this.diagnostics.totalRssPeak ?? 0, totalRss);
    } else this.diagnostics.memory = "NOT_MEASURED";
    if (action.kind !== "CONTINUE") {
      this.stop(action.reason === "MEMORY_THRESHOLD" ? "MEMORY_THRESHOLD" :
        action.reason === "MEMORY_NOT_MEASURED" ? "MEMORY_NOT_MEASURED" :
          action.reason === "WALL_TIME_LIMIT" ? "WALL_TIME_LIMIT" : "FORCED_TERMINATION");
    }
  }
  finish(reason: LiveReason = "COMPLETED"): void {
    this.drainReceive(); this.drainStorage(); if (!this.terminal) this.stop(reason, false);
  }
  stop(reason: LiveReason, failed = true): void {
    if (this.terminal) return;
    this.diagnostics.reason = reason; this.diagnostics.note(reason);
    this.diagnostics.state = failed ? "FAILED" : "STOPPED";
    this.timers.forEach(cancel => cancel()); this.timers.clear();
    try { this.socket?.close(); } catch { this.socket?.terminate(); }
    this.terminalCallback?.();
  }
}
