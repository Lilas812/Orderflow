import WebSocket from "ws";
import { WS_OPTIONS, loopbackUrl, protocolReason } from "./wsClient";
import type { Clock } from "./transport";
import { LIMITS, reviewGateB, type GateBReview, type BReason } from "./gateBConfig";
import { GateBTicks, type BEvent, type BTicksSocket } from "./gateBTransport";

export type BTarget = { kind: "LOOPBACK_TEST"; endpoint: string } | {
  kind: "PRODUCTION"; review: GateBReview; explicitExecution: boolean; secret: string;
};
type Dial = (endpoint: string, options: typeof WS_OPTIONS) => WebSocket;
/** Key-bearing URL lives only in connect()/ws internals. No URL, native error,
 * close reason, HTTP body or socket object crosses the event/report boundary. */
export class GateBWireSocket implements BTicksSocket {
  private readonly endpoint: string;
  private secret: string | undefined;
  private ws: WebSocket | undefined;
  private listener: ((event: BEvent) => void) | undefined;
  private closing = false;
  private done = false;
  private resume: (() => void) | undefined;
  private cleanup: (() => void) | undefined;
  private resolveClosed: () => void = () => {};
  forcedCleanup = false;
  readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
  constructor(target: BTarget, private readonly clock: Clock,
    private readonly capacity: () => { count: number; bytes: number },
    private readonly dial: Dial = (url, options) => new WebSocket(url, options)) {
    if (target.kind === "LOOPBACK_TEST") this.endpoint = loopbackUrl(target.endpoint);
    else if (target.kind === "PRODUCTION") {
      if (reviewGateB(target.review, target.explicitExecution).length || typeof target.secret !== "string" ||
        !target.secret.length || target.secret.length > 4096) throw new Error("GATE_B_NOT_AUTHORIZED");
      this.endpoint = target.review.endpoint!; this.secret = target.secret;
    } else throw new Error("GATE_B_NOT_AUTHORIZED");
  }
  listen(listener: (event: BEvent) => void): void { this.listener = listener; }
  private emit(event: BEvent): void { if (!this.done && !this.closing) this.listener?.(event); }
  connect(): void {
    if (this.done || this.ws) return;
    try {
      const url = new URL(this.endpoint);
      if (this.secret !== undefined) url.searchParams.set("key", this.secret);
      const ws = this.dial(url.href, WS_OPTIONS); this.ws = ws; this.secret = undefined;
      ws.on("open", () => this.emit({ type: "open" }));
      ws.on("message", (raw, binary) => {
        if (this.closing || this.done) return;
        if (binary) { this.emit({ type: "protocolFailure" }); this.terminate(); return; }
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
        if (bytes.length > LIMITS.messageBytes) { this.emit({ type: "protocolFailure" }); this.terminate(); return; }
        this.emit({ type: "text", bytes });
        const c = this.capacity();
        if (!this.closing && !this.done &&
          (c.count >= LIMITS.queueCount * .75 || c.bytes >= LIMITS.queueBytes * .75)) { ws.pause(); this.checkResume(); }
      });
      ws.on("ping", () => {
        // autoPong has already echoed the payload; never send a second pong.
        if (ws.bufferedAmount > 64 * 1024) { this.emit({ type: "error" }); this.terminate(); }
        else this.emit({ type: "ping" });
      });
      ws.on("pong", () => this.emit({ type: "pong" }));
      ws.on("error", error => this.emit({ type: protocolReason(error) ? "protocolFailure" : "error" }));
      ws.on("unexpected-response", (_req, res) => {
        const status = res.statusCode; res.destroy();
        this.emit({ type: status === 401 ? "authRejected" : status === 403 ? "entitlementRejected" : "error" });
        this.terminate();
      });
      ws.on("close", code => {
        if (!this.closing) this.emit({ type: code === 4029 ? "connectionLimit" : "close" });
        this.settle();
      });
    } catch {
      this.secret = undefined; this.emit({ type: "error" }); this.terminate();
    }
  }
  subscribe(): void {
    this.send('{"op":"subscribe","channel":"ticks","symbols":["NQ"]}', true);
  }
  jsonPong(): void { this.send('{"op":"pong"}', false); }
  private send(text: string, subscription: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closing) return;
    if (this.ws.bufferedAmount + Buffer.byteLength(text) > 64 * 1024) { this.emit({ type: "error" }); this.terminate(); return; }
    this.ws.send(text, error => {
      if (error) this.emit({ type: "error" });
      else if (subscription) this.emit({ type: "subscriptionSent" });
    });
  }
  private checkResume(): void {
    this.resume?.(); this.resume = this.clock.schedule(1, () => {
      this.resume = undefined;
      if (this.done || this.closing) return;
      const c = this.capacity();
      if (c.count <= LIMITS.queueCount * .5 && c.bytes <= LIMITS.queueBytes * .5) this.ws?.resume();
      else this.checkResume();
    });
  }
  close(): void {
    if (this.done || this.closing) return;
    this.closing = true; this.secret = undefined; this.resume?.();
    if (!this.ws) { this.settle(); return; }
    this.cleanup = this.clock.schedule(LIMITS.cleanupMs, () => { this.forcedCleanup = true; this.terminate(); });
    try { this.ws.close(); } catch { this.terminate(); }
  }
  terminate(): void {
    if (this.done) return;
    this.closing = true; this.secret = undefined; this.resume?.(); this.cleanup?.();
    if (this.ws) this.ws.terminate(); else this.settle();
  }
  private settle(): void { this.done = true; this.resume?.(); this.cleanup?.(); this.resolveClosed(); }
}
class MonotonicClock implements Clock {
  monoNs(): bigint { return process.hrtime.bigint(); }
  utcMs(): number { return Date.now(); }
  schedule(ms: number, callback: () => void): () => void {
    const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
  }
}
/** RAM-only. No storage import, disk output, raw IPC or market callback.
 * onStopReady exposes only a fixed-reason stop operation to the supervisor. */
