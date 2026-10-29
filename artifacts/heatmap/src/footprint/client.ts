import { US_PER_SECOND } from "../domain.ts";
import { decodeTrades } from "../data/protocol.ts";
import { HistoryFreshness } from "../data/history-freshness.ts";
import { INSTRUMENTS, type MarketSymbol } from "../../../../lib/market/instruments.ts";
import { FootprintStore, mergeRanges, type Gap, type Range } from "./model.ts";

export type FpConnection = "connecting" | "connected" | "reconnecting" | "error";

interface SocketLike {
  readyState: number;
  onopen: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onclose: ((e: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export interface FpEnv {
  createSocket(url: string): SocketLike;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(h: number): void;
  now(): number; // ms
}
const defaultEnv: FpEnv = {
  createSocket: url => new WebSocket(url) as unknown as SocketLike,
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: h => window.clearTimeout(h),
  now: () => Date.now(),
};
export interface FpListeners {
  onData(): void;
  onState(): void;
}
export interface RequestLog { reqId: number; fromSec: number; toSec: number; state: "pending" | "done" | "error" | "dropped"; trades: number; reason?: string; }

export function footprintSocketUrl(loc: Pick<Location, "protocol" | "host">, symbol: MarketSymbol): string {
  const url = new URL(`${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/api/ws`);
  url.searchParams.set("view", "footprint");
  url.searchParams.set("symbol", symbol);
  return url.toString();
}

function parseRanges(v: unknown): Range[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((r): Range[] => {
    if (Array.isArray(r) && Number.isSafeInteger(r[0]) && Number.isSafeInteger(r[1])) return [[r[0], r[1]]];
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      const a = o.fromSec ?? o.startSec, b = o.toSec ?? o.endSec;
      if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return [[a as number, b as number]];
    }
    return [];
  });
}
function parseGaps(v: unknown): Gap[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap(g => {
    const o = g as Record<string, unknown> | null;
    if (!o || !Number.isSafeInteger(o.startSec) || !Number.isSafeInteger(o.endSec)) return [];
    return [{ startSec: o.startSec as number, endSec: o.endSec as number, reason: typeof o.reason === "string" ? o.reason : "unknown" }];
  });
}

/** Footprint-only socket: hello(generation) + live trades + stored-history ranges (<=3600 s each). */
export class FootprintClient {
  readonly store: FootprintStore;
  state: FpConnection = "connecting";
  stateMessage = "";
  lastError = "";
  quality = "";
  requests: RequestLog[] = [];
  private socket: SocketLike | null = null;
  private stopped = true;
  private verified = false;
  private reconnectTimer: number | null = null;
  private fillTimer: number | null = null;
  private delay = 1_000;
  private reqId = 0;
  private pending: { reqId: number; from: number; to: number; trades: number } | null = null;
  private queue: Range[] = [];
  private visible: Range | null = null;
  private offsetUs = 0;
  private hasClock = false;
  private freshness = new HistoryFreshness();
  private stale: Range[] = [];

  private readonly symbol: MarketSymbol;
  private readonly listeners: FpListeners;
  private readonly loc: Pick<Location, "protocol" | "host">;
  private readonly env: FpEnv;
  constructor(symbol: MarketSymbol, store: FootprintStore, listeners: FpListeners,
    loc: Pick<Location, "protocol" | "host"> = window.location, env: FpEnv = defaultEnv) {
    this.symbol = symbol; this.store = store; this.listeners = listeners; this.loc = loc; this.env = env;
  }

  get queued(): readonly Range[] { return this.queue; }
  get pendingRequest() { return this.pending; }
  get connected(): boolean { return this.verified; }
  nowSec(): number { return Math.floor((this.env.now() * 1_000 + this.offsetUs) / US_PER_SECOND); }
  get clockKnown(): boolean { return this.hasClock; }

  start(): void { if (!this.stopped) return; this.stopped = false; this.open(); }
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) this.env.clearTimeout(this.reconnectTimer);
    if (this.fillTimer !== null) this.env.clearTimeout(this.fillTimer);
    this.reconnectTimer = this.fillTimer = null;
    const s = this.socket; this.socket = null;
    if (s && s.readyState < 2) s.close(1000, "client stopped");
    this.dropRequests();
  }

