import type { HeatColumn, Trade } from "../domain.ts";
import { US_PER_SECOND } from "../domain.ts";
import { ColumnCache, type TimeRange } from "./cache.ts";
import { decodeFrame, decodeTrades } from "./protocol.ts";
import { HistoryFreshness } from "./history-freshness.ts";
import { ACTIVE_SYMBOL } from "../instrument.ts";
import { INSTRUMENTS, type MarketSymbol } from "../../../../lib/market/instruments.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "error" | "replay-ended";

export interface HelloMessage {
  type: "hello";
  symbol: string;
  tickSize: number;
  columnSeconds: number;
  serverTimeUs: number;
  mode: "live" | "replay";
  savedRange: { fromSec: number; toSec: number } | null;
}

export interface SocketStatus {
  status: Record<string, unknown>;
  replay?: { state: string; fromSec?: number; toSec?: number; speed?: number };
}

interface PendingRange extends TimeRange {
  reqId: number;
  columns: number;
  trades: number;
  chunks: number;
  tradeChunks: number;
}

interface SocketLike {
  readonly extensions?: string;
  readyState: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SocketEnvironment {
  createSocket(url: string): SocketLike;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
  now(): number;
}

export interface SocketListeners {
  shareColumn?(column: HeatColumn): HeatColumn;
  onConnection(state: ConnectionState, message?: string): void;
  onHello(hello: HelloMessage): void;
  onStatus(status: SocketStatus): void;
  onColumns(columns: readonly HeatColumn[], kind: 1 | 2, reqId: number): void;
  onRangeComplete?(reqId: number): void;
  onLatestBook(column: HeatColumn): void;
  onTrades(count: number): void;
  onTradeBatch?(trades: readonly Trade[], reqId: number | null): void;
  onError(message: string): void;
  onReplayEnded(): void;
  onVp?(message: Record<string, unknown>): void;
  onBytesPerMinute(bytes: number): void;
  onRangeRequest(range: TimeRange): void;
}

const defaultEnvironment: SocketEnvironment = {
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
  now: () => Date.now(),
};

export function buildSocketUrl(locationLike: Pick<Location, "protocol" | "host" | "search">, symbol: MarketSymbol = ACTIVE_SYMBOL): string {
  const scheme = locationLike.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${scheme}//${locationLike.host}/api/ws`);
  if (symbol !== "NQ") url.searchParams.set("symbol", symbol);
  const params = new URLSearchParams(locationLike.search);
  if (params.get("mode") === "replay") {
    url.searchParams.set("mode", "replay");
    for (const key of ["from", "speed"]) {
      const value = params.get(key);
      if (value !== null) url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export class RealtimeClient {
  private symbol: MarketSymbol;
  private verifiedHello = false;
  private readonly cache: ColumnCache;
  private readonly listeners: SocketListeners;
  private readonly locationLike: Pick<Location, "protocol" | "host" | "search">;
  private readonly env: SocketEnvironment;
  private socket: SocketLike | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1_000;
  private stopped = true;
  private ended = false;
  private reqId = 0;
  private pending: PendingRange | null = null;
  private queue: TimeRange[] = [];
  private retryVisible: TimeRange | null = null;
  private byteEvents: { at: number; bytes: number }[] = [];
  private initialBytes = 0;
  private initialStartedAt = 0;
  private initialElapsedMs: number | null = null;
  private rangeBytes = 0;
  private readonly deliveries = new WeakMap<HeatColumn, string>();
  private readonly historyFreshness = new HistoryFreshness();
  private mode: "live" | "replay" | null = null;

  get initialLoading(): boolean { return this.pending?.reqId === 0; }
  get loadingRangeCount(): number { return (this.pending ? 1 : 0) + this.queue.length; }
  get traffic() {
    return { initialBytes: this.initialBytes, initialElapsedMs: this.initialElapsedMs,
      initialComplete: this.initialElapsedMs !== null, steadyBytesPerMinute: this.bytesPerMinute,
      rangeBytes: this.rangeBytes, extensions: this.socket?.extensions ?? "" };
  }
  get columnDeliveries() {
    return this.cache.columns.map(c => ({ timeUs: c.timeUs, source: c.source, via: this.deliveries.get(c) ?? "unknown" }));
  }

  constructor(
    cache: ColumnCache,
    listeners: SocketListeners,
    locationLike: Pick<Location, "protocol" | "host" | "search"> = window.location,
    env: SocketEnvironment = defaultEnvironment,
    symbol: MarketSymbol = ACTIVE_SYMBOL,
  ) {
    this.cache = cache;
    this.symbol = symbol;
    this.listeners = listeners;
    this.locationLike = locationLike;
    this.env = env;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.verifiedHello = false;
    this.stopped = true;
    if (this.reconnectTimer !== null) this.env.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close(1000, "client stopped");
    this.clearPendingRanges();
  }

  requestVisible(fromSec: number, toSec: number): void {
    if (fromSec >= toSec) return;
    this.retryVisible = { fromSec, toSec };
    for (const queued of this.queue) this.cache.removeCoverage(queued.fromSec, queued.toSec);
    this.queue = [];
    this.historyFreshness.retain(this.cache.getCoverage());
    // An in-flight read may predate completion. Keep its optimistic coverage
    // until rangeDone, then revalidate it once rather than overlap the requests.
    for (const range of this.historyFreshness.visible({ fromSec, toSec }, this.pending)) {
      this.cache.removeCoverage(range.fromSec, range.toSec);
    }
    const missing = this.cache.planMissingRanges(fromSec, toSec, 3_600);
    for (const range of missing) {
      this.cache.markCovered(range.fromSec, range.toSec);
      this.queue.push(range);
    }
    this.pumpRangeQueue();
  }

  get bytesPerMinute(): number {
    const cutoff = this.env.now() - 60_000;
    this.byteEvents = this.byteEvents.filter((event) => event.at >= cutoff);
    return this.byteEvents.reduce((sum, event) => sum + event.bytes, 0);
  }

  private open(): void {
    this.verifiedHello = false;
    if (this.stopped || this.ended || (this.socket && this.socket.readyState < 2)) return;
    this.listeners.onConnection(this.reconnectDelay === 1_000 ? "connecting" : "reconnecting");
    let socket: SocketLike;
    try {
      socket = this.env.createSocket(buildSocketUrl(this.locationLike, this.symbol));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.initialBytes = 0; this.initialElapsedMs = null; this.rangeBytes = 0; this.byteEvents = [];
    this.initialStartedAt = this.env.now();
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return;
      this.listeners.onConnection("connected");
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      void this.handleMessage(event.data, socket);
    };
    socket.onerror = () => {
      if (this.socket === socket) this.listeners.onConnection("error", "WebSocket transport error");
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearPendingRanges();
      if (!this.stopped && !this.ended) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.ended || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(60_000, this.reconnectDelay * 2);
    this.listeners.onConnection("reconnecting", `Retry in ${Math.ceil(delay / 1_000)}s`);
    this.reconnectTimer = this.env.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private async handleMessage(data: unknown, socket = this.socket): Promise<void> {
    try {
      if (typeof data === "string") {
        const value = JSON.parse(data) as Record<string, unknown>;
        this.recordBytes(new TextEncoder().encode(data).byteLength, value.type === "hello" || this.initialLoading
          ? "initial" : value.type === "rangeTrades" || value.type === "rangeDone" ? "range" : "steady");
        this.handleJson(value);
        return;
      }
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
      else throw new Error("unsupported_websocket_payload");
      if (this.stopped || this.socket !== socket || !this.verifiedHello) return;
      const frame = decodeFrame(bytes);
      this.recordBytes(bytes.byteLength, this.initialLoading ? "initial" : frame.kind === 2 ? "range" : "steady");
      if (frame.kind === 1) {
        this.acceptColumns(frame.columns, 1, 0);
        return;
      }
      if (frame.kind === 2) {
        this.acceptColumns(frame.columns, 2, frame.reqId);
        if (this.pending?.reqId === frame.reqId) {
          this.pending.columns += frame.columns.length;
          this.pending.chunks++;
        }
        return;
      }
      const book = frame.columns[0];
      if (book) this.listeners.onLatestBook(book);
    } catch (error) {
      this.listeners.onError(error instanceof Error ? error.message : "invalid_websocket_message");
    }
  }

  private handleJson(message: Record<string, unknown>): void {
    if (message.type !== "hello" && !this.verifiedHello) return;
    if (message.type === "vp" || message.type === "vpUpdate") {
      this.listeners.onVp?.(message); return;
    }
    if (message.type === "hello") {
      const hello = message as unknown as HelloMessage;
      if (hello.symbol !== this.symbol || hello.tickSize !== INSTRUMENTS[this.symbol].tickSize || hello.columnSeconds !== 1
        || !Number.isSafeInteger(hello.serverTimeUs) || (hello.mode !== "live" && hello.mode !== "replay")) {
        this.listeners.onError("Invalid hello contract");
        this.socket?.close(1008, "invalid_market");
        return;
      }
      this.verifiedHello = true;
      const replayFrom = this.replayFromSec();
      const endSec = hello.mode === "replay" && replayFrom !== null ? replayFrom : Math.floor(hello.serverTimeUs / US_PER_SECOND);
      this.clearPendingRanges();
      this.cache.reset();
      this.historyFreshness.reset();
      this.mode = hello.mode;
      if (hello.mode === "live") this.cache.startLiveTradeRetention(endSec);
      this.cache.markCovered(endSec - 1_800, endSec);
      this.pending = { reqId: 0, fromSec: Math.max(0, endSec - 1800), toSec: endSec,
        columns: 0, trades: 0, chunks: 0, tradeChunks: 0 };
      this.cache.tradeAggregation.beginRange(0, this.pending.fromSec * US_PER_SECOND, endSec * US_PER_SECOND);
      this.reconnectDelay = 1_000;
      this.listeners.onHello(hello);
      if (this.retryVisible) this.requestVisible(this.retryVisible.fromSec, this.retryVisible.toSec);
      return;
    }
    if (message.type === "trades" || message.type === "rangeTrades") {
      const trades = decodeTrades(message.trades);
      if (message.type === "rangeTrades") {
        const reqId = message.reqId;
        if (typeof reqId === "number" && this.pending?.reqId === reqId) {
          this.cache.tradeAggregation.appendRangeChunk(reqId, trades);
          this.listeners.onTradeBatch?.(trades, reqId);
          this.pending.trades += trades.length;
          this.pending.tradeChunks++;
        }
      } else {
        this.cache.addTrades(trades);
        this.listeners.onTradeBatch?.(trades, null);
      }
      this.listeners.onTrades(trades.length);
      return;
    }
    if (message.type === "rangeDone") {
      const pending = this.pending;
      if (!pending || message.reqId !== pending.reqId || message.fromSec !== pending.fromSec
        || message.toSec !== pending.toSec || message.columns !== pending.columns
        || message.trades !== pending.trades || message.chunks !== pending.chunks
        || pending.tradeChunks !== pending.chunks
        || pending.chunks !== Math.ceil((pending.toSec - pending.fromSec) / 300)) {
        throw new Error("invalid_range_done");
      }
      const reqId = pending.reqId;
      this.cache.tradeAggregation.commitRange(reqId);
      this.pending = null;
      if (reqId === 0) this.initialElapsedMs = this.env.now() - this.initialStartedAt;
      this.listeners.onRangeComplete?.(reqId);
      if (this.retryVisible && this.historyFreshness.visible(this.retryVisible, this.pending).length > 0) {
        this.requestVisible(this.retryVisible.fromSec, this.retryVisible.toSec);
      }
      this.pumpRangeQueue();
      return;
    }
    if (message.type === "status") {
      const status = message as unknown as SocketStatus;
      if (this.mode === "live" && this.historyFreshness.observe(status.status, this.cache.getCoverage())
        && this.retryVisible) {
        this.requestVisible(this.retryVisible.fromSec, this.retryVisible.toSec);
      }
      this.listeners.onStatus(status);
      if (status.replay?.state === "ended") {
        this.ended = true;
        this.listeners.onConnection("replay-ended", "Replay complete");
        this.listeners.onReplayEnded();
      }
      return;
    }
    if (message.type === "error") {
      const code = typeof message.code === "string" ? message.code : "server_error";
      this.listeners.onError(code);
      if (typeof message.reqId === "number" && this.pending?.reqId === message.reqId) {
        this.cache.removeCoverage(this.pending.fromSec, this.pending.toSec);
        this.cache.tradeAggregation.abortRange(this.pending.reqId);
        this.pending = null;
        this.pumpRangeQueue();
      }
    }
  }

  private acceptColumns(columns: readonly HeatColumn[], kind: 1 | 2, reqId: number): void {
    if (this.listeners.shareColumn) columns = columns.map(c => this.listeners.shareColumn!(c));
    for (const c of columns) this.deliveries.set(c, kind === 1 ? "live-kind1" : reqId === 0 ? "initial-30min" : `range:${reqId}`);
    this.cache.addColumns(columns);
    this.listeners.onColumns(columns, kind, reqId);
  }

  private pumpRangeQueue(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.pending || this.queue.length === 0 || this.stopped) return;
    const range = this.queue.shift()!;
    this.reqId = this.reqId >= 0xffff_ffff ? 1 : this.reqId + 1;
    const pending: PendingRange = { ...range, reqId: this.reqId, columns: 0, trades: 0, chunks: 0, tradeChunks: 0 };
    this.pending = pending;
    // Consume only when actually dispatched, not when queued. Pan cancellation
    // must not make a never-read interval look fresh. Failed requests use the
    // existing missing-coverage recovery, with no automatic freshness retry loop.
    this.historyFreshness.dispatched(range);
    this.cache.tradeAggregation.beginRange(pending.reqId, pending.fromSec * US_PER_SECOND, pending.toSec * US_PER_SECOND);
    try {
      this.listeners.onRangeRequest(range);
      socket.send(JSON.stringify({ op: "range", reqId: pending.reqId, fromSec: pending.fromSec, toSec: pending.toSec }));
    } catch {
      this.cache.removeCoverage(pending.fromSec, pending.toSec);
      this.cache.tradeAggregation.abortRange(pending.reqId);
      this.pending = null;
      this.queue.unshift(range);
    }
  }

  private clearPendingRanges(): void {
    if (this.pending) {
      this.cache.removeCoverage(this.pending.fromSec, this.pending.toSec);
      this.cache.tradeAggregation.abortRange(this.pending.reqId);
    }
    for (const range of this.queue) this.cache.removeCoverage(range.fromSec, range.toSec);
    this.pending = null;
    this.queue = [];
  }

  private recordBytes(bytes: number, stage: "initial" | "range" | "steady"): void {
    if (stage === "initial") this.initialBytes += bytes;
    else if (stage === "range") this.rangeBytes += bytes;
    else this.byteEvents.push({ at: this.env.now(), bytes });
    this.listeners.onBytesPerMinute(this.bytesPerMinute);
  }

  private replayFromSec(): number | null {
    const params = new URLSearchParams(this.locationLike.search);
    if (params.get("mode") !== "replay") return null;
    const value = params.get("from");
    if (!value || !/^\d+$/.test(value)) return null;
    const from = Number(value);
    return Number.isSafeInteger(from) ? from : null;
  }
}