export async function runGateBSession(target: BTarget, options: {
  finishAfter?: number; onStopReady?: (stop: (reason: BReason) => void) => void;
} = {}) {
  if (target.kind === "PRODUCTION" && reviewGateB(target.review, target.explicitExecution).length) {
    throw new Error("GATE_B_NOT_AUTHORIZED");
  }
  const clock = new MonotonicClock(), sockets: GateBWireSocket[] = [];
  let pipeline: GateBTicks;
  pipeline = new GateBTicks(clock, () => {
    const socket = new GateBWireSocket(target, clock, () => pipeline.capacity); sockets.push(socket); return socket;
  }, target.kind === "PRODUCTION" ? "PRODUCTION" : "LOOPBACK_TEST", { finishAfter: options.finishAfter });
  let resolveStop: () => void = () => {};
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  pipeline.onTerminal(resolveStop);
  const started = performance.now(); let peak = 0, memoryFailed = false, memoryReason: BReason | null = null;
  const sample = () => {
    try {
      const rss = process.memoryUsage().rss;
      if (!Number.isSafeInteger(rss) || rss < 0) throw Error();
      peak = Math.max(peak, rss);
      if (rss > LIMITS.sessionRss) { memoryReason = "MEMORY_THRESHOLD"; pipeline.stop(memoryReason); }
      if (performance.now() - started >= LIMITS.wallMs) pipeline.stop("WALL_TIME_LIMIT");
    } catch { memoryFailed = true; memoryReason = "MEMORY_NOT_MEASURED"; pipeline.stop(memoryReason); }
  };
  pipeline.start();
  options.onStopReady?.(reason => pipeline.stop(reason));
  sample(); const monitor = setInterval(sample, 50);
  try {
    await stopped; await Promise.all(sockets.map(socket => socket.closed)); sample();
    const result = pipeline.report();
    if (memoryReason) { result.phase = "FAILED"; result.stopReason = memoryReason; }
    if (sockets.some(socket => socket.forcedCleanup)) { result.phase = "FAILED"; result.stopReason = "FORCED_TERMINATION"; }
    result.memory = { measurement: memoryFailed ? "NOT_MEASURED" : "MEASURED",
      childRssPeak: peak || null, totalRssPeak: target.kind === "LOOPBACK_TEST" ? peak || null : null };
    // Production parent independently fills combined RSS; child cannot claim it.
    if (target.kind === "PRODUCTION") result.memory.measurement = "NOT_MEASURED";
    return result;
  } finally { clearInterval(monitor); sockets.forEach(socket => socket.terminate()); }
}
