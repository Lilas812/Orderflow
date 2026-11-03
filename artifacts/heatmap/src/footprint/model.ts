import { US_PER_SECOND, type Trade } from "../domain.ts";

/** Normalized trade; `contract` is optional (absent or UNKNOWN = not identified). */
export type FpTrade = Trade;
/** Half-open [fromSec, toSec). */
export type Range = [number, number];
export interface Gap { startSec: number; endSec: number; reason: string; }
export type SecondState = "recorded" | "empty" | "live" | "loading" | "gap" | "overflow" | "unloaded" | "future";

export const TIMEFRAMES = [5, 15, 30, 60] as const;
export type Timeframe = typeof TIMEFRAMES[number];
export const DISPLAY_TIMEFRAMES = [5, 15, 30, 60, 120, 300, 900] as const;
export type DisplayTimeframe = typeof DISPLAY_TIMEFRAMES[number];
export const UNKNOWN_CONTRACT_KEY = "UNKNOWN";
/** Browse window: the last two hours only. */
export const RETAIN_SEC = 7_200;
/** Record-count budget, NOT a byte/JS-heap bound (objects, cells and maps add overhead). */
export const MAX_TRADES = 300_000;
/** On overflow, evict down to this fraction so eviction is batched, not per trade. */
export const EVICT_TO = 0.9;
export const REQUEST_CHUNK_SEC = 1_800;
export const MAX_REQUEST_SEC = 3_600;

export const contractKey = (t: { contract?: string }) => t.contract || UNKNOWN_CONTRACT_KEY;
const identity = (t: Trade) => `${t.recvUs}:${t.seq}`;
const secOf = (us: number) => Math.floor(us / US_PER_SECOND);

