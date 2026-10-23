import { REASON_CODES } from "@workspace/tickstream-adapter/envelope";
import { parseObservation, type ObservationRecord, type ReceiveContext } from "@workspace/tickstream-adapter/live-observation";
import type { Clock } from "./transport";
import { classifyMessage } from "./liveControl";
import { assertLiveStoragePort, assertB2ConnectionPolicy, type B2ConnectionPolicy, type BLiveStoragePort } from "./gateB2Config";
import {
  LIMITS, B_COUNTERS, B_PHASES, emptyGateBReport, readGateBReport,
  type BExecution, type BPhase, type BReason, type GateBReport,
} from "./gateBConfig";

export type BEvent = { type: "open" | "subscriptionSent" | "ping" | "pong" | "close" |
  "error" | "protocolFailure" | "authRejected" | "entitlementRejected" | "connectionLimit" |
  "dnsFailure" | "tlsFailure" | "networkFailure" | "handshakeRejected" } |
  { type: "text"; bytes: Uint8Array };
export interface BTicksSocket {
  listen(callback: (event: BEvent) => void): void;
  connect(): void;
  subscribe(): void;
  jsonPong(): void;
  close(): void;
  terminate(): void;
}
interface Pending { bytes: Uint8Array; context: ReceiveContext }
/** Offline injection contract only. No disk implementation is imported here.
 * Production construction rejects this option before factory/Secret access. */
export interface BOfflineStoragePort {
  readonly testOnly: true;
  accept(record: ObservationRecord): void;
  finish(): void;
  abort(): void;
  onFailure(callback: () => void): void;
}
/** Production remains RAM-only. The optional B-2A port is artificial/loopback
 * ONLY; no retained Trade collection, raw log or content dedup is introduced. */
