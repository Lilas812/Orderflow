import { reconnectDelay } from "./backoff.ts";
import type { Receiver } from "../ingest/receiver.ts";
import type { Log } from "../logger.ts";
import { workCpu } from "../diagnostics/work-cpu.ts";

export type SocketEvent = Event & { data?: unknown; code?: number; wasClean?: boolean };
export interface Socket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
  send(data: string): void;
  close(code?: number): void;
}

export class Upstream {
  private apiKey: string;
  private receiver: Pick<Receiver, "metrics" | "receive">;
  private symbols: string[];
  private log: Log;
  private createSocket: (url: string) => Socket;
  private now: () => number;
  private random: () => number;
  private monotonicNow: () => number;
  private eventLoopSnapshot: () => unknown;
  private watchdogArmedAt = 0;
  private watchdogArmedAtUs = 0;
  private connectionSerial = 0;
  private lastMessageAt: number | null = null;
  private connectionLastReceivedUs: number | null = null;
  private messages = 0;
  private connectionMessages = 0;
  private maxMessageGapMs: number | null = null;
  private lastMessageGapMs: number | null = null;
  private lastReceiveMs: number | null = null;
  private maxReceiveMs: number | null = null;
  private loopPauseMs: () => number | null;
  private watchdogGeneration = 0;
  private watchdogDecisions = { checks: 0, receiveResumed: 0, connectionChanged: 0, localPause: 0, disconnected: 0 };
  private pongLatencies: { at: number; ms: number }[] = [];
  private pongCount = 0;
  private socket: Socket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private started = false;
  private failures = 0;
  private closeReason: string | null = null;
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  readonly status: {
    state: "stopped" | "connecting" | "open" | "closing" | "backoff";
    connectedAtUs: number | null;
    lastReceivedUs: number | null;
    reconnectCount: number;
    lastClose: { code: number; wasClean: boolean; reason: string; recvUs: number } | null;
    retryDelayMs: number | null;
  } = {
    state: "stopped", connectedAtUs: null, lastReceivedUs: null,
    reconnectCount: 0, lastClose: null, retryDelayMs: null,
  };

  constructor(options: {
    apiKey: string; receiver: Pick<Receiver, "metrics" | "receive">; log: Log; symbols?: string[];
    createSocket?: (url: string) => Socket;
    now?: () => number; random?: () => number;
    monotonicNow?: () => number;
    eventLoopSnapshot?: () => unknown;
    loopPauseMs?: () => number | null;
  }) {
    this.apiKey = options.apiKey;
    this.symbols = options.symbols ?? ["NQ"];
    this.receiver = options.receiver;
    this.log = options.log;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.eventLoopSnapshot = options.eventLoopSnapshot ?? (() => null);
    this.loopPauseMs = options.loopPauseMs ?? (() => null);
  }

  /** Shared raw WS activity, including ping/control messages; not trade counts.
   * Gap measurements end at handler entry, not at network arrival.
   */
  receiveDiagnostics() {
    return { scope: "shared_upstream_raw_messages", symbols: [...this.symbols],
      connectionSerial: this.connectionSerial, totalMessages: this.messages, connectionMessages: this.connectionMessages,
      connectionLastReceivedUs: this.connectionLastReceivedUs,
      messageAgeMs: this.lastMessageAt === null ? null : Math.max(0, this.monotonicNow() - this.lastMessageAt),
      lastMessageGapMs: this.lastMessageGapMs, maxMessageGapMs: this.maxMessageGapMs,
      lastReceiveMs: this.lastReceiveMs, maxReceiveMs: this.maxReceiveMs,
      watchdogDecisions: { ...this.watchdogDecisions }, pong: this.pongDiagnostics() };
  }

  private pongDiagnostics() {
    this.pongLatencies = this.pongLatencies.filter(p => p.at >= this.monotonicNow() - 60000);
    const values = this.pongLatencies.map(p => p.ms).sort((a, b) => a - b);
    return { windowSeconds: 60, samples: values.length, total: this.pongCount,
      maxMs: values.at(-1) ?? null, p99Ms: values.length ? values[Math.ceil(values.length * .99) - 1] : null };
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.connect(false);
  }