  /** Initial-visible-only policy: only what is on screen is requested. */
  setVisible(fromSec: number, toSec: number): void {
    if (fromSec >= toSec) return;
    const same = this.visible && this.visible[0] === fromSec && this.visible[1] === toSec;
    this.visible = [fromSec, toSec];
    if (!same) this.plan();
  }
  /** Explicit retry: forget known failures/evictions in view and re-read stored history. */
  retry(): void {
    if (!this.visible) return;
    this.store.clearFailures(this.visible[0], this.visible[1]);
    this.stale = mergeRanges([...this.stale, this.visible]);
    this.lastError = "";
    if (!this.socket && !this.stopped) { this.delay = 1_000; if (this.reconnectTimer !== null) { this.env.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; } this.open(); }
    this.plan();
    this.listeners.onState();
  }

  private plan(): void {
    if (!this.verified || !this.visible) return;
    this.store.retain(this.nowSec());
    const deferred = this.freshness.visible({ fromSec: this.visible[0], toSec: this.visible[1] },
      this.pending ? { fromSec: this.pending.from, toSec: this.pending.to } : null);
    if (deferred.length) {
      this.store.clearFailures(this.visible[0], this.visible[1]);
      this.stale = mergeRanges([...this.stale, ...deferred.map((r): Range => [r.fromSec, r.toSec])]);
    }
    const visibleStale = this.stale.filter(([a, b]) => a < this.visible![1] && b > this.visible![0]);
    this.queue = this.store.missing(this.visible[0], this.visible[1], this.nowSec(), visibleStale);
    this.pump();
    this.listeners.onState();
  }

