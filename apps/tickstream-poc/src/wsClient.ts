import WebSocket from "ws";
import type { ClientRequestArgs } from "node:http";
import { LIMITS, type Clock, type Socket, type SocketEvent } from "./transport";

/** Fixed-version public options, verified against ws 8.22.0 and its Receiver. */
export const WS_OPTIONS = Object.freeze({
  maxPayload: LIMITS.messageBytes,
  maxFragments: LIMITS.fragments,
  maxBufferedChunks: 1024,
  handshakeTimeout: LIMITS.handshakeMs,
  followRedirects: false,
  maxRedirects: 0,
  perMessageDeflate: false,
  skipUTF8Validation: false,
  autoPong: true,
  allowSynchronousEvents: true,
  agent: false as const,
  rejectUnauthorized: true,
  // @types/ws narrows agent to Agent, although its constructor also accepts
  // Node's ClientRequestArgs and ws documents all http.request options.
} satisfies Omit<WebSocket.ClientOptions, "agent"> & Pick<ClientRequestArgs, "agent">);
export const SUBSCRIPTION = '{"op":"subscribe","channel":"ticks","symbols":["NQ"]}';
export const WIRE_KEYS = [
  "opens", "subscriptionSent", "textMessages", "binaryRejected",
  "protocolPing", "protocolPong", "jsonPongSent", "protocolFailures",
  "payloadLimit", "fragmentOrChunkLimit", "invalidUtf8", "otherProtocol",
  "redirectRejected", "authenticationRejected", "pauses", "resumes",
  "closes", "errors", "terminations",
] as const;
export type WireCounters = Record<typeof WIRE_KEYS[number], number>;
export function emptyWireCounters(): WireCounters {
  return Object.fromEntries(WIRE_KEYS.map(key => [key, 0])) as WireCounters;
}

/** Never resolve a caller-controlled hostname. No credentials/query/IPC/proxy URL. */
export function loopbackUrl(input: string): string {
  try {
    const url = new URL(input);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !url.port ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error();
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    return url.href;
  } catch { throw new Error("LOOPBACK_ENDPOINT_REQUIRED"); }
}

export type ProtocolReason = Extract<SocketEvent, { type: "protocolError" }>["reason"];
/** Static classification only; never forward an exception or its message/stack. */
export function protocolReason(error: unknown): ProtocolReason | null {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") return "PAYLOAD_TOO_LARGE";
  if (code === "WS_ERR_TOO_MANY_BUFFERED_PARTS") return "FRAGMENT_LIMIT";
  if (code === "WS_ERR_INVALID_UTF8") return "INVALID_UTF8";
  return typeof code === "string" && code.startsWith("WS_ERR_") ? "FRAGMENT_PROTOCOL" : null;
}

/**
 * Loopback-only real RFC 6455 adapter. No provider ACK schema is invented.
 * autoPong owns protocol replies (including echo data); Transport's matching
 * pong("WEBSOCKET") call is deliberately a no-op. JSON pong is a separate send.
 */
