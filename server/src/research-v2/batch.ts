import { SampleBuilder, type Bar, type PreparedState } from "./engine.ts";
import { coverageIndex, type Anchor, type Board, type Calculation, type MarketInput, type Source, type Tick } from "./model.ts";
import { sessionStartSec } from "../vp/state.ts";
import { columnFileRange } from "../store/records.ts";
import { Snapshot } from "./snapshot.ts";
import { orderedHour } from "./ordered.ts";

export const BATCH_LIMITS = { anchors: 100_000, seconds: 10_000, priceCells: 250_000, profilePrices: 100_000, boardLevels: 250_000, hours: 8784 };
export type Result = ReturnType<SampleBuilder["finish"]>;
interface Second {
  us: number; bar: Bar; last: Tick; prices: Map<number, number>;
  delta: number; highCvd: number; lowCvd: number; high: number; low: number;
  validHigh: number; validLow: number;
}
/** Bounded rolling sufficient statistics. No raw tape is retained after sorting a source hour. */
export class BatchCalculator {
  private slots: Second[] = []; private head = 0; private past = 0; private current: Second | null = null;
  private index = 0; private session = NaN; private profile = new Map<number, number>();
  private high = -Infinity; private low = Infinity; private mixed = false;
  private reference: Tick | null = null; private seed: Tick | null = null;
  private boards = new Map<number, Board>(); private boardKeys: Set<number>;
  private cells = 0; private boardCells = 0; private previousUs = -Infinity;
  readonly metrics = { decodedRecords: 0, maxSeconds: 0, maxPriceCells: 0, maxProfilePrices: 0,
    unknownBySession: {} as Record<string, number> };
  readonly input: MarketInput;
  readonly source: Pick<Source, "symbol" | "contract">; readonly anchors: number[]; readonly config: Calculation;
  readonly emit: (asOfUs: number, result: Result) => Promise<void>; readonly signal: AbortSignal;
  constructor(source: Pick<Source, "symbol" | "contract">, anchors: number[], config: Calculation,
    input: MarketInput, emit: (asOfUs: number, result: Result) => Promise<void>, signal: AbortSignal) {
    this.source = source; this.anchors = anchors; this.config = config; this.emit = emit; this.signal = signal;
    if (config.mode !== "event_time_research" || !anchors.length || anchors.length > BATCH_LIMITS.anchors
      || anchors.some((a, i) => a % 1e6 || (i > 0 && a <= anchors[i - 1]!))
      || config.lookbackSeconds + Math.max(...config.horizonsSeconds) + 2 > BATCH_LIMITS.seconds)
      throw Error("v2_batch_requires_bounded_sorted_integer_event_time_anchors");
    this.input = { ...input, index: { ticks: coverageIndex(input.ticks), books: coverageIndex(input.books) } };
    this.boardKeys = new Set(anchors.flatMap(a => [a / 1e6 - 1, a / 1e6 - 61]));
    this.selectSession();
  }
  private selectSession() {
    const a = this.anchors[this.index]; if (a === undefined) return;
    const session = sessionStartSec(a / 1e6) * 1e6;
    if (session !== this.session) { this.session = session; this.profile.clear(); this.high = -Infinity; this.low = Infinity; this.mixed = false; }
  }
  acceptBoard(b: Board) {
    if (!this.boardKeys.has(b.column.tsSec)) return;
    const old = this.boards.get(b.column.tsSec);
    this.boardCells += b.column.bids.length + b.column.asks.length - (old ? old.column.bids.length + old.column.asks.length : 0);
    if (this.boardCells > BATCH_LIMITS.boardLevels) throw Error("v2_batch_board_budget");
    this.boards.set(b.column.tsSec, b);
  }
  accept(t: Tick) {
    for (const n of [t.tsUs, t.recvUs, t.seq, t.price, t.size]) if (!Number.isSafeInteger(n)) throw Error("invalid_trade_integer");
    if (t.size <= 0 || t.price <= 0 || !["buy", "sell", "unknown"].includes(t.side)) throw Error("invalid_trade");
    if (t.tsUs < this.previousUs) throw Error("v2_batch_requires_ordered_input");
    this.previousUs = t.tsUs; this.metrics.decodedRecords++;
    if (t.side === "unknown" && t.contract === this.source.contract) {
      const key = String(sessionStartSec(t.tsUs / 1e6) * 1e6);
      const next = (this.metrics.unknownBySession[key] ?? 0) + t.size;
      if (!Number.isSafeInteger(next)) throw Error("quantity_overflow");
      this.metrics.unknownBySession[key] = next;
    }
    if (this.index === this.anchors.length) return;
    const us = Math.floor(t.tsUs / 1e6) * 1e6;
    if (this.current && this.current.us !== us) throw Error("watermark_required_before_next_second");
    let s = this.current;
    if (!s) this.current = s = { us, last: t, prices: new Map(), delta: 0, highCvd: 0, lowCvd: 0, high: -Infinity, low: Infinity,
      validHigh: -Infinity, validLow: Infinity,
      bar: { open: t.price, close: t.price, high: t.price, low: t.price, firstUs: t.tsUs, lastUs: t.tsUs,
        firstSeq: t.seq, lastSeq: t.seq, buy: 0, sell: 0, unknown: 0, count: 0, mixed: false } };
    const b = s.bar;
    b.count++; b[t.side] += t.size; b.mixed ||= t.contract !== this.source.contract;
    if (!Number.isSafeInteger(b.buy + b.sell + b.unknown)) throw Error("quantity_overflow");
    b.high = Math.max(b.high, t.price); b.low = Math.min(b.low, t.price);
    if (t.tsUs < b.firstUs || t.tsUs === b.firstUs && t.seq < b.firstSeq) { b.open = t.price; b.firstUs = t.tsUs; b.firstSeq = t.seq; }
    if (t.tsUs > b.lastUs || t.tsUs === b.lastUs && t.seq >= b.lastSeq) { b.close = t.price; b.lastUs = t.tsUs; b.lastSeq = t.seq; s.last = t; }
    s.delta += t.side === "buy" ? t.size : t.side === "sell" ? -t.size : 0;
    if (t.price > s.high) { s.high = t.price; s.highCvd = s.delta; }
    if (t.price < s.low) { s.low = t.price; s.lowCvd = s.delta; }
    if (t.contract === this.source.contract) {
      if (!s.prices.has(t.price)) this.cells++;
      s.prices.set(t.price, (s.prices.get(t.price) ?? 0) + t.size);
      s.validHigh = Math.max(s.validHigh, t.price); s.validLow = Math.min(s.validLow, t.price);
    }
    this.metrics.maxPriceCells = Math.max(this.metrics.maxPriceCells, this.cells);
    if (this.cells > BATCH_LIMITS.priceCells) throw Error("v2_batch_price_cell_budget");
  }
  private applyPast(watermark: number) {
    const a = this.anchors[this.index]!; const until = Math.min(a, watermark);
    while (this.past < this.slots.length && this.slots[this.past]!.us < until) {
      const s = this.slots[this.past++]!;
      this.reference = s.last;
      if (s.us >= this.session) {
        this.mixed ||= s.bar.mixed; this.high = Math.max(this.high, s.validHigh); this.low = Math.min(this.low, s.validLow);
        for (const [price, qty] of s.prices) {
          const next = (this.profile.get(price) ?? 0) + qty;
          if (!Number.isSafeInteger(next)) throw Error("quantity_overflow");
          this.profile.set(price, next);
        }
        if (this.profile.size > BATCH_LIMITS.profilePrices) throw Error("v2_profile_memory_budget");
        this.metrics.maxProfilePrices = Math.max(this.metrics.maxProfilePrices, this.profile.size);
      }
    }
  }
  private purge() {
    const a = this.anchors[this.index]; if (a === undefined) return;
    const from = a - this.config.lookbackSeconds * 1e6;
    while (this.head < this.past && this.slots[this.head]!.us < from) {
      const s = this.slots[this.head]!; this.seed = s.last; this.cells -= s.prices.size;
      this.slots[this.head++] = null!;
    }
    if (this.head > 1024) { this.slots.splice(0, this.head); this.past -= this.head; this.head = 0; }
    for (const [sec, b] of this.boards) if (sec < a / 1e6 - 61) {
      this.boards.delete(sec); this.boardCells -= b.column.bids.length + b.column.asks.length;
    }
  }
  private result(a: number) {
    const bars = new Map<number, Bar>(), from = a - this.config.lookbackSeconds * 1e6;
    const futures: PreparedState["futures"] = this.config.horizonsSeconds.map(() => ({ last: null, high: -Infinity, low: Infinity, mixed: false }));
    const halves = [{ h: -Infinity, l: Infinity, hc: 0, lc: 0 }, { h: -Infinity, l: Infinity, hc: 0, lc: 0 }];
    let cvd = 0, events = 0;
    for (let i = this.head; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.us < a && s.us >= from) bars.set((s.us - from) / 1e6, s.bar);
      if (s.us >= a - 600e6 && s.us < a) {
        const h = halves[s.us < a - 300e6 ? 0 : 1]!;
        if (s.high > h.h) { h.h = s.high; h.hc = cvd + s.highCvd; }
        if (s.low < h.l) { h.l = s.low; h.lc = cvd + s.lowCvd; }
        cvd += s.delta; events += s.bar.count;
      }
      if (s.us >= a) futures.forEach((f, n) => {
        if (s.us >= a + this.config.horizonsSeconds[n]! * 1e6) return;
        f.last = s.last; f.high = Math.max(f.high, s.high); f.low = Math.min(f.low, s.low); f.mixed ||= s.bar.mixed;
      });
    }
    const [u, v] = halves, bear = v!.h > u!.h && v!.hc <= u!.hc, bull = v!.l < u!.l && v!.lc >= u!.lc;
    const budget = events > this.config.maxDivergenceEvents;
    const divergence = { value: !budget && Number.isFinite(u!.h + v!.h) && !(bear && bull) ? bear ? 1 : bull ? -1 : 0 : null,
      reason: budget ? "event_sort_resource_budget" : "no_trades_or_ambiguous" };
    return SampleBuilder.prepared({ ...this.source, asOfUs: a } as Anchor, this.config, this.input, {
      bars, profile: this.profile, sessionMixed: this.mixed, sessionHigh: this.high, sessionLow: this.low,
      reference: this.reference, preWindow: this.seed, boards: this.boards, futures, eventBudget: budget, divergence,
    }).finish();
  }
  async watermark(us: number) {
    this.signal.throwIfAborted();
    if (this.current && this.current.us + 1e6 <= us) { this.slots.push(this.current); this.current = null; }
    if (this.index === this.anchors.length) return;
    this.applyPast(us); this.purge();
    while (this.index < this.anchors.length && this.anchors[this.index]! + Math.max(...this.config.horizonsSeconds) * 1e6 <= us) {
      const a = this.anchors[this.index]!;
      await this.emit(a, this.result(a)); this.index++; this.selectSession();
      if (this.index < this.anchors.length) { this.applyPast(us); this.purge(); }
    }
    this.metrics.maxSeconds = Math.max(this.metrics.maxSeconds, this.slots.length - this.head + +(this.current !== null));
    if (this.slots.length - this.head > BATCH_LIMITS.seconds) throw Error("v2_batch_second_budget");
  }
}