  private connect(retry: boolean) {
    if (this.stopping || this.socket) return;
    this.connectionSerial++;
    this.connectionMessages = 0;
    this.lastMessageAt = null;
    this.connectionLastReceivedUs = null;
    this.lastMessageGapMs = null;
    this.status.state = "connecting";
    this.status.connectedAtUs = null;
    this.status.retryDelayMs = null;
    this.closeReason = null;
    if (retry) this.status.reconnectCount++;
    this.log("upstream_connecting", { reconnectCount: this.status.reconnectCount });
    let socket: Socket;
    try {
      socket = this.createSocket(
        `wss://stream.tick-stream.xyz/v1/stream?key=${encodeURIComponent(this.apiKey)}&symbols=${this.symbols.join(",")}`,
      );
    } catch (error) {
      this.log("upstream_constructor_error", { error });
      this.schedule(1006, "constructor_error", null);
      return;
    }
    this.socket = socket;
    this.armWatchdog();
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      if (this.stopping || this.closeReason) { socket.close(1000); return; }
      this.status.state = "open";
      this.status.connectedAtUs = this.now() * 1000;
      this.log("upstream_open");
      try {
        // Trades are subscribed by symbols=NQ on each new socket.
        socket.send(JSON.stringify({ op: "subscribe", channel: "book", symbols: this.symbols }));
        this.log("upstream_subscribed", { trades: this.symbols.join(","), book: this.symbols.join(",") });
      } catch (error) {
        this.log("upstream_send_error", { error });
        this.reconnect("subscribe_error");
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopping || this.closeReason) return;
      const receiveStarted = this.monotonicNow();
      if (this.lastMessageAt !== null) {
        this.lastMessageGapMs = Math.max(0, receiveStarted - this.lastMessageAt);
        this.maxMessageGapMs = Math.max(this.maxMessageGapMs ?? 0, this.lastMessageGapMs);
      }
      this.lastMessageAt = receiveStarted;
      this.messages++; this.connectionMessages++;
      const recvUs = this.now() * 1000;
      this.connectionLastReceivedUs = recvUs;
      this.status.lastReceivedUs = recvUs;
      this.armWatchdog();
      try {
        workCpu.measure("live", () => this.receiver.receive(event.data, recvUs, () => {
          try {
            socket.send('{"op":"pong"}');
            this.pongCount++;
            this.pongLatencies.push({ at: this.monotonicNow(), ms: Math.max(0, this.monotonicNow() - receiveStarted) });
            // Real ping is 15s apart. Retain a hard cap even with a malformed ping flood.
            if (this.pongLatencies.length > 4096) this.pongLatencies.shift();
          }
          catch (error) {
            this.log("upstream_send_error", { error });
            this.reconnect("pong_error");
          }
        }));
      } finally {
        // Measure existing synchronous normalization + callbacks; do not swallow exceptions.
        this.lastReceiveMs = Math.max(0, this.monotonicNow() - receiveStarted);
        this.maxReceiveMs = Math.max(this.maxReceiveMs ?? 0, this.lastReceiveMs);
      }
    });
    socket.addEventListener("error", () => {
      // Browser-compatible error events do not expose a reliable safe cause.
      this.log("upstream_network_error", { state: this.status.state });
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.clearWatchdog();
      const code = event.code ?? 1006;
      const wasClean = event.wasClean ?? false;
      const reason = this.closeReason ?? "remote_close";
      const connectedAtMs = this.status.connectedAtUs === null ? null : this.status.connectedAtUs / 1000;
      this.socket = null; // Only a close event releases the single-socket slot.
      this.status.lastClose = { code, wasClean, reason, recvUs: this.now() * 1000 };
      this.receiver.metrics.count("disconnects");
      if (!wasClean || code === 1006) this.receiver.metrics.count("abnormalClose");
      this.log("upstream_close", this.status.lastClose);
      if (this.stopping) this.finishStop();
      else this.schedule(code, reason, connectedAtMs);
    });
  }

  private clearWatchdog() {
    this.watchdogGeneration++;
    if (this.watchdogTimer !== null) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private armWatchdog() {
    this.clearWatchdog();
    this.watchdogArmedAt = this.monotonicNow();
    this.watchdogArmedAtUs = this.now() * 1000;
    const generation = this.watchdogGeneration;
    const socket = this.socket;
    this.watchdogTimer = setTimeout(() => {
      this.watchdogDecisions.checks++;
      const elapsedMs = Math.max(0, this.monotonicNow() - this.watchdogArmedAt);
      const armedAtUs = this.watchdogArmedAtUs, firedAtUs = this.now() * 1000;
      setImmediate(() => setImmediate(() => {
        if (this.stopping) return;
        if (this.socket !== socket || this.closeReason !== null) {
          this.watchdogDecisions.connectionChanged++;
          this.log("upstream_watchdog_decision", { decision: "connection_changed", elapsedMs, firedAtUs });
          return;
        }
        if (this.watchdogGeneration !== generation) {
          this.watchdogDecisions.receiveResumed++;
          this.log("upstream_watchdog_decision", { decision: "receive_resumed", elapsedMs, firedAtUs });
          return;
        }
        let eventLoop: unknown, pause: number | null = null;
        try { eventLoop = this.eventLoopSnapshot(); pause = this.loopPauseMs(); }
        catch { eventLoop = { available: false, reason: "snapshot_failed" }; }
        if (pause !== null && pause >= 1000) {
          this.watchdogDecisions.localPause++;
          this.log("upstream_watchdog_decision", { decision: "local_event_loop_pause", elapsedMs, firedAtUs, pauseMs: pause });
          this.armWatchdog(); return;
        }
        this.watchdogDecisions.disconnected++;
        this.receiver.metrics.count("watchdog");
        this.log("upstream_watchdog", { silentMs: 30_000, thresholdMs: 30_000,
          decision: "no_receive_after_recheck", armedAtUs, firedAtUs,
          elapsedMs, overdueMs: Math.max(0, elapsedMs - 30_000),
          checkedAtUs: this.now() * 1000, recheckElapsedMs: Math.max(0, this.monotonicNow() - this.watchdogArmedAt),
          localPauseMs: pause, receive: this.receiveDiagnostics(), eventLoop });
        this.reconnect("watchdog");
      }));
    }, 30_000);
  }

  private schedule(code: number, reason: string, connectedAtMs: number | null) {
    if (this.stopping) { this.finishStop(); return; }
    const { delayMs, nextFailures } = reconnectDelay({
      failures: this.failures, connectedAtMs, nowMs: this.now(),
      random: this.random(), closeCode: code,
    });
    this.failures = nextFailures;
    this.status.state = "backoff";
    this.status.retryDelayMs = delayMs;
    this.log("upstream_reconnect_scheduled", { code, reason, delayMs });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect(true);
    }, delayMs);
  }

  /** SIGUSR2 and the watchdog close only upstream, never the HTTP listener. */
  reconnect(reason: "SIGUSR2" | "watchdog" | "subscribe_error" | "pong_error") {
    if (this.stopping || !this.socket || this.closeReason) return;
    this.closeReason = reason;
    this.clearWatchdog();
    this.status.state = "closing";
    this.log("upstream_close_requested", { code: 1000, reason });
    try { this.socket.close(1000); }
    catch (error) {
      // Never create another socket while closure is unconfirmed.
      this.log("upstream_close_error", { error });
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.clearWatchdog();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopPromise = new Promise<void>((resolve) => { this.stopResolve = resolve; });
    if (this.socket) {
      this.closeReason = "shutdown";
      this.status.state = "closing";
      this.log("upstream_close_requested", { code: 1000, reason: "shutdown" });
      try { this.socket.close(1000); }
      catch (error) { this.log("upstream_close_error", { error }); }
    } else this.finishStop();
    return this.stopPromise;
  }

  private finishStop() {
    this.status.state = "stopped";
    this.status.retryDelayMs = null;
    this.log("upstream_stopped", { socketClosed: this.socket === null });
    this.stopResolve?.();
    this.stopResolve = null;
  }
}
