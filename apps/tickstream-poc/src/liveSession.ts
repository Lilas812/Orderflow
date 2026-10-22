import WebSocket from "ws";
import { AppendStore, type AppendOptions } from "@workspace/tickstream-storage";
import { LIMITS, type Clock } from "./transport";
import { WS_OPTIONS, loopbackUrl, protocolReason } from "./wsClient";
import { RealClock } from "./localWsSession";
import { ObservationTransport, type GateASocket, type LiveSocketEvent } from "./liveTransport";

/** LOCAL ONLY. No external endpoint, key, environment read or authenticated URL.
 * Production support requires another reviewed code change after Gate A.
 */
export class GateALoopbackSocket implements GateASocket {
  private readonly endpoint: string;
  private ws: WebSocket | undefined;
  private listener: ((event: LiveSocketEvent) => void) | undefined;
  private done = false;
  private closing = false;
  forcedCleanup = false;
  private resume: (() => void) | undefined;
  private cleanup: (() => void) | undefined;
  private resolveClosed: () => void = () => {};
  readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  constructor(endpoint: string, private readonly channel: "ticks" | "book", private readonly clock: Clock,
    private readonly capacity: () => { count: number; bytes: number }) {
    this.endpoint = loopbackUrl(endpoint);
    if (!["ticks", "book"].includes(channel)) throw new Error("GATE_A_OPTIONS");
  }
  listen(listener: (event: LiveSocketEvent) => void): void { this.listener = listener; }
  private emit(event: LiveSocketEvent): void { if (!this.done && !this.closing) this.listener?.(event); }
  connect(): void {
    if (this.ws || this.done) return;
    const ws = new WebSocket(this.endpoint, WS_OPTIONS); this.ws = ws;
    ws.on("open", () => this.emit({ type: "open" }));
    ws.on("ping", () => this.emit({ type: "wsPing" })); // ws owns exact automatic response
    ws.on("pong", () => this.emit({ type: "wsPong" }));
    ws.on("message", (raw, binary) => {
      if (this.done || this.closing) return;
      if (binary) { this.emit({ type: "protocolError", reason: "FRAGMENT_PROTOCOL" }); this.terminate(); return; }
      const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (data.length > LIMITS.messageBytes) { this.emit({ type: "protocolError", reason: "PAYLOAD_TOO_LARGE" }); return; }
      this.emit({ type: "text", bytes: data });
      const c = this.capacity();
      if (!this.done && !this.closing && (c.count >= LIMITS.queueCount * .75 || c.bytes >= LIMITS.queueBytes * .75)) {
        ws.pause(); this.checkResume();
      }
    });
    ws.on("error", error => {
      const reason = protocolReason(error);
      this.emit(reason ? { type: "protocolError", reason } : { type: "error" });
    });
    ws.on("unexpected-response", (_request, response) => {
      const code = response.statusCode;
      response.destroy();
      this.emit({ type: code === 401 ? "authRejected" : code === 403 ? "entitlementRejected" : "error" });
      this.terminate(); // Never follow redirects or read/log an HTTP response body.
    });
    ws.on("close", code => {
      if (!this.closing) this.emit({ type: code === 4029 ? "connectionLimit" : "close" });
      this.settle();
    });
  }
  private send(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closing) return;
    if (this.ws.bufferedAmount + Buffer.byteLength(text) > 64 * 1024) {
      this.emit({ type: "error" }); this.terminate(); return;
    }
    this.ws.send(text, error => { if (error) this.emit({ type: "error" }); });
  }
  subscribe(): void { this.send(JSON.stringify({ op: "subscribe", channel: this.channel, symbols: ["NQ"] })); }
  pong(kind: "JSON" | "WEBSOCKET"): void { if (kind === "JSON") this.send('{"op":"pong"}'); }
  private checkResume(): void {
    this.resume?.();
    this.resume = this.clock.schedule(1, () => {
      this.resume = undefined;
      if (this.done || this.closing) return;
      const c = this.capacity();
      if (c.count <= LIMITS.queueCount * .5 && c.bytes <= LIMITS.queueBytes * .5) this.ws?.resume();
      else this.checkResume();
    });
  }
  close(): void {
    if (this.done || this.closing) return;
    this.closing = true; this.resume?.();
    if (!this.ws) { this.settle(); return; }
    this.cleanup = this.clock.schedule(LIMITS.cleanupMs, () => { this.forcedCleanup = true; this.terminate(); });
    try { this.ws.close(); } catch { this.terminate(); }
  }
  terminate(): void {
    if (this.done) return;
    this.closing = true; this.resume?.(); this.cleanup?.();
    if (!this.ws) this.settle();
    else this.ws.terminate(); // closed resolves on native close, not on terminate() request
  }
  private settle(): void {
    this.done = true; this.resume?.(); this.cleanup?.(); this.resolveClosed();
  }
}
/** Finite loopback test harness. Caller owns local server; never invoked by CLI.
 * Reconnect sockets each have their own close barrier; all must settle.
 */
export async function runGateASession(input: {
  endpoint: string; channel: "ticks" | "book"; directory: string;
  finishAfter: number; storageOptions?: AppendOptions;
}) {
  loopbackUrl(input.endpoint); // validation before opening any storage/socket
  const clock = new RealClock(), store = new AppendStore(input.directory, input.storageOptions);
  const sockets: GateALoopbackSocket[] = [];
  let pipeline: ObservationTransport;
  try {
    pipeline = new ObservationTransport(clock, () => {
      const socket = new GateALoopbackSocket(input.endpoint, input.channel, clock, () => pipeline.capacity);
      sockets.push(socket); return socket;
    }, store, { channel: input.channel, finishAfter: input.finishAfter });
    let terminal: () => void = () => {};
    const stopped = new Promise<void>(resolve => { terminal = resolve; });
    pipeline.onTerminal(terminal);
    pipeline.start();
    const monitor = setInterval(() => {
      try { const rss = process.memoryUsage().rss; pipeline.checkMemory(rss, rss); }
      catch { pipeline.checkMemory(null, null); }
    }, 100);
    try {
      const rss = process.memoryUsage().rss; pipeline.checkMemory(rss, rss);
      await stopped;
      await Promise.all(sockets.map(s => s.closed));
      if (sockets.some(s => s.forcedCleanup)) {
        pipeline.diagnostics.reason = "FORCED_TERMINATION";
        pipeline.diagnostics.note("FORCED_TERMINATION"); pipeline.diagnostics.state = "FAILED";
      }
    } finally { clearInterval(monitor); sockets.forEach(s => s.terminate()); }
    try { store.close(); }
    catch {
      pipeline.diagnostics.counts.storageFailures++;
      pipeline.diagnostics.reason = "STORAGE_FAILED"; pipeline.diagnostics.state = "FAILED";
    }
    return pipeline.report();
  } finally { store.close(); }
}