export async function streamBatch(snapshot: Snapshot, anchors: number[], config: Calculation,
  emit: (a: number, r: Result) => Promise<void>) {
  const first = anchors[0]!, end = anchors.at(-1)! + Math.max(...config.horizonsSeconds) * 1e6;
  let from = Math.min(sessionStartSec(first / 1e6) * 1e6, first - config.lookbackSeconds * 1e6);
  // Same conservative seed boundary as the reference adapter; only indexed continuity.
  const probe = await snapshot.prepare(from, from + 1);
  const coverageFile = snapshot.proofs.find(p => p.path.endsWith("/coverage.json"));
  if (coverageFile) {
    const fs = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const bytes = await fs.readFile(coverageFile.path);
    if (createHash("sha256").update(bytes).digest("hex") !== coverageFile.before) throw Error("v2_coverage_changed_before_seed_search");
    for (const [a, b] of (JSON.parse(bytes.toString()).tick as [number, number][]).sort((a, b) => b[0] - a[0]))
      if (a * 1e6 < from && b * 1e6 >= from) from = a * 1e6;
  }
  void probe;
  if (Math.ceil((end - from) / 3600e6) > BATCH_LIMITS.hours) throw Error("v2_batch_hour_budget");
  const input = await snapshot.prepare(from, end);
  const calculator = new BatchCalculator(snapshot.source, anchors, config, input, emit, snapshot.signal);
  let tradeGzipScans = 0, boardScans = 0;
  for (let hour = Math.floor(from / 3600e6) * 3600; hour * 1e6 < end; hour += 3600) {
    snapshot.signal.throwIfAborted(); const v = await snapshot.hour(hour);
    if (v.book) { boardScans++; for await (const column of columnFileRange(v.book, hour, hour + 3600))
      calculator.acceptBoard({ column, contract: null }); }
    if (v.tick) {
      tradeGzipScans++;
      for await (const tick of orderedHour(v.tick, snapshot.directory, snapshot.signal)) {
        if (tick.tsUs < hour * 1e6 || tick.tsUs >= (hour + 3600) * 1e6) throw Error("v2_input_hour_identity_mismatch");
        await calculator.watermark(Math.floor(tick.tsUs / 1e6) * 1e6); calculator.accept(tick);
      }
    }
    await calculator.watermark((hour + 3600) * 1e6);
  }
  return { tradeGzipScans, boardScans, ...calculator.metrics };
}