export class WsClient implements Socket {
  private readonly url: string;
  private listener: ((event: SocketEvent) => void) | undefined;
  private ws: WebSocket | undefined;
  private connectCalled = false;
  private subscribeCalled = false;
  private disposed = false;
  private closing = false;
  private faulted = false;
  private resumeTimer: (() => void) | undefined;
  private closeTimer: (() => void) | undefined;
  private resolveClosed: () => void = () => {};
  /** Cleanup barrier only; never carries payloads or an unbounded callback queue. */
  readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  readonly counters: WireCounters;
  constructor(
    url: string,
    private readonly clock: Clock,
    private readonly capacity: () => { count: number; bytes: number },
    counters: WireCounters = emptyWireCounters(),
  ) {
    this.url = loopbackUrl(url); // Before any socket or DNS operation.
    this.counters = counters;
  }
  listen(listener: (event: SocketEvent) => void): void { this.listener = listener; }
  private emit(event: SocketEvent): void {
    if (!this.disposed && !this.faulted) this.listener?.(event);
  }
  private fail(reason: ProtocolReason): void {
    if (this.disposed || this.faulted) return;
    this.counters.protocolFailures++;
    const key = reason === "PAYLOAD_TOO_LARGE" ? "payloadLimit" :
      reason === "FRAGMENT_LIMIT" ? "fragmentOrChunkLimit" :
        reason === "INVALID_UTF8" ? "invalidUtf8" : "otherProtocol";
    this.counters[key]++;
    // Set before callback: a reentrant Transport.stop() can dispose this socket.
    this.faulted = true;
    this.listener?.({ type: "protocolError", reason });
    this.terminate();
  }
  connect(): void {
    if (this.connectCalled || this.disposed) return;
    this.connectCalled = true;
    const socket = new WebSocket(this.url, WS_OPTIONS);
    this.ws = socket;
    socket.binaryType = "nodebuffer";
    socket.on("open", () => { this.counters.opens++; this.emit({ type: "open" }); });
    socket.on("message", (data, binary) => {
      if (this.disposed || this.faulted || this.closing) return;
      if (binary) { this.counters.binaryRejected++; this.fail("FRAGMENT_PROTOCOL"); return; }
      // With binaryType=nodebuffer, ws text data is Buffer. Never stringify raw.
      if (!Buffer.isBuffer(data)) { this.fail("FRAGMENT_PROTOCOL"); return; }
      if (data.byteLength > LIMITS.messageBytes) { this.fail("PAYLOAD_TOO_LARGE"); return; }
      this.counters.textMessages++;
      this.emit({ type: "text", bytes: data });
      this.backpressure();
    });
    socket.on("ping", () => {
      if (this.disposed || this.closing) return;
      this.counters.protocolPing++; this.emit({ type: "wsPing" });
      this.checkSender();
    });
    socket.on("pong", () => {
      if (this.disposed || this.closing) return;
      this.counters.protocolPong++; this.emit({ type: "wsPong" });
    });
    socket.on("unexpected-response", (request, response) => {
      if (this.disposed) { response.destroy(); request.destroy(); return; }
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        this.counters.redirectRejected++; this.fail("FRAGMENT_PROTOCOL");
      } else if (status === 401 || status === 403) {
        this.counters.authenticationRejected++; this.emit({ type: "authRejected" });
        this.terminate();
      } else {
        this.counters.errors++; this.emit({ type: "error" }); this.terminate();
      }
      // No response body/location/headers are retained or logged.
      response.destroy(); request.destroy();
    });
    socket.on("error", error => {
      if (this.disposed || this.faulted) return;
      const reason = protocolReason(error);
      if (reason) { this.fail(reason); return; }
      this.counters.errors++; this.emit({ type: "error" });
    });
    socket.on("close", () => {
      this.counters.closes++;
      this.clearTimers();
      this.emit({ type: "close" });
      this.disposed = true; this.listener = undefined; this.ws = undefined;
      socket.removeAllListeners();
      this.resolveClosed();
    });
  }
  subscribe(): void {
    const socket = this.ws;
    if (this.subscribeCalled || this.disposed || this.closing || socket?.readyState !== WebSocket.OPEN) return;
    this.subscribeCalled = true;
    socket.send(SUBSCRIPTION, error => {
      if (this.disposed || this.closing) return;
      if (error) { this.counters.errors++; this.emit({ type: "error" }); }
      else this.counters.subscriptionSent++;
      // Send completion is NOT a provider acknowledgement.
    });
    this.checkSender();
  }
  pong(kind: "JSON" | "WEBSOCKET"): void {
    if (kind === "WEBSOCKET" || this.disposed || this.closing) return;
    const socket = this.ws;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send('{"op":"pong"}', error => {
      if (this.disposed || this.closing) return;
      if (error) { this.counters.errors++; this.emit({ type: "error" }); }
      else this.counters.jsonPongSent++;
    });
    this.checkSender();
  }
  private checkSender(): void {
    if ((this.ws?.bufferedAmount ?? 0) > 64 * 1024) this.fail("FRAGMENT_PROTOCOL");
  }
  private backpressure(): void {
    const socket = this.ws;
    if (!socket || this.disposed || this.closing) return;
    const pending = this.capacity();
    if (!socket.isPaused && (pending.count >= LIMITS.queueCount * .75 || pending.bytes >= LIMITS.queueBytes * .75)) {
      socket.pause(); this.counters.pauses++;
    }
    if (!socket.isPaused || this.resumeTimer) return;
    this.resumeTimer = this.clock.schedule(1, () => {
      this.resumeTimer = undefined;
      if (this.disposed || this.closing) return;
      const current = this.capacity();
      if (current.count <= LIMITS.queueCount * .5 && current.bytes <= LIMITS.queueBytes * .5) {
        socket.resume(); this.counters.resumes++;
      } else this.backpressure();
    });
  }
  private clearTimers(): void {
    this.resumeTimer?.(); this.resumeTimer = undefined;
    this.closeTimer?.(); this.closeTimer = undefined;
  }
  close(): void {
    if (this.disposed || this.closing) return;
    this.closing = true; this.clearTimers();
    this.closeTimer = this.clock.schedule(LIMITS.cleanupMs, () => this.terminate());
    try { this.ws?.close(); } catch { this.terminate(); }
  }
  terminate(): void {
    if (this.disposed) return;
    this.disposed = true; this.listener = undefined;
    this.clearTimers(); this.counters.terminations++;
    // Keep the error/close handlers until ws finishes aborting a handshake.
    // They absorb late errors without exposing raw exceptions or old-epoch data.
    this.ws?.terminate();
    if (!this.ws) this.resolveClosed();
  }
}