  private open(): void {
    this.verified = false;
    if (this.stopped) return;
    this.state = this.delay === 1_000 ? "connecting" : "reconnecting";
    this.listeners.onState();
    let socket: SocketLike;
    try { socket = this.env.createSocket(footprintSocketUrl(this.loc, this.symbol)); }
    catch { this.scheduleReconnect(); return; }
    this.socket = socket;
    socket.onmessage = e => { if (this.socket === socket && typeof e.data === "string") this.handle(e.data); };
    socket.onerror = () => { if (this.socket === socket) { this.state = "error"; this.stateMessage = "WebSocket transport error"; this.listeners.onState(); } };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.store.disconnect(this.nowSec());
      this.verified = false;
      this.dropRequests();
      this.scheduleReconnect();
    };
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const d = this.delay; this.delay = Math.min(60_000, this.delay * 2);
    this.state = "reconnecting"; this.stateMessage = `Retry in ${Math.ceil(d / 1000)}s`;
    this.listeners.onState();
    this.reconnectTimer = this.env.setTimeout(() => { this.reconnectTimer = null; this.open(); }, d);
  }
  private dropRequests(): void {
    if (this.pending) {
      this.store.abortRange(this.pending.reqId);
      const log = this.requests.find(r => r.reqId === this.pending!.reqId);
      if (log) log.state = "dropped";
    }
    this.pending = null; this.queue = [];
  }

  private pump(): void {
    const s = this.socket;
    if (!s || s.readyState !== 1 || this.pending || !this.verified) return;
    const next = this.queue.shift();
    if (!next) return;
    this.reqId = this.reqId >= 0xffff_ffff ? 1 : this.reqId + 1;
    const [from, to] = next;
    this.pending = { reqId: this.reqId, from, to, trades: 0 };
    this.store.beginRange(this.reqId, from, to);
    this.freshness.dispatched({ fromSec: from, toSec: to });
    this.stale = mergeRanges(this.stale.flatMap(([a, b]): Range[] => {
      const parts: Range[] = []; if (a < from) parts.push([a, Math.min(b, from)]); if (b > to) parts.push([Math.max(a, to), b]); return parts;
    }));
    this.requests.push({ reqId: this.reqId, fromSec: from, toSec: to, state: "pending", trades: 0 });
    if (this.requests.length > 40) this.requests.splice(0, this.requests.length - 40);
    try { s.send(JSON.stringify({ op: "range", reqId: this.reqId, fromSec: from, toSec: to })); }
    catch { this.store.abortRange(this.reqId); this.pending = null; this.queue.unshift(next); }
  }

  private fail(reason: string): void {
    const p = this.pending;
    if (!p) return;
    this.store.abortRange(p.reqId, reason);
    const log = this.requests.find(r => r.reqId === p.reqId);
    if (log) { log.state = "error"; log.reason = reason; }
    this.pending = null;
    this.lastError = reason;
    this.listeners.onData();
    this.pump();
  }

  /** Exposed for tests. */
  handle(raw: string): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw) as Record<string, unknown>; } catch { this.lastError = "invalid_json"; return; }
    if (m.type === "hello") return this.onHello(m);
    if (!this.verified) return;
    try {
      if (m.type === "trades") {
        const trades = decodeTrades(m.trades);
        this.store.appendLive(trades);
        this.listeners.onData();
      } else if (m.type === "rangeTrades") {
        if (!this.pending || m.reqId !== this.pending.reqId) return; // stale request or old socket
        let trades;
        try { trades = decodeTrades(m.trades); this.store.appendRange(this.pending.reqId, trades); }
        catch (e) { this.fail(e instanceof Error ? e.message : "invalid_range_trades"); return; }
        this.pending.trades += trades.length;
      } else if (m.type === "rangeDone") {
        const p = this.pending;
        if (!p || m.reqId !== p.reqId) return;
        if (m.fromSec !== p.from || m.toSec !== p.to || (typeof m.trades === "number" && m.trades !== p.trades)) { this.fail("invalid_range_done"); return; }
        const fp = (m.footprint ?? {}) as Record<string, unknown>;
        if (typeof fp.quality === "string") this.quality = fp.quality;
        const coverage = m.footprint ? parseRanges(fp.coverage) : [];
        try { this.store.commitRange(p.reqId, { coverage, gaps: parseGaps(fp.gaps), noData: parseRanges(fp.noData) }); }
        catch (e) { this.fail(e instanceof Error ? e.message : "range_commit_failed"); return; }
        const log = this.requests.find(r => r.reqId === p.reqId);
        if (log) { log.state = "done"; log.trades = p.trades; }
        this.pending = null;
        this.listeners.onData();
        this.pump();
        if (!this.pending && this.queue.length === 0) this.plan();
      } else if (m.type === "status") {
        const status = (m.status ?? {}) as Record<string, unknown>;
        const covered = this.store.coverage.map(([a, b]) => ({ fromSec: a, toSec: b }));
        if (this.pending) covered.push({ fromSec: this.pending.from, toSec: this.pending.to });
        if (this.freshness.observe(status, covered)) {
          // Backfill completed: lazily revalidate once, only what is on screen.
          const view = this.visible;
          if (view) {
            const pend = this.pending ? { fromSec: this.pending.from, toSec: this.pending.to } : null;
            const fresh = this.freshness.visible({ fromSec: view[0], toSec: view[1] }, pend);
            const gapRanges = this.store.gaps.map((g): Range => [g.startSec, g.endSec]).filter(([a, b]) => a < view[1] && b > view[0]);
            if (fresh.length || gapRanges.length) {
              this.store.clearFailures(view[0], view[1]);
              this.stale = mergeRanges([...this.stale, ...fresh.map((r): Range => [r.fromSec, r.toSec])]);
              this.plan();
            }
          }
        }
        this.listeners.onState();
      } else if (m.type === "error") {
        const code = typeof m.code === "string" ? m.code : "server_error";
        if (typeof m.reqId === "number" && this.pending?.reqId === m.reqId) this.fail(code);
        else { this.lastError = code; this.listeners.onState(); }
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : "invalid_message";
      this.listeners.onState();
    }
  }

  private onHello(m: Record<string, unknown>): void {
    if (m.symbol !== this.symbol || m.tickSize !== INSTRUMENTS[this.symbol].tickSize || m.mode !== "live"
      || !Number.isSafeInteger(m.serverTimeUs) || typeof m.generation !== "string" || !m.generation) {
      this.lastError = "invalid_hello"; this.state = "error"; this.stateMessage = "Invalid hello contract";
      this.socket?.close(1008, "invalid_market"); this.listeners.onState();
      return;
    }
    this.offsetUs = (m.serverTimeUs as number) - this.env.now() * 1_000;
    this.hasClock = true;
    this.dropRequests();
    const generationChanged = this.store.generation !== m.generation;
    this.store.hello(m.generation, Math.floor((m.serverTimeUs as number) / US_PER_SECOND));
    if (generationChanged) { this.freshness.reset(); this.stale = []; }
    this.verified = true; this.delay = 1_000;
    this.state = "connected"; this.stateMessage = "";
    // The hello second is partial; read it from storage once it has ended.
    if (this.fillTimer !== null) this.env.clearTimeout(this.fillTimer);
    this.fillTimer = this.env.setTimeout(() => { this.fillTimer = null; this.plan(); }, 1_500);
    this.plan();
    this.listeners.onData();
  }
}
