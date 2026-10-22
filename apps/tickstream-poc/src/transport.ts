import { parsePublicSample } from "@workspace/tickstream-adapter";
import { MAX_PAYLOAD_BYTES, type ParseInput, type ParseResult } from "@workspace/tickstream-adapter/envelope";
import { Diagnostics, type Report, type State, type StopReason } from "./diagnostics";

const MiB = 1024 * 1024;
export const LIMITS = Object.freeze({
  messageBytes: MiB, queueCount: 128, queueBytes: 8 * MiB,
  messages: 1000, payloadBytes: 64 * MiB, activeMs: 60_000, wallMs: 120_000,
  handshakeMs: 10_000, heartbeatMs: 30_000, reconnects: 1, reconnectMs: 46_000,
  cleanupMs: 2000, fragments: 1024, sessionRss: 256 * MiB, totalRss: 384 * MiB,
});
type Action = "CONNECT" | "OPEN" | "SUBSCRIBE" | "ACK" | "INTERRUPT" | "WAIT" | "RETRY" | "STOP" | "FINISH" | "FAIL";
const TRANSITIONS: Partial<Record<State, Partial<Record<Action, State>>>> = {
  IDLE: { CONNECT: "CONNECTING", STOP: "STOPPING" },
  CONNECTING: { OPEN: "CONNECTED", INTERRUPT: "INTERRUPTED", STOP: "STOPPING" },
  CONNECTED: { SUBSCRIBE: "SUBSCRIBING", INTERRUPT: "INTERRUPTED", STOP: "STOPPING" },
  SUBSCRIBING: { ACK: "RUNNING", INTERRUPT: "INTERRUPTED", STOP: "STOPPING" },
  RUNNING: { INTERRUPT: "INTERRUPTED", STOP: "STOPPING" },
  INTERRUPTED: { WAIT: "RECONNECT_WAIT", STOP: "STOPPING" },
  RECONNECT_WAIT: { RETRY: "CONNECTING", STOP: "STOPPING" },
  STOPPING: { FINISH: "STOPPED", FAIL: "FAILED" },
};
/** Pure, strict transition function. Races are suppressed by the controller, not this contract. */
export function transition(state: State, action: Action): State {
  const target = TRANSITIONS[state]?.[action];
  if (!target) throw new Error("INVALID_TRANSPORT_TRANSITION");
  return target;
}

export interface Clock {
  monoNs(): bigint;
  utcMs(): number;
  schedule(ms: number, callback: () => void): () => void;
}
export const SYNTHETIC_UTC_MS = 1_700_000_000_000;
/** A bounded test scheduler; advancing 120 seconds never sleeps. */
export class FakeClock implements Clock {
  private time = 0;
  private serial = 0;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();
  monoNs(): bigint { return BigInt(this.time) * 1_000_000n; }
  utcMs(): number { return SYNTHETIC_UTC_MS + this.time; }
  get scheduled(): number { return this.tasks.size; }
  schedule(ms: number, callback: () => void): () => void {
    if (!Number.isFinite(ms) || ms < 0 || this.tasks.size >= 4096) throw new Error("SCHEDULER_LIMIT");
    const id = ++this.serial;
    this.tasks.set(id, { at: this.time + ms, callback });
    return () => { this.tasks.delete(id); };
  }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("INVALID_CLOCK_ADVANCE");
    const end = this.time + ms;
    let work = 0;
    for (;;) {
      let chosen: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.tasks) if (entry[1].at <= end &&
        (!chosen || entry[1].at < chosen[1].at || (entry[1].at === chosen[1].at && entry[0] < chosen[0]))) chosen = entry;
      if (!chosen) break;
      if (++work > 100_000) throw new Error("SCHEDULER_WORK_LIMIT");
      this.time = chosen[1].at;
      this.tasks.delete(chosen[0]);
      chosen[1].callback();
    }
    this.time = end;
  }
}

/** These ACK/auth events are synthetic test signals, NOT a claimed provider wire schema. */
export type SocketEvent =
  | { type: "open" | "subscribed" | "authRejected" | "subscriptionRejected" | "wsPing" | "close" | "error" }
  | { type: "text"; bytes: Uint8Array }
  | { type: "fragment"; bytes: Uint8Array; final: boolean };