export class GateBTicks {
  private readonly reportValue: GateBReport;
  private readonly queue: Pending[] = [];
  private queuedBytes = 0;
  private ordinal = 0;
  private epoch = 0;
  private generation = 0;
  private observedEpoch = 0;
  private lastProviderTime: bigint | null = null;
  private readonly timers = new Map<string, () => void>();
  private socket: BTicksSocket | undefined;
  private startedAt = 0n;
  private activeAt: bigint | null = null;
  private stopAt: bigint | null = null;
  private started = false;
  private offlineStorageFailed = false;
  private terminalCallback: (() => void) | undefined;
  private readonly connectionPolicy: B2ConnectionPolicy | null;
  constructor(private readonly clock: Clock, private readonly factory: () => BTicksSocket,
    execution: Exclude<BExecution, "NOT_RUN">, private readonly options: {
      manualDrain?: boolean; finishAfter?: number; offlineStorage?: BOfflineStoragePort;
      liveStorage?: BLiveStoragePort;
    } = {}) {
    if (options.offlineStorage !== undefined &&
      (execution !== "LOOPBACK_TEST" || options.offlineStorage.testOnly !== true)) {
      throw new Error("GATE_B_PRODUCTION_STORAGE_DISABLED");
    }
    if (options.liveStorage) {
      if (options.offlineStorage) throw new Error("LIVE_AUTH_SCOPE");
      assertLiveStoragePort(options.liveStorage, execution);
    }
    this.connectionPolicy = options.liveStorage ? assertB2ConnectionPolicy() : null;
    if (!["LOOPBACK_TEST", "PRODUCTION"].includes(execution) || (options.finishAfter !== undefined &&
      (!Number.isInteger(options.finishAfter) || options.finishAfter < 1 || options.finishAfter > LIMITS.messages))) {
      throw new Error("GATE_B_OPTIONS");
    }
    this.reportValue = { ...emptyGateBReport(), execution, authentication: "NOT_CHECKED",
      counters: Object.fromEntries(B_COUNTERS.map(k => [k, 0])) as NonNullable<GateBReport["counters"]>,
      phaseVisits: Object.fromEntries(B_PHASES.map(k => [k, 0])) as NonNullable<GateBReport["phaseVisits"]>,
      parserReasons: Object.fromEntries(REASON_CODES.map(k => [k, 0])) as NonNullable<GateBReport["parserReasons"]> };
    this.phase("NOT_RUNNING");
    (options.offlineStorage ?? options.liveStorage)?.onFailure(() => {
      this.offlineStorageFailed = true;
      // The unchanged B-1 report has no storage enums. The separate offline
      // queue report owns the exact LIVE_* reason and all persistence counts.
      this.stop("CHILD_FAILURE");
    });
  }
  get terminal(): boolean { return this.reportValue.phase === "STOPPED" || this.reportValue.phase === "FAILED"; }
  get capacity() { return { count: this.queue.length, bytes: this.queuedBytes }; }
  onTerminal(callback: () => void): void { this.terminalCallback = callback; }
  private phase(phase: BPhase): void { this.reportValue.phase = phase; this.reportValue.phaseVisits![phase]++; }
  report(): GateBReport {
    if (this.options.offlineStorage || this.options.liveStorage) throw new Error("GATE_B_OFFLINE_REPORT_REQUIRED");
    return this.baseReport();
  }
  /** Do not label an offline disk test with B-1's persistence:DISABLED.
   * Exact durable counts/reasons come from the separate queue report. */
  offlineReport() {
    if (!this.options.offlineStorage) throw new Error("GATE_B_OFFLINE_STORAGE_NOT_CONFIGURED");
    const { schema: _, persistence: _p, ...transport } = this.baseReport();
    return { schema: "TICKSTREAM_GATE_B2A_OFFLINE_V1" as const,
      persistence: "OFFLINE_ONLY" as const, transport };
  }
  liveReport() {
    if (!this.options.liveStorage) throw new Error("LIVE_AUTH_REQUIRED");
    const { schema: _, persistence: _p, ...transport } = this.baseReport();
    return { schema: "TICKSTREAM_GATE_B2B_TRANSPORT_V1" as const,
      persistence: "AUTHORIZED_LIVE_ONLY" as const, transport };
  }
  private baseReport(): GateBReport {
    const r = this.reportValue, c = r.counters!;
    c.pending = this.queue.length;
    r.elapsedWallMs = this.started ? Number((this.clock.monoNs() - this.startedAt) / 1_000_000n) : null;
    r.activeBudgetElapsedMs = this.activeAt === null ? null :
      Number(((this.stopAt ?? this.clock.monoNs()) - this.activeAt) / 1_000_000n);
    r.accountingMatches = c.received === c.validTicks + c.rejected + c.control + c.unprocessed + c.pending;
    return readGateBReport(r)!; // one fixed whitelist for IPC and console
  }
  private timer(name: string, ms: number, callback: () => void): void {
    if (name === "reconnect" && this.connectionPolicy?.reconnectSchedulerDisabled) {
      this.stop("RECONNECT_LIMIT"); return; // never call Clock.schedule, even for a future caller
    }
    this.timers.get(name)?.();
    this.timers.set(name, this.clock.schedule(ms, () => {
      this.timers.delete(name); if (!this.terminal) callback();
    }));
  }
  start(): void {
    if (this.connectionPolicy && this.terminal) return;
    if (this.started) throw new Error("GATE_B_ALREADY_STARTED");
    this.started = true; this.startedAt = this.clock.monoNs();
    this.timer("wall", LIMITS.wallMs, () => this.stop("WALL_TIME_LIMIT"));
    this.connect();
  }
  private connect(): void {
    if (this.connectionPolicy && (this.terminal ||
      this.reportValue.counters!.connectionAttempts >= this.connectionPolicy.maxConnectionAttempts)) {
      this.stop("RECONNECT_LIMIT"); return; // before factory/native WebSocket construction
    }
    this.phase("CONNECTING"); this.epoch++; const generation = ++this.generation;
    this.reportValue.counters!.connectionAttempts++;
    this.timer("handshake", LIMITS.handshakeMs, () => this.stop("HANDSHAKE_TIMEOUT"));
    try {
      this.socket = this.factory();
      this.socket.listen(event => {
        if (!this.terminal && this.reportValue.phase !== "STOPPING" && generation === this.generation) this.event(event);
      });
      this.socket.connect();
    } catch { this.stop("SOCKET_ERROR"); }
  }
  private heartbeat(): void { this.timer("heartbeat", LIMITS.heartbeatMs, () => this.stop("HEARTBEAT_TIMEOUT")); }
  private withinDeadline(): boolean {
    const now = this.clock.monoNs();
    if (now - this.startedAt >= BigInt(LIMITS.wallMs) * 1_000_000n) { this.stop("WALL_TIME_LIMIT"); return false; }
    if (this.activeAt !== null && now - this.activeAt >= BigInt(LIMITS.activeMs) * 1_000_000n) {
      this.stop("ACTIVE_TIME_LIMIT", false); return false;
    }
    return !this.terminal;
  }
  private event(event: BEvent): void {
    const r = this.reportValue, c = r.counters!;
    switch (event.type) {
      case "open":
        this.timers.get("handshake")?.(); this.timers.delete("handshake");
        this.phase("SOCKET_OPEN"); r.authentication = "UNCONFIRMED";
        if (this.activeAt === null) {
          this.activeAt = this.clock.monoNs();
          this.timer("active", LIMITS.activeMs, () => this.stop("ACTIVE_TIME_LIMIT", false));
        }
        this.heartbeat(); c.subscriptionAttempts++;
        try { this.socket?.subscribe(); } catch { this.stop("SOCKET_ERROR"); } return;
      case "subscriptionSent":
        c.subscriptionSends++;
        // This is only the native send callback, NEVER an upstream ACK.
        if (this.observedEpoch !== this.epoch) {
          this.phase("SUBSCRIBE_SENT"); this.phase("SUBSCRIPTION_UNCONFIRMED");
          r.subscription = "SENT_UNCONFIRMED";
        }
        return;
      case "ping": case "pong": c.heartbeat++; this.heartbeat(); return; // autoPong owns response
      case "authRejected": r.authentication = "REFUSED"; this.stop("AUTH_REJECTED"); return;
      case "entitlementRejected": r.authentication = "REFUSED"; this.stop("ENTITLEMENT_REJECTED"); return;
      case "connectionLimit": this.stop("CONNECTION_LIMIT"); return;
      case "protocolFailure": c.protocolFailures++; this.stop("PROTOCOL_FAILURE"); return;
      case "error": this.stop("SOCKET_ERROR"); return;
      case "dnsFailure": this.stop("DNS_FAILURE"); return;
      case "tlsFailure": this.stop("TLS_FAILURE"); return;
      case "networkFailure": this.stop("NETWORK_FAILURE"); return;
      case "handshakeRejected": this.stop("HTTP_HANDSHAKE_REJECTED"); return;
      case "close":
        c.disconnects++;
        if (this.connectionPolicy?.reconnectSchedulerDisabled) { this.stop("RECONNECT_LIMIT"); return; }
        if (c.reconnectAttempts >= LIMITS.reconnects) { this.stop("RECONNECT_LIMIT"); return; }
        this.generation++; this.socket?.terminate();
        for (const key of ["heartbeat", "handshake"]) { this.timers.get(key)?.(); this.timers.delete(key); }
        c.reconnectAttempts++;
        this.timer("reconnect", LIMITS.reconnectMs, () => this.connect()); return;
      case "text": this.receive(event.bytes); return;
    }
  }
  private receive(bytes: Uint8Array): void {
    const r = this.reportValue, c = r.counters!;
    c.received++; c.payloadBytes += bytes.length;
    if (!this.withinDeadline()) { c.unprocessed++; return; }
    if (bytes.length > LIMITS.messageBytes) { c.unprocessed++; this.stop("MESSAGE_TOO_LARGE"); return; }
    if (c.received > LIMITS.messages || c.payloadBytes > LIMITS.payloadBytes) {
      c.unprocessed++; this.stop(c.received > LIMITS.messages ? "MESSAGE_LIMIT" : "PAYLOAD_LIMIT"); return;
    }
    this.heartbeat();
    const classification = classifyMessage(bytes);
    if (classification.kind === "control") {
      c.control++;
      if (classification.code === "JSON_PING") { c.heartbeat++; this.socket?.jsonPong(); }
      if (classification.code === "JSON_PONG") c.heartbeat++;
      if (classification.stop) {
        if (classification.code === "AUTH_REJECTED" || classification.code === "ENTITLEMENT_REJECTED") r.authentication = "REFUSED";
        if (classification.code === "SUBSCRIPTION_REJECTED") r.subscription = "REFUSED";
        const code = classification.code;
        this.stop(code === "JSON_PING" || code === "JSON_PONG" || code === "WELCOME_UNVERIFIED" ? "UNKNOWN_CONTROL" : code);
      } else if (c.received === LIMITS.messages) this.finish("MESSAGE_LIMIT");
      return;
    }
    if (classification.channel !== "ticks") { c.unprocessed++; this.stop("CHANNEL_MISMATCH"); return; }
    if (this.queue.length >= LIMITS.queueCount || this.queuedBytes + bytes.length > LIMITS.queueBytes) {
      c.unprocessed++; c.queueOverflows++;
      this.stop(this.queue.length >= LIMITS.queueCount ? "QUEUE_COUNT_LIMIT" : "QUEUE_BYTE_LIMIT"); return;
    }
    this.queue.push({ bytes: Uint8Array.from(bytes), context: {
      origin: r.execution === "PRODUCTION" ? "ACTUAL_PROVIDER_RESPONSE" : "SYNTHETIC_TEST",
      channel: "ticks", timestampUnit: "s", receivedAtUtcNs: (BigInt(this.clock.utcMs()) * 1_000_000n).toString(),
      receivedAtMonotonicNs: this.clock.monoNs().toString(), connectionEpoch: this.epoch, receiveOrdinal: ++this.ordinal,
    } });
    this.queuedBytes += bytes.length;
    c.queuePeakCount = Math.max(c.queuePeakCount, this.queue.length); c.queuePeakBytes = Math.max(c.queuePeakBytes, this.queuedBytes);
    if (!this.options.manualDrain) this.timer("drain", 0, () => this.drain());
  }
  drain(): void {
    const r = this.reportValue, c = r.counters!;
    while (this.queue.length && !this.terminal && this.withinDeadline()) {
      const entry = this.queue[0];
      let record;
      try { record = parseObservation(entry.bytes, entry.context); }
      catch { this.stop("PARSER_FAILURE"); return; }
      this.queue.shift(); this.queuedBytes -= entry.bytes.length;
      if (record.result.status !== "ACCEPTED_OBSERVATION") {
        c.rejected++; c.parserRejected++; r.parserReasons![record.result.reasonCode]++; r.schemaCompatibility = "REJECTED";
        this.stop("PARSER_REJECTED"); return;
      }
      c.parserAccepted++;
      const providerTime = BigInt(record.result.observation.timestampNs);
      const age = BigInt(entry.context.receivedAtUtcNs) - providerTime;
      if (age < -5_000_000_000n || age > 86_400_000_000_000n) {
        c.rejected++; c.contextRejected++; r.schemaCompatibility = "REJECTED"; this.stop("TIMESTAMP_CONTEXT_MISMATCH"); return;
      }
      c.validTicks++;
      if (this.lastProviderTime !== null) {
        if (providerTime < this.lastProviderTime) c.outOfOrderProviderTimes++;
        if (providerTime === this.lastProviderTime) c.equalProviderTimes++;
      }
      this.lastProviderTime = providerTime;
      r.schemaCompatibility = "OBSERVED_COMPATIBLE"; r.timestampConfidence = "DOCUMENTED_SECONDS_CONTEXT_CHECKED";
      if (r.execution === "PRODUCTION") r.authentication = "DATA_ACCESS_OBSERVED";
      r.subscription = "DATA_OBSERVED_NO_ACK";
      if (this.observedEpoch !== this.epoch) { this.observedEpoch = this.epoch; this.phase("FIRST_VALID_TICK_RECEIVED"); }
      this.phase("OBSERVING");
      const storage = this.options.offlineStorage ?? this.options.liveStorage;
      if (storage) {
        try { storage.accept(record); }
        catch { this.offlineStorageFailed = true; this.stop("CHILD_FAILURE"); return; }
      }
      // Without the explicit offline port, release after fixed counters as B-1.
    }
    if (!this.terminal && (c.received === LIMITS.messages ||
      (this.options.finishAfter !== undefined && c.validTicks >= this.options.finishAfter))) {
      this.stop(c.received === LIMITS.messages ? "MESSAGE_LIMIT" : "COMPLETED", false);
    }
  }
  finish(reason: BReason = "COMPLETED"): void { this.drain(); if (!this.terminal) this.stop(reason, false); }
  stop(reason: BReason, failed = true): void {
    if (this.terminal || this.reportValue.phase === "STOPPING") return;
    this.stopAt = this.clock.monoNs();
    this.phase("STOPPING"); this.reportValue.stopReason = reason;
    this.timers.forEach(cancel => cancel()); this.timers.clear();
    try { this.socket?.close(); } catch { this.socket?.terminate(); }
    const storage = this.options.offlineStorage ?? this.options.liveStorage;
    if (storage) {
      try {
        if (failed || this.offlineStorageFailed) storage.abort();
        else storage.finish();
      } catch {
        this.offlineStorageFailed = true;
        try { storage.abort(); } catch { /* fixed failure below, no free-text errors */ }
      }
      if (this.offlineStorageFailed) { failed = true; this.reportValue.stopReason = "CHILD_FAILURE"; }
    }
    this.phase(failed ? "FAILED" : "STOPPED"); this.terminalCallback?.();
  }
}
