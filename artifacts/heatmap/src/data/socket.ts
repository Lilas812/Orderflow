import type { HeatColumn } from "../domain.ts";
import { US_PER_SECOND } from "../domain.ts";
import { ColumnCache, type TimeRange } from "./cache.ts";
import { decodeFrame, decodeTrades } from "./protocol.ts";

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
  gotColumns: boolean;
  gotTrades: boolean;
}

interface SocketLike {
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
  onConnection(state: ConnectionState, message?: string): void;
  onHello(hello: HelloMessage): void;
  onStatus(status: SocketStatus): void;
  onColumns(columns: readonly HeatColumn[], kind: 1 | 2): void;
  onLatestBook(column: HeatColumn): void;
  onTrades(count: number): void;
  onError(message: string): void;
  onReplayEnded(): void;
  onBytesPerMinute(bytes: number): void;
  onRangeRequest(range: TimeRange): void;
}

const defaultEnvironment: SocketEnvironment = {
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
  now: () => Date.now(),
};

export function buildSocketUrl(locationLike: Pick<Location, "protocol" | "host" | "search">): string {
  const scheme = locationLike.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${scheme}//${locationLike.host}/api/ws`);
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

  constructor(
    cache: ColumnCache,
    listeners: SocketListeners,
    locationLike: Pick<Location, "protocol" | "host" | "search"> = window.location,
    env: SocketEnvironment = defaultEnvironment,
  ) {
    this.cache = cache;
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
    if (this.stopped || this.ended || (this.socket && this.socket.readyState < 2)) return;
    this.listeners.onConnection(this.reconnectDelay === 1_000 ? "connecting" : "reconnecting");
    let socket: SocketLike;
    try {
      socket = this.env.createSocket(buildSocketUrl(this.locationLike));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return;
      this.listeners.onConnection("connected");
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      void this.handleMessage(event.data);
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

  private async handleMessage(data: unknown): Promise<void> {
    try {
      if (typeof data === "string") {
        this.recordBytes(new TextEncoder().encode(data).byteLength);
        this.handleJson(JSON.parse(data) as Record<string, unknown>);
        return;
      }
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
      else throw new Error("unsupported_websocket_payload");
      this.recordBytes(bytes.byteLength);
      const frame = decodeFrame(bytes);
      if (frame.kind === 1) {
        this.acceptColumns(frame.columns, 1);
        return;
      }
      if (frame.kind === 2) {
        this.acceptColumns(frame.columns, 2);
        if (frame.reqId === 0) return;
        if (this.pending?.reqId === frame.reqId) {
          this.pending.gotColumns = true;
          this.finishPendingIfReady();
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
    if (message.type === "hello") {
      const hello = message as unknown as HelloMessage;
      if (hello.symbol !== "NQ" || hello.tickSize !== 0.25 || hello.columnSeconds !== 1
        || !Number.isSafeInteger(hello.serverTimeUs) || (hello.mode !== "live" && hello.mode !== "replay")) {
        this.listeners.onError("Invalid hello contract");
        return;
      }
      const replayFrom = this.replayFromSec();
      const endSec = hello.mode === "replay" && replayFrom !== null ? replayFrom : Math.floor(hello.serverTimeUs / US_PER_SECOND);
      this.clearPendingRanges();
      this.cache.reset();
      this.cache.markCovered(endSec - 1_800, endSec);
      this.reconnectDelay = 1_000;
      this.listeners.onHello(hello);
      if (this.retryVisible) this.requestVisible(this.retryVisible.fromSec, this.retryVisible.toSec);
      return;
    }
    if (message.type === "trades" || message.type === "rangeTrades") {
      const trades = decodeTrades(message.trades);
      this.cache.addTrades(trades);
      this.listeners.onTrades(trades.length);
      if (message.type === "rangeTrades") {
        const reqId = message.reqId;
        if (typeof reqId === "number" && this.pending?.reqId === reqId) {
          this.pending.gotTrades = true;
          this.finishPendingIfReady();
        }
      }
      return;
    }
    if (message.type === "status") {
      const status = message as unknown as SocketStatus;
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
        this.pending = null;
        this.pumpRangeQueue();
      }
    }
  }

  private acceptColumns(columns: readonly HeatColumn[], kind: 1 | 2): void {
    this.cache.addColumns(columns);
    this.listeners.onColumns(columns, kind);
  }

  private pumpRangeQueue(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.pending || this.queue.length === 0 || this.stopped) return;
    const range = this.queue.shift()!;
    this.reqId = this.reqId >= 0xffff_ffff ? 1 : this.reqId + 1;
    const pending: PendingRange = { ...range, reqId: this.reqId, gotColumns: false, gotTrades: false };
    this.pending = pending;
    try {
      this.listeners.onRangeRequest(range);
      socket.send(JSON.stringify({ op: "range", reqId: pending.reqId, fromSec: pending.fromSec, toSec: pending.toSec }));
    } catch {
      this.cache.removeCoverage(pending.fromSec, pending.toSec);
      this.pending = null;
      this.queue.unshift(range);
    }
  }

  private finishPendingIfReady(): void {
    if (this.pending?.gotColumns && this.pending.gotTrades) {
      this.pending = null;
      this.pumpRangeQueue();
    }
  }

  private clearPendingRanges(): void {
    if (this.pending) this.cache.removeCoverage(this.pending.fromSec, this.pending.toSec);
    for (const range of this.queue) this.cache.removeCoverage(range.fromSec, range.toSec);
    this.pending = null;
    this.queue = [];
  }

  private recordBytes(bytes: number): void {
    this.byteEvents.push({ at: this.env.now(), bytes });
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