export interface Socket {
  listen(listener: (event: SocketEvent) => void): void;
  connect(): void;
  subscribe(): void;
  pong(kind: "JSON" | "WEBSOCKET"): void;
  close(): void;
  terminate(): void;
}
export class FakeSocket implements Socket {
  private listener: ((event: SocketEvent) => void) | undefined;
  readonly calls = { connect: 0, subscribe: 0, jsonPong: 0, wsPong: 0, close: 0, terminate: 0 };
  listen(listener: (event: SocketEvent) => void): void { this.listener = listener; }
  emit(event: SocketEvent): void { this.listener?.(event); }
  connect(): void { this.calls.connect++; }
  subscribe(): void { this.calls.subscribe++; }
  pong(kind: "JSON" | "WEBSOCKET"): void { this.calls[kind === "JSON" ? "jsonPong" : "wsPong"]++; }
  close(): void { this.calls.close++; this.emit({ type: "close" }); }
  terminate(): void { this.calls.terminate++; this.listener = undefined; }
}
/** No price/content-derived identity. Ordinal and epoch are strictly local. */
export interface TransportEnvelope {
  readonly localUtcReceiveMs: number;
  readonly localUtcPrecision: "ms";
  readonly monotonicReceiveNs: bigint;
  readonly localReceiveOrdinal: number;
  readonly connectionEpoch: number;
  readonly providerTimestamp: { value: number; unit: "s" } | null;
}
interface Entry { raw: Uint8Array; envelope: TransportEnvelope }
interface Assembly { parts: Uint8Array[]; bytes: number; envelope: TransportEnvelope; fragments: number }
type Timer = "wall" | "handshake" | "heartbeat" | "active" | "reconnect" | "drain" | "cleanup";
type Parser = (input: ParseInput) => ParseResult;
export class Transport {
  readonly diagnostics = new Diagnostics();
  private current: State = "IDLE";
  private reason: StopReason = "COMPLETED";
  private failed = false;
  private readonly timers = new Map<Timer, () => void>();
  private socket: Socket | undefined;
  private epoch = 0;
  private ordinal = 0;
  private queue: Entry[] = [];
  private active: Entry | undefined;
  private assembly: Assembly | undefined;
  private queuedBytes = 0;
  private activeStarted: bigint | undefined;
  private usedActiveMs = 0;
  private startNs: bigint | undefined;
  private processing = false;
  constructor(
    private readonly clock: Clock,
    private readonly factory: (epoch: number) => Socket,
    private readonly parser: Parser = parsePublicSample,
  ) { this.diagnostics.visit("IDLE"); }
  get state(): State { return this.current; }
  get pendingCount(): number { return this.queue.length + (this.active ? 1 : 0) + (this.assembly ? 1 : 0); }
  get pendingBytes(): number { return this.queuedBytes + (this.active?.raw.byteLength ?? 0) + (this.assembly?.bytes ?? 0); }
  get terminal(): boolean { return this.current === "STOPPED" || this.current === "FAILED"; }
  private move(action: Action): void {
    this.current = transition(this.current, action);
    this.diagnostics.visit(this.current);
  }
  private cancel(name: Timer): void { this.timers.get(name)?.(); this.timers.delete(name); }
  private timer(name: Timer, ms: number, callback: () => void): void {
    this.cancel(name);
    this.timers.set(name, this.clock.schedule(ms, () => {
      this.timers.delete(name);
      if (!this.terminal) callback();
    }));
  }
  private cancelAll(): void { for (const cancel of this.timers.values()) cancel(); this.timers.clear(); }
  private peak(): void { this.diagnostics.peaks(this.pendingCount, this.pendingBytes, this.assembly?.bytes ?? 0); }
  start(): void {
    if (this.current !== "IDLE") return;
    this.startNs = this.clock.monoNs();
    // Reserve the last two seconds for cleanup, within the 120s wall deadline.
    this.timer("wall", LIMITS.wallMs - LIMITS.cleanupMs, () => this.stop("WALL_TIME_LIMIT"));
    this.move("CONNECT");
    this.connect();
  }
  private connect(): void {
    this.diagnostics.connectionAttempts++;
    const epoch = ++this.epoch;
    this.timer("handshake", LIMITS.handshakeMs, () => this.stop("HANDSHAKE_TIMEOUT", true));
    try {
      this.socket = this.factory(epoch);
      this.socket.listen(event => { if (this.epoch === epoch && !this.terminal) this.handle(event); });
      this.socket.connect();
    } catch { this.stop("SOCKET_ERROR", true); }
  }
  private heartbeat(): void {
    this.timer("heartbeat", LIMITS.heartbeatMs, () => {
      this.diagnostics.reason("HEARTBEAT_TIMEOUT");
      this.interrupt();
    });
  }
  private open(): void {
    if (this.current !== "CONNECTING") return;
    this.cancel("handshake");
    this.move("OPEN");
    this.activeStarted = this.clock.monoNs();
    this.timer("active", LIMITS.activeMs - this.usedActiveMs, () => this.stop("ACTIVE_TIME_LIMIT"));
    this.heartbeat();
    this.move("SUBSCRIBE");
    this.diagnostics.subscriptionAttempts++;
    try { this.socket?.subscribe(); } catch { this.stop("SOCKET_ERROR", true); }
  }
  private accountActive(): void {
    if (this.activeStarted !== undefined) {
      this.usedActiveMs += Number(this.clock.monoNs() - this.activeStarted) / 1e6;
      this.activeStarted = undefined;
    }
  }
  private disposeSocket(): boolean {
    const socket = this.socket; this.socket = undefined;
    try { socket?.terminate(); return true; }
    catch { this.diagnostics.errorCount++; this.diagnostics.reason("SOCKET_ERROR"); return false; }
  }
  private interrupt(): void {
    if (!["CONNECTING", "CONNECTED", "SUBSCRIBING", "RUNNING"].includes(this.current)) return;
    this.accountActive();
    this.cancel("handshake"); this.cancel("active"); this.cancel("heartbeat");
    // Old epoch callbacks are invalid immediately, not only after reconnect.
    this.epoch++;
    if (!this.disposeSocket()) { this.stop("SOCKET_ERROR", true); return; }
    if (this.assembly) { this.assembly = undefined; this.diagnostics.unprocessed++; }
    this.move("INTERRUPT");
    if (this.diagnostics.reconnectAttempts >= LIMITS.reconnects) {
      this.stop("RECONNECT_LIMIT", true); return;
    }
    this.move("WAIT");
    this.timer("reconnect", LIMITS.reconnectMs, () => {
      if (this.current !== "RECONNECT_WAIT") return;
      this.diagnostics.reconnectAttempts++;
      this.move("RETRY"); this.connect();
    });
  }
  private handle(event: SocketEvent): void {
    if (event.type === "close") {
      this.diagnostics.closeCount++;
      if (this.current === "STOPPING") { if (!this.pendingCount && !this.processing) this.finish(); return; }
      this.diagnostics.reason("REMOTE_CLOSE"); this.interrupt(); return;
    }
    if (event.type === "error") {
      this.diagnostics.errorCount++;
      if (this.current !== "STOPPING") { this.diagnostics.reason("SOCKET_ERROR"); this.interrupt(); }
      return;
    }
    if (this.current === "STOPPING") {
      if (event.type === "text" || event.type === "fragment") {
        this.diagnostics.receive(event.bytes.byteLength, this.clock.monoNs());
        this.diagnostics.unprocessed++;
      }
      return;
    }
    if (event.type === "open") { this.open(); return; }
    if (event.type === "authRejected") { this.stop("AUTH_REJECTED", true); return; }
    if (event.type === "subscriptionRejected") { this.stop("SUBSCRIPTION_REJECTED", true); return; }
    if (event.type === "subscribed") {
      if (this.current === "SUBSCRIBING") this.move("ACK");
      return;
    }
    if (event.type === "wsPing") {
      if (["SUBSCRIBING", "RUNNING"].includes(this.current)) {
        this.heartbeat(); this.diagnostics.heartbeatCount++;
        try { this.socket?.pong("WEBSOCKET"); } catch { this.stop("SOCKET_ERROR", true); }
      }
      return;
    }
    if (!["SUBSCRIBING", "RUNNING"].includes(this.current)) return;
    this.heartbeat();
    if (event.type === "text") this.receive(event.bytes);
    else if (event.type === "fragment") this.fragment(event.bytes, event.final);
  }
  private envelope(): TransportEnvelope {
    return {
      localUtcReceiveMs: this.clock.utcMs(), localUtcPrecision: "ms",
      monotonicReceiveNs: this.clock.monoNs(), localReceiveOrdinal: ++this.ordinal,
      connectionEpoch: this.epoch, providerTimestamp: null,
    };
  }
  private begin(bytes: number): TransportEnvelope | undefined {
    const envelope = this.envelope();
    this.diagnostics.receive(bytes, envelope.monotonicReceiveNs);
    if (this.diagnostics.receivedMessages > LIMITS.messages) {
      this.reject("MESSAGE_LIMIT"); return undefined;
    }
    if (this.diagnostics.payloadBytes > LIMITS.payloadBytes) {
      this.reject("PAYLOAD_LIMIT"); return undefined;
    }
    return envelope;
  }
  private capacity(bytes: number, count = 1): boolean {
    if (this.pendingCount + count > LIMITS.queueCount) { this.reject("QUEUE_COUNT_LIMIT"); return false; }
    if (this.pendingBytes + bytes > LIMITS.queueBytes) { this.reject("QUEUE_BYTE_LIMIT"); return false; }
    return true;
  }
  private receive(raw: Uint8Array): void {
    const envelope = this.begin(raw.byteLength);
    if (!envelope) return;
    if (this.assembly) { this.reject("FRAGMENT_PROTOCOL"); return; }
    if (raw.byteLength > MAX_PAYLOAD_BYTES) { this.reject("PAYLOAD_TOO_LARGE"); return; }
    if (!this.capacity(raw.byteLength)) return;
    this.enqueue(raw.slice(), envelope);
  }
  private fragment(raw: Uint8Array, final: boolean): void {
    if (!this.assembly) {
      const envelope = this.begin(raw.byteLength);
      if (!envelope) return;
      if (raw.byteLength > MAX_PAYLOAD_BYTES) { this.reject("PAYLOAD_TOO_LARGE"); return; }
      if (!this.capacity(raw.byteLength)) return;
      this.assembly = { parts: [], bytes: 0, fragments: 0, envelope };
    } else this.diagnostics.addFragmentBytes(raw.byteLength);
    const assembly = this.assembly;
    if (this.diagnostics.payloadBytes > LIMITS.payloadBytes) { this.rejectAssembly("PAYLOAD_LIMIT"); return; }
    if (++assembly.fragments > LIMITS.fragments) { this.rejectAssembly("FRAGMENT_LIMIT"); return; }
    if (assembly.bytes + raw.byteLength > MAX_PAYLOAD_BYTES) { this.rejectAssembly("PAYLOAD_TOO_LARGE"); return; }
    if (this.pendingBytes + raw.byteLength > LIMITS.queueBytes) { this.rejectAssembly("QUEUE_BYTE_LIMIT"); return; }
    assembly.parts.push(raw.slice()); assembly.bytes += raw.byteLength; this.peak();
    if (final) {
      const joined = new Uint8Array(assembly.bytes);
      let offset = 0;
      for (const part of assembly.parts) { joined.set(part, offset); offset += part.byteLength; }
      this.assembly = undefined;
      this.enqueue(joined, assembly.envelope);
    }
  }
  private enqueue(raw: Uint8Array, envelope: TransportEnvelope): void {
    this.queue.push({ raw, envelope }); this.queuedBytes += raw.byteLength;
    this.peak(); this.scheduleDrain();
    if (this.diagnostics.receivedMessages === LIMITS.messages) this.stop("MESSAGE_LIMIT");
    else if (this.diagnostics.payloadBytes === LIMITS.payloadBytes) this.stop("PAYLOAD_LIMIT");
  }
  private rejectAssembly(reason: StopReason): void { this.assembly = undefined; this.reject(reason); }
  private reject(reason: StopReason): void {
    this.diagnostics.rejected++; this.diagnostics.reason(reason); this.stop(reason, true, true);
  }
  private scheduleDrain(): void {
    if (!this.timers.has("drain") && !this.processing && this.queue.length && !this.terminal) {
      this.timer("drain", 0, () => this.drain());
    }
  }
  private drain(): void {
    if (this.processing || this.terminal) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.queuedBytes -= entry.raw.byteLength; this.active = entry; this.processing = true;
    try { this.parse(entry); }
    catch { this.reject("PARSER_EXCEPTION"); }
    finally {
      this.active = undefined; this.processing = false;
      if (this.current === "STOPPING" && !this.pendingCount) this.finish();
      else this.scheduleDrain();
    }
  }
  private parse(entry: Entry): void {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(entry.raw)); }
    catch {
      // Let the unchanged parser distinguish malformed JSON from invalid UTF-8.
      this.diagnostics.family(undefined);
      this.consumeParser(entry); return;
    }
    const fields = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    this.diagnostics.family(fields.type);
    if (fields.type === "ping" || fields.type === "pong" || fields.type === "welcome") {
      this.diagnostics.control++;
      if (fields.type === "ping") {
        this.diagnostics.heartbeatCount++;
        try { this.socket?.pong("JSON"); } catch { this.stop("SOCKET_ERROR", true); }
      }
      return;
    }
    if (fields.type === "error" || fields.type === "warning" || fields.type === "feed") {
      this.reject("UNSUPPORTED_CONTROL"); return;
    }
    this.consumeParser(entry);
  }
  private consumeParser(entry: Entry): void {
    const result = this.parser({
      raw: entry.raw, schemaProfile: "WS_TICK_LIVE_V1",
      provenance: {
        sourceUrl: "https://tick-stream.xyz/docs/streaming",
        documentationCheckedAt: "2026-10-22T17:24:13Z",
        sampleOrigin: "SYNTHETIC_TEST", timestampUnit: "s",
      },
      instrument: { kind: "CORE_NQ", symbol: "NQ" },
    });
    // A parser callback may synchronously trigger Ctrl+C/overflow in a test.
    if (this.current === "STOPPING" && this.failed) { this.diagnostics.unprocessed++; return; }
    if (result.status !== "ACCEPTED_OBSERVATION") { this.reject(result.reasonCode); return; }
    const observation = result.observation;
    const envelope: TransportEnvelope = {
      ...entry.envelope, providerTimestamp: { value: observation.rawTimestamp, unit: "s" },
    };
    const age = BigInt(envelope.localUtcReceiveMs) * 1_000_000n - BigInt(observation.timestampNs);
    // Local safety window only, NOT provider timestamp validation or a unit heuristic.
    if (age < -5_000_000_000n || age > 86_400_000_000_000n) {
      this.reject("TIMESTAMP_CONTEXT_MISMATCH"); return;
    }
    this.diagnostics.age(age); this.diagnostics.accepted++;
    // No observation, raw event, fingerprint or identity is retained.
  }
  checkMemory(session: number | null, total: number | null): void {
    this.diagnostics.memory(session, total);
    if (session === null || total === null || !Number.isSafeInteger(session) ||
      !Number.isSafeInteger(total) || session < 0 || total < session) {
      this.stop("MEMORY_NOT_MEASURED", true); return;
    }
    if (session > LIMITS.sessionRss || total > LIMITS.totalRss) this.stop("MEMORY_THRESHOLD", true);
  }
  stop(reason: StopReason = "COMPLETED", failed = false, alreadyCounted = false): void {
    if (this.terminal) return;
    if (this.current === "STOPPING") {
      if (failed && !this.failed) {
        this.failed = true; this.reason = reason;
        if (!alreadyCounted) this.diagnostics.reason(reason);
        this.diagnostics.unprocessed += this.queue.length + (this.assembly ? 1 : 0);
        this.queue = []; this.queuedBytes = 0; this.assembly = undefined;
      }
      return;
    }
    this.reason = reason; this.failed = failed;
    if (!alreadyCounted) this.diagnostics.reason(reason);
    this.accountActive(); this.cancelAll(); this.move("STOP");
    if (failed) {
      this.diagnostics.unprocessed += this.queue.length + (this.assembly ? 1 : 0);
      this.queue = []; this.queuedBytes = 0; this.assembly = undefined;
    } else if (this.assembly) {
      this.diagnostics.unprocessed++; this.assembly = undefined;
    }
    this.timer("cleanup", LIMITS.cleanupMs, () => {
      this.diagnostics.unprocessed += this.queue.length;
      this.queue = []; this.queuedBytes = 0;
      this.finish();
    });
    try { this.socket?.close(); } catch {
      if (!this.terminal) {
        this.failed = true; this.reason = "SOCKET_ERROR"; this.diagnostics.reason("SOCKET_ERROR");
      }
    }
    if (!this.pendingCount && !this.processing) this.finish();
    else this.scheduleDrain();
  }
  private finish(): void {
    if (this.current !== "STOPPING" || this.processing) return;
    this.epoch++;
    if (!this.disposeSocket()) { this.failed = true; this.reason = "SOCKET_ERROR"; }
    this.cancelAll(); this.move(this.failed ? "FAIL" : "FINISH");
  }
  report(): Report { return this.diagnostics.report(this.current, this.reason, this.pendingCount); }
}