/* ---------------- range helpers ---------------- */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const out: Range[] = [];
  for (const [a, b] of [...ranges].filter(r => r[0] < r[1]).sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
export function subtractRanges(ranges: readonly Range[], cut: readonly Range[]): Range[] {
  let cur = mergeRanges(ranges);
  for (const [c0, c1] of cut) {
    cur = cur.flatMap(([a, b]): Range[] => {
      if (b <= c0 || a >= c1) return [[a, b]];
      const parts: Range[] = [];
      if (a < c0) parts.push([a, c0]);
      if (b > c1) parts.push([c1, b]);
      return parts;
    });
  }
  return cur;
}
export function clipRanges(ranges: readonly Range[], from: number, to: number): Range[] {
  return ranges.map(([a, b]): Range => [Math.max(a, from), Math.min(b, to)]).filter(r => r[0] < r[1]);
}
export const overlaps = (ranges: readonly Range[], from: number, to: number) => ranges.some(([a, b]) => a < to && b > from);
export function covers(ranges: readonly Range[], from: number, to: number): boolean {
  let cursor = from;
  for (const [a, b] of mergeRanges(ranges)) {
    if (a > cursor) break;
    cursor = Math.max(cursor, b);
    if (cursor >= to) return true;
  }
  return from >= to;
}
export function splitRanges(ranges: readonly Range[], chunk = REQUEST_CHUNK_SEC): Range[] {
  const out: Range[] = [];
  for (const [a, b] of ranges) for (let s = a; s < b; s += chunk) out.push([s, Math.min(b, s + chunk)]);
  return out;
}

/* ---------------- bars ---------------- */
interface Series { cells: Map<number, { buy: number; sell: number; undirected?: number }>; open: number; close: number; high: number; low: number; count: number; }
interface Rec extends FpTrade { viaLive: boolean; }
interface Sec { trades: Rec[]; ids: Set<string>; series: Map<string, Series>; }

export interface FootprintBar {
  contract: string; startSec: number; endSec: number;
  open: number; high: number; low: number; close: number;
  volume: number; delta: number; buyTotal: number; sellTotal: number; poc: number; count: number;
  /** Ascending by price. */
  prices: Int32Array; buy: Uint32Array; sell: Uint32Array; undirected?: Uint32Array; undirectedTotal?: number;
}
export type BarGroup = Map<string, FootprintBar>;

/** Price-level and total math in one place (tested). Ties for POC take the higher price. */
export function buildBar(contract: string, startSec: number, tf: number, parts: readonly Series[]): FootprintBar | null {
  if (parts.length === 0) return null;
  const cells = new Map<number, { buy: number; sell: number; undirected?: number }>();
  let high = -Infinity, low = Infinity, count = 0;
  for (const p of parts) {
    for (const [price, c] of p.cells) {
      const cell = cells.get(price);
      if (cell) { cell.buy += c.buy; cell.sell += c.sell; cell.undirected = (cell.undirected ?? 0) + (c.undirected ?? 0); }
      else cells.set(price, { ...c });
    }
    high = Math.max(high, p.high); low = Math.min(low, p.low); count += p.count;
  }
  const prices = Int32Array.from([...cells.keys()].sort((a, b) => a - b));
  const buy = new Uint32Array(prices.length), sell = new Uint32Array(prices.length), undirected = new Uint32Array(prices.length);
  let buyTotal = 0, sellTotal = 0, undirectedTotal = 0, poc = prices[0]!, pocVol = -1;
  prices.forEach((price, i) => {
    const c = cells.get(price)!;
    buy[i] = c.buy; sell[i] = c.sell; buyTotal += c.buy; sellTotal += c.sell;
    undirected[i] = c.undirected ?? 0; undirectedTotal += undirected[i]!;
    if (c.buy + c.sell + undirected[i]! >= pocVol) { pocVol = c.buy + c.sell + undirected[i]!; poc = price; }
  });
  return { contract, startSec, endSec: startSec + tf, open: parts[0]!.open, close: parts.at(-1)!.close, high, low,
    volume: buyTotal + sellTotal + undirectedTotal, delta: buyTotal - sellTotal, buyTotal, sellTotal, poc, count, prices, buy, sell,
    ...(undirectedTotal ? { undirected, undirectedTotal } : {}) };
}

interface PendingRange { from: number; to: number; rows: FpTrade[]; live: FpTrade[]; }

/**
 * Incremental footprint aggregation over the shared seconds x tick-price domain.
 * One generation at a time: seq identities are never trusted across server restarts.
 */
export class FootprintStore {
  generation: string | null = null;
  private secs = new Map<number, Sec>();
  private pending = new Map<number, PendingRange>();
  private barCache = new Map<number, BarGroup>();
  private tfValue: DisplayTimeframe = 5;
  coverage: Range[] = [];
  noData: Range[] = [];
  gaps: Gap[] = [];
  evicted: Range[] = [];
  /** Closed live-stream segments; liveOpenSec is the start of the current one. */
  liveSegments: Range[] = [];
  liveOpenSec: number | null = null;
  minSec = -Infinity;
  revision = 0;
  tradeCount = 0;
  evictions = 0;
  barBuilds = 0;
  private lastTrade: FpTrade | null = null;

  get timeframe(): DisplayTimeframe { return this.tfValue; }
  get secondCount(): number { return this.secs.size; }
  get cachedBars(): number { return this.barCache.size; }
  get latest(): FpTrade | null { return this.lastTrade; }

  setTimeframe(tf: DisplayTimeframe): void {
    if (tf === this.tfValue) return;
    this.tfValue = tf; this.barCache.clear(); this.revision++;
  }

  /** New generation discards everything; same generation (reconnect) keeps committed data. */
  hello(generation: string, serverSec: number, live = true): void {
    if (generation !== this.generation) this.reset(generation);
    this.pending.clear();
    this.liveOpenSec = live ? serverSec + 1 : null; // replay data is cursor-bounded and range-read from storage
    this.revision++;
  }
  disconnect(atSec: number): void {
    if (this.liveOpenSec !== null && atSec > this.liveOpenSec) this.liveSegments = mergeRanges([...this.liveSegments, [this.liveOpenSec, atSec]]);
    this.liveOpenSec = null; this.pending.clear(); this.revision++;
  }
  reset(generation: string | null = null): void {
    this.generation = generation;
    this.secs.clear(); this.pending.clear(); this.barCache.clear();
    this.coverage = []; this.noData = []; this.gaps = []; this.evicted = []; this.liveSegments = [];
    this.liveOpenSec = null; this.tradeCount = 0; this.lastTrade = null; this.revision++;
  }

  appendLive(trades: readonly FpTrade[]): void {
    for (const t of trades) {
      for (const [reqId, p] of this.pending) {
        const s = secOf(t.tsUs);
        if (s >= p.from && s < p.to) {
          if (p.rows.length + p.live.length >= MAX_TRADES) this.abortRange(reqId, "footprint_range_capacity");
          else p.live.push(t);
        }
      }
      this.add(t, true);
      if (!this.lastTrade || t.seq >= this.lastTrade.seq) this.lastTrade = t;
    }
    this.enforceBudget();
  }

  beginRange(reqId: number, from: number, to: number): void {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to || to - from > MAX_REQUEST_SEC) throw new Error("invalid_range");
    this.pending.set(reqId, { from, to, rows: [], live: [] });
    this.revision++;
  }
  appendRange(reqId: number, trades: readonly FpTrade[]): void {
    const p = this.pending.get(reqId);
    if (!p) throw new Error("unknown_range");
    if (p.rows.length + p.live.length + trades.length > MAX_TRADES) throw new Error("footprint_range_capacity");
    for (const t of trades) {
      const s = secOf(t.tsUs);
      if (s < p.from || s >= p.to) throw new Error("trade_outside_range");
      p.rows.push(t);
    }
  }
  abortRange(reqId: number, failure?: string): void {
    const p = this.pending.get(reqId);
    this.pending.delete(reqId);
    if (p && failure) this.addGaps(p.from, p.to, [{ startSec: p.from, endSec: p.to, reason: failure }]);
    this.revision++;
  }
  pendingRanges(): Range[] { return [...this.pending.values()].map(p => [p.from, p.to]); }

  /** Replaces the seconds of the range: history rows + live-stream trades, deduplicated by delivery identity. */
  commitRange(reqId: number, info: { coverage: Range[]; gaps: Gap[]; noData: Range[] }): void {
    const p = this.pending.get(reqId);
    if (!p) throw new Error("unknown_range");
    this.pending.delete(reqId);
    const keep: FpTrade[] = [];
    for (const [s, sec] of this.secs) {
      if (s < p.from || s >= p.to) continue;
      for (const r of sec.trades) if (r.viaLive) keep.push(r);
      this.tradeCount -= sec.trades.length;
      this.secs.delete(s);
      this.invalidate(s);
    }
    // Snapshot rows already carry the stored input order. A stored seq may be
    // from an earlier server lifetime; do NOT sort it against current live seq.
    const rows = [...p.rows.map(t => ({ t, live: false })), ...keep.map(t => ({ t, live: true })), ...p.live.map(t => ({ t, live: true }))];
    for (const { t, live } of rows) this.add(t, live);
    for (let s = p.from; s < p.to; s++) this.invalidate(s);
    const cov = clipRanges(info.coverage, p.from, p.to), nd = clipRanges(info.noData, p.from, p.to);
    this.coverage = mergeRanges([...subtractRanges(this.coverage, [[p.from, p.to]]), ...cov]);
    this.noData = mergeRanges([...subtractRanges(this.noData, [[p.from, p.to]]), ...nd]);
    this.evicted = subtractRanges(this.evicted, [[p.from, p.to]]);
    const gaps = info.gaps.map(g => ({ ...g, startSec: Math.max(g.startSec, p.from), endSec: Math.min(g.endSec, p.to) })).filter(g => g.startSec < g.endSec);
    // Requested seconds neither recorded, empty nor named as a gap are still unknown, not zero.
    for (const [a, b] of subtractRanges([[p.from, p.to]], [...cov, ...nd, ...gaps.map((g): Range => [g.startSec, g.endSec])])) {
      gaps.push({ startSec: a, endSec: b, reason: "unreported" });
    }
    this.addGaps(p.from, p.to, gaps);
    this.revision++;
    this.enforceBudget();
  }

  /** Explicit retry: forget failures/evictions so the planner asks again. */
  clearFailures(from: number, to: number): void {
    this.gaps = this.gaps.flatMap(g => subtractRanges([[g.startSec, g.endSec]], [[from, to]]).map(([a, b]) => ({ ...g, startSec: a, endSec: b })));
    this.evicted = subtractRanges(this.evicted, [[from, to]]);
    this.revision++;
  }

  retain(nowSec: number): void {
    const min = nowSec - RETAIN_SEC;
    if (min <= this.minSec) return;
    this.minSec = min;
    for (const [s, sec] of this.secs) if (s < min) { this.tradeCount -= sec.trades.length; this.secs.delete(s); this.invalidate(s); }
    const clip = (r: Range[]) => clipRanges(r, min, Infinity);
    this.coverage = clip(this.coverage); this.noData = clip(this.noData); this.evicted = clip(this.evicted); this.liveSegments = clip(this.liveSegments);
    this.gaps = this.gaps.filter(g => g.endSec > min).map(g => ({ ...g, startSec: Math.max(g.startSec, min) }));
  }

  /** Requested-but-not-yet-known seconds inside [from,to) (excluding current second). */
  missing(from: number, to: number, nowSec: number, stale: readonly Range[] = [], queued: readonly Range[] = []): Range[] {
    const lo = Math.max(from, nowSec - RETAIN_SEC, this.minSec), hi = Math.min(to, nowSec);
    if (lo >= hi) return [];
    const known = subtractRanges([...this.coverage, ...this.noData], stale);
    const live = this.liveOpenSec !== null ? [[this.liveOpenSec, Infinity] as Range] : [];
    return splitRanges(subtractRanges([[lo, hi]], [...known, ...this.liveSegments, ...live, ...this.evicted,
      ...this.gaps.map((g): Range => [g.startSec, g.endSec]), ...this.pendingRanges(), ...queued]));
  }

  stateOf(from: number, to: number, nowSec: number): SecondState {
    if (from > nowSec) return "future";
    const end = Math.min(to, nowSec + 1);
    if (overlaps(this.pendingRanges(), from, end)) return "loading";
    if (overlaps(this.evicted, from, end)) return "overflow";
    if (this.gaps.some(g => g.startSec < end && g.endSec > from)) return "gap";
    const live = this.liveOpenSec !== null ? [[this.liveOpenSec, Infinity] as Range] : [];
    const known = [...this.coverage, ...this.noData, ...this.liveSegments, ...live];
    if (!covers(known, Math.max(from, this.minSec), end)) return "unloaded";
    if (this.liveOpenSec !== null && end > this.liveOpenSec && !covers([...this.coverage, ...this.noData], Math.max(from, this.minSec), end)) return "live";
    return covers(this.noData, from, end) ? "empty" : "recorded";
  }
  gapReasons(from: number, to: number): string[] {
    return [...new Set(this.gaps.filter(g => g.startSec < to && g.endSec > from).map(g => g.reason))];
  }

  bars(fromSec: number, toSec: number): { startSec: number; group: BarGroup }[] {
    const tf = this.tfValue, out: { startSec: number; group: BarGroup }[] = [];
    for (let start = Math.floor(fromSec / tf) * tf; start < toSec; start += tf) {
      let group = this.barCache.get(start);
      if (!group) { group = this.computeGroup(start); this.barCache.set(start, group); }
      out.push({ startSec: start, group });
    }
    // Bounded: only bars for the browse window (max 7200/5 = 1440 groups) are cached.
    if (this.barCache.size > 1_600) for (const k of this.barCache.keys()) if (k < this.minSec || k < fromSec - 3_600) this.barCache.delete(k);
    return out;
  }
  contracts(): string[] {
    const set = new Set<string>();
    for (const sec of this.secs.values()) for (const k of sec.series.keys()) set.add(k);
    return [...set].sort();
  }
  priceExtent(fromSec: number, toSec: number, contract: string): [number, number] | null {
    let lo = Infinity, hi = -Infinity;
    for (const { group } of this.bars(fromSec, toSec)) {
      const b = group.get(contract);
      if (b) { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); }
    }
    return lo === Infinity ? null : [lo, hi];
  }

  private computeGroup(start: number): BarGroup {
    this.barBuilds++;
    const parts = new Map<string, Series[]>();
    for (let s = start; s < start + this.tfValue; s++) {
      const sec = this.secs.get(s);
      if (!sec) continue;
      for (const [k, series] of sec.series) { const list = parts.get(k) ?? []; list.push(series); parts.set(k, list); }
    }
    const group: BarGroup = new Map();
    for (const [k, list] of parts) { const b = buildBar(k, start, this.tfValue, list); if (b) group.set(k, b); }
    return group;
  }
  private invalidate(s: number): void { this.barCache.delete(Math.floor(s / this.tfValue) * this.tfValue); }
  private addGaps(from: number, to: number, gaps: Gap[]): void {
    const kept = this.gaps.flatMap(g => subtractRanges([[g.startSec, g.endSec]], [[from, to]]).map(([a, b]) => ({ ...g, startSec: a, endSec: b })));
    this.gaps = [...kept, ...gaps].sort((a, b) => a.startSec - b.startSec);
  }
  private add(t: FpTrade, viaLive: boolean): void {
    const s = secOf(t.tsUs);
    if (s < this.minSec) return;
    let sec = this.secs.get(s);
    if (!sec) { sec = { trades: [], ids: new Set(), series: new Map() }; this.secs.set(s, sec); }
    const id = identity(t);
    if (sec.ids.has(id)) return; // same delivery seen twice (history + live): count once
    sec.ids.add(id);
    sec.trades.push({ ...t, viaLive });
    const k = contractKey(t);
    let series = sec.series.get(k);
    if (!series) { series = { cells: new Map(), open: t.price, close: t.price, high: t.price, low: t.price, count: 0 }; sec.series.set(k, series); }
    const cell = series.cells.get(t.price) ?? { buy: 0, sell: 0 };
    if (t.side === "unknown") cell.undirected = (cell.undirected ?? 0) + t.size;
    else cell[t.side] += t.size;
    series.cells.set(t.price, cell);
    series.close = t.price; series.high = Math.max(series.high, t.price); series.low = Math.min(series.low, t.price); series.count++;
    this.tradeCount++; this.invalidate(s); this.revision++;
  }
  private enforceBudget(): void {
    if (this.tradeCount <= MAX_TRADES) return;
    const target = Math.floor(MAX_TRADES * EVICT_TO), order = [...this.secs.keys()].sort((a, b) => a - b);
    const removed: Range[] = [];
    for (const s of order) {
      if (this.tradeCount <= target) break;
      this.tradeCount -= this.secs.get(s)!.trades.length;
      this.secs.delete(s); this.invalidate(s); removed.push([s, s + 1]);
    }
    this.evictions++;
    // Evicted seconds are explicitly incomplete, never silently zero or "recorded".
    this.evicted = mergeRanges([...this.evicted, ...removed]);
    this.coverage = subtractRanges(this.coverage, this.evicted);
    this.noData = subtractRanges(this.noData, this.evicted);
    this.liveSegments = subtractRanges(this.liveSegments, this.evicted);
    if (this.liveOpenSec !== null && removed.length) {
      const last = removed.at(-1)![1];
      if (last > this.liveOpenSec) {
        this.liveSegments = mergeRanges([...this.liveSegments]);
        this.liveOpenSec = last;
      }
    }
    this.revision++;
  }
}
