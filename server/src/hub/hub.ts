import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { boardColumn, encodeFrame, parseRange, replayParams } from "./frame.ts";
import { realClock } from "./replay.ts";
import { WindowedReplay } from "./windowed-replay.ts";
import type { ReplayClock } from "./replay.ts";
import type { Column } from "../aggregate/columns.ts";
import type { Trade, BookSnapshot } from "../types.ts";
import type { Log } from "../logger.ts";
import { VolumeProfile } from "../vp/state.ts";

export const WS_PATH = "/api/ws";
export const BOARD_LIMIT = 4 * 1024 * 1024, CLOSE_LIMIT = 16 * 1024 * 1024;
export interface Socket {
  readyState: number; bufferedAmount: number;
  send(data: string | Buffer, cb?: (error?: Error) => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}
export interface View { columns: Column[]; trades: Trade[] }
export interface ConnectionOrigin { userAgent?: string; origin?: string; remoteAddress?: string }
export interface Source {
  savedRange(): { fromSec: number; toSec: number } | null;
  read(from: number, to: number): Promise<View>;
  status(): unknown;
  vp?(): VolumeProfile;
  replayVp?(from: number, alive: () => boolean): Promise<VolumeProfile>;
}
interface Peer {
  connectedAtUs: number; origin: ConnectionOrigin;
  id: number; range: { reqId: number; fromSec: number; toSec: number } | null; closeReason?: string;
  socket: Socket; mode: "live" | "replay"; initializing: boolean; closed: boolean;
  columns: Column[]; trades: Trade[]; queuedBytes: number;
  lastStatus: string; lastStatusAt: number; jobs: Promise<void>; replay?: WindowedReplay;
  replayEnded?: boolean;
  vp?: VolumeProfile; vpRevision?: number; vpGeneration?: number; vpSentAt?: number;
}
const tradeId = (t: Trade) => `${t.recvUs}:${t.seq}`;

export class Hub {
  readonly counts = { totalConnections: 0, rejectedConnections: 0, droppedBoards: 0,
    slowClosed: 0, sendErrors: 0, invalidRequests: 0, rangeRequests: 0 };
  private peers = new Set<Peer>();
  private latestBook: BookSnapshot | null = null;
  private clock: ReplayClock;
  private source: Source;
  private log: Log;
  private timer: unknown;
  private stopped = false;
  constructor(source: Source, log: Log, clock: ReplayClock = realClock) {
    this.source = source; this.log = log; this.clock = clock;
    const poll = () => {
      if (this.stopped) return;
      this.flush();
      this.timer = this.clock.later(poll, 250);
    };
    this.timer = this.clock.later(poll, 250);
  }
  snapshot() { return { path: WS_PATH, connected: this.peers.size, ...this.counts }; }
  /** HTTP diagnostics only; do not add this to the WebSocket status payload. */
  connections() {
    return [...this.peers].map(p => ({ connectedAtUs: p.connectedAtUs,
      mode: p.mode, ...p.origin, readyState: p.socket.readyState, ...this.stage(p) }));
  }
  rejectMeasurement(origin: ConnectionOrigin) {
    this.counts.rejectedConnections++;
    this.log("hub_connection_rejected", { reason: "measurement_isolation", ...origin });
  }
  private close(p: Peer, code: number, reason: string) {
    if (p.closed) return;
    p.closeReason = reason;
    p.closed = true; p.replay?.stop(); p.columns = []; p.trades = []; p.queuedBytes = 0;
    p.socket.close(code, reason);
    // Do not keep a dead/slow peer alive indefinitely waiting for its close handshake.
    const timer = this.clock.later(() => {
      if (p.socket.readyState !== 3) p.socket.terminate();
    }, 1000);
    p.socket.on("close", () => this.clock.cancel(timer));
  }
  private healthy(p: Peer) {
    if (p.closed || p.socket.readyState !== 1) return false;
    if (!p.range && p.socket.bufferedAmount + p.queuedBytes > CLOSE_LIMIT) {
      this.counts.slowClosed++; this.log("hub_slow_close", { ...this.stage(p), bufferedBytes: p.socket.bufferedAmount, queuedBytes: p.queuedBytes });
      this.close(p, 1013, "slow_consumer"); return false;
    }
    return true;
  }
  private send(p: Peer, data: string | Buffer, board = false) {
    if (!this.healthy(p)) return false;
    if (board && !p.range && p.socket.bufferedAmount > BOARD_LIMIT) { this.counts.droppedBoards++; return false; }
    const stage = this.stage(p);
    try {
      p.socket.send(data, error => {
        if (error) { this.counts.sendErrors++; this.log("hub_send_error", { ...stage, reason: "send_failed",
          closedBeforeCallback: p.closed, closeReason: p.closeReason ?? "remote", readyState: p.socket.readyState }); this.close(p, 1011, "send_failed"); }
      });
      return true;
    } catch {
      this.counts.sendErrors++; this.log("hub_send_error", { ...stage, reason: "send_failed" }); this.close(p, 1011, "send_failed");
      return false;
    }
  }
  private stage(p: Peer) {
    return { peerId: p.id, phase: p.initializing ? "initial" : p.range ? "range" : "steady", reqId: p.range?.reqId ?? null };
  }
  private json(p: Peer, value: unknown) { return this.send(p, JSON.stringify(value)); }
  private sendVp(p: Peer, force = false) {
    const vp = p.vp;
    if (!vp || (!force && this.clock.now() - (p.vpSentAt ?? -Infinity) < 1000)) return;
    const full = force || p.vpGeneration !== vp.generation;
    const message = vp.message(full ? undefined : p.vpRevision);
    if (!full && !message.levels.length) return;
    if (this.json(p, message)) {
      p.vpRevision = vp.revision; p.vpGeneration = vp.generation; p.vpSentAt = this.clock.now();
    }
  }
  private status(p: Peer, force = false, replay?: unknown) {
    if (p.closed || p.initializing) return;
    const status = this.source.status();
    const encoded = JSON.stringify({ status, ...(replay ? { replay } : {}) });
    if (force || encoded !== p.lastStatus || this.clock.now() - p.lastStatusAt >= 10000) {
      this.json(p, { type: "status", status, ...(replay ? { replay } : {}) });
      p.lastStatus = encoded; p.lastStatusAt = this.clock.now();
    }
  }
  async connect(socket: Socket, url: URL, origin: ConnectionOrigin = {}) {
    if (this.stopped || this.peers.size >= 5) {
      this.counts.rejectedConnections++;
      this.log("hub_connection_rejected", { reason: this.stopped ? "stopped" : "connection_limit" });
      socket.send(JSON.stringify({ type: "error", reqId: null, code: "connection_limit" }));
      socket.close(1013, "connection_limit");
      const t = this.clock.later(() => { if (socket.readyState !== 3) socket.terminate(); }, 1000);
      socket.on("close", () => this.clock.cancel(t));
      return;
    }
    const p: Peer = { connectedAtUs: this.clock.now() * 1000, origin,
      id: this.counts.totalConnections + 1, range: null, socket, mode: "live", initializing: true, closed: false, columns: [], trades: [],
      queuedBytes: 0, lastStatus: "", lastStatusAt: 0, jobs: Promise.resolve() };
    this.peers.add(p); this.counts.totalConnections++;
    this.log("hub_connected", { ...this.stage(p), connectedAtUs: p.connectedAtUs, ...origin });
    socket.on("close", (code: number) => {
      this.log("hub_closed", { ...this.stage(p), connectedAtUs: p.connectedAtUs,
        closedAtUs: this.clock.now() * 1000, ...p.origin, code: code ?? null, reason: p.closeReason ?? "remote" });
      p.closed = true; p.replay?.stop(); this.peers.delete(p);
    });
    socket.on("error", () => { this.log("hub_socket_error", { ...this.stage(p), reason: "socket_error" }); this.close(p, 1011, "socket_error"); });
    socket.on("message", (bytes: Buffer, binary: boolean) => {
      p.jobs = p.jobs.then(async () => {
        if (p.closed) return;
        let reqId: number | null = null;
        try {
          if (binary) throw Error("invalid_range");
          const value: unknown = JSON.parse(bytes.toString());
          if (typeof value === "object" && value !== null && Number.isInteger((value as any).reqId)) reqId = (value as any).reqId;
          const range = parseRange(value); reqId = range.reqId;
          this.counts.rangeRequests++;
          await this.range(p, range.reqId, range.fromSec, range.toSec);
        } catch (error) {
          this.counts.invalidRequests++;
          this.json(p, { type: "error", reqId, code: error instanceof SyntaxError || (error instanceof Error && error.message === "invalid_range")
            ? "invalid_range" : "range_read_failed" });
        }
      });
    });
    const initial = (async () => {
      try {
        const saved = this.source.savedRange();
        let params;
        try { params = replayParams(url, saved); }
        catch {
          this.counts.invalidRequests++; this.json(p, { type: "error", reqId: null, code: "invalid_replay_parameters" });
          this.close(p, 1008, "invalid_replay_parameters"); return;
        }
        p.mode = params ? "replay" : "live";
        this.json(p, { type: "hello", symbol: "NQ", tickSize: 0.25, columnSeconds: 1,
          serverTimeUs: this.clock.now() * 1000, mode: p.mode, savedRange: saved });
        const to = params?.fromSec ?? Math.floor(this.clock.now() / 1000);
        const view = await this.range(p, 0, Math.max(0, to - 1800), to);
        if (p.closed) return;
        if (params) {
          if (this.source.replayVp) {
            p.vp = new VolumeProfile(params.fromSec); this.sendVp(p, true);
            p.vp = await this.source.replayVp(params.fromSec, () => !p.closed && !this.stopped);
            if (p.closed) return;
            this.sendVp(p, true);
          }
          // End is frozen at connection time; new live appends do not extend this replay.
          const replay = await this.source.read(params.fromSec, Math.min(params.fromSec + 300, params.toSec));
          if (p.closed) return;
          p.columns = []; p.trades = []; p.queuedBytes = 0; p.initializing = false;
          p.replay = new WindowedReplay(replay, params.fromSec, params.toSec, params.speed,
            (from, to) => this.source.read(from, to), {
            column: c => { this.send(p, encodeFrame(1, 0, [c])); this.send(p, encodeFrame(3, 0, [c]), true); },
            trades: trades => {
              this.json(p, { type: "trades", trades });
            },
            vpTrades: trades => {
              if (p.vp) for (const t of trades) { p.vp.advance(t.tsUs / 1e6); p.vp.add(t); }
            },
            cursor: upToUs => { p.vp?.advance(upToUs / 1e6); },
            end: () => {
              this.sendVp(p, true);
              this.status(p, true, { state: "ended", ...params });
              p.replayEnded = true;
              this.log("replay_ended", params);
            },
            error: () => {
              this.json(p, { type: "error", reqId: 0, code: "initial_read_failed" });
              this.log("hub_initial_error", { reason: "initial_read_failed" });
              this.close(p, 1011, "initial_read_failed");
            },
          }, this.clock);
          p.replay.start();
        } else {
          p.vp = this.source.vp?.(); this.sendVp(p, true);
          const seconds = view.seconds;
          // Match only queued live event identities, never deduplicate by trade contents.
          const trades = view.trades;
          p.trades = p.trades.filter(t => !trades.has(tradeId(t)));
          p.initializing = false; p.queuedBytes = 0;
          for (const c of p.columns) if (!seconds.has(c.tsSec)) this.send(p, encodeFrame(1, 0, [c]));
          p.columns = [];
        }
        this.status(p, true);
      } catch {
        this.json(p, { type: "error", reqId: 0, code: "initial_read_failed" });
        this.log("hub_initial_error", { reason: "initial_read_failed" });
        this.close(p, 1011, "initial_read_failed");
      }
    })();
    p.jobs = initial;
    await initial;
  }
  private async range(p: Peer, reqId: number, from: number, to: number) {
    const initial = { seconds: new Set<number>(), trades: new Set<string>() };
    p.range = { reqId, fromSec: from, toSec: to };
    const stage = this.stage(p);
    let columns = 0, trades = 0, chunks = 0, maxBufferedBytes = 0;
    this.log("hub_range_begin", { ...stage, fromSec: from, toSec: to });
    const drain = async () => {
      while (!p.closed && p.socket.readyState === 1 && p.socket.bufferedAmount >= BOARD_LIMIT) {
        await new Promise<void>(resolve => { this.clock.later(resolve, 50); });
      }
    };
    try {
      for (let a = from; a < to; a += 300) {
        // Compression queues are included by ws.bufferedAmount. Yield instead of
        // enqueuing an entire hour and tripping our own non-range slow threshold.
        await drain();
        if (p.closed || p.socket.readyState !== 1) return initial;
        const view = await this.source.read(a, Math.min(a + 300, to));
        // Live sends may grow the queue while the disk read is awaiting I/O.
        await drain();
        if (p.closed || p.socket.readyState !== 1) return initial;
        if (!this.send(p, encodeFrame(2, reqId, view.columns))
          || !this.json(p, { type: "rangeTrades", reqId, trades: view.trades })) return initial;
        columns += view.columns.length; trades += view.trades.length; chunks++;
        maxBufferedBytes = Math.max(maxBufferedBytes, p.socket.bufferedAmount);
        if (reqId === 0) {
          for (const column of view.columns) initial.seconds.add(column.tsSec);
          for (const trade of view.trades) initial.trades.add(tradeId(trade));
        }
      }
      this.json(p, { type: "rangeDone", reqId, fromSec: from, toSec: to, columns, trades, chunks });
      this.log("hub_range_done", { ...stage, fromSec: from, toSec: to, columns, trades, chunks, maxBufferedBytes });
      return initial;
    } finally {
      if (p.closed) this.log("hub_range_aborted", { ...stage, columns, trades, chunks });
      p.range = null;
    }
  }
  book(book: BookSnapshot) { this.latestBook = book; }
  column(column: Column) {
    for (const p of this.peers) {
      if (p.mode !== "live" || !this.healthy(p)) continue;
      if (p.initializing) { p.columns.push(column); p.queuedBytes += encodeFrame(1, 0, [column]).length; this.healthy(p); }
      else this.send(p, encodeFrame(1, 0, [column]));
    }
  }
  trade(trade: Trade) {
    for (const p of this.peers) if (p.mode === "live" && this.healthy(p)) {
      p.trades.push(trade);
      if (p.initializing) { p.queuedBytes += Buffer.byteLength(JSON.stringify(trade)); this.healthy(p); }
    }
  }
  flush() {
    for (const p of this.peers) {
      if (!this.healthy(p) || p.initializing) continue;
      if (p.mode === "live") {
        if (this.latestBook) this.send(p, encodeFrame(3, 0, [boardColumn(this.latestBook)]), true);
        if (p.trades.length) {
          const trades = p.trades; p.trades = [];
          this.json(p, { type: "trades", trades });
        }
      }
      if (!p.replayEnded) this.sendVp(p);
      if (!p.replayEnded) this.status(p);
    }
  }
  stop() {
    this.stopped = true; this.clock.cancel(this.timer);
    for (const p of this.peers) this.close(p, 1001, "shutdown");
  }
}

export function attachHub(server: Server, hub: Hub, allows?: (origin?: string) => boolean) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: {
    zlibDeflateOptions: { level: 3, memLevel: 7 }, threshold: 1024, concurrencyLimit: 1,
    // ws applies threshold only with no-context-takeover. With takeover it
    // compresses all messages; document this in diagnostics rather than claiming
    // the threshold suppressed small status messages.
    clientNoContextTakeover: true,
    // Default server direction retains context. Do not force false here: ws
    // would reject the reset-context offer used by the read-only comparison probe.
    // Native browsers do not request server_no_context_takeover.
  } });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    let origin: string | undefined;
    try { origin = request.headers.origin ? new URL(request.headers.origin).origin : undefined; } catch { /* invalid origin is not copied */ }
    const metadata: ConnectionOrigin = {
      userAgent: request.headers["user-agent"]?.replace(/[\r\n]/g, " ").slice(0, 512),
      origin, remoteAddress: request.socket.remoteAddress,
    };
    if (allows && !allows(origin)) {
      hub.rejectMeasurement(metadata);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    // Never copy authorization, cookies, raw headers, or query strings.
    wss.handleUpgrade(request, socket, head, ws => { void hub.connect(ws, url, metadata); });
  });
  return wss;
}
