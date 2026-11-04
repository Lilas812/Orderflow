import { createHash } from "node:crypto";
import { INSTRUMENTS } from "../../../lib/market/instruments.ts";
import { sessionStartSec } from "../vp/state.ts";
import { valueArea, sessionClock } from "../labels/features.ts";
import { covered, eligible, knownContract, type Anchor, type Calculation, type MarketInput, type Tick, type Board } from "./model.ts";

export const FORMULAS: Record<string, string> = {
  session: "CT17/01/08/09/14:30/15のv1時間分類、DST対応",
  minutes_from_ct17: "CT17からの実経過分",
  minutes_from_us_open: "CT08:30からの実経過分",
  rv_5m: "300個の1秒区間終値の差の二乗和平方根、ticks。初期価格/coverageなしはnull",
  rv_30m: "同1800個",
  range_30m: "1800秒の実約定high-low、ticks",
  direction_30m: "1800秒の(last-first)/(high-low)、幅0はnull",
  distance_session_high: "reference−CT17以後as_of未満の実約定high、ticks",
  distance_session_low: "reference−同low、ticks",
  distance_poc: "reference−as_of未満のセッションVPのPOC、ticks。N含む、同量高値",
  distance_vah: "reference−同VA70%上端、ticks。隣接多数量、同量上",
  distance_val: "reference−同VA下端、ticks",
  distance_round: "reference−最寄りNQ100point/GC10dollar、ticks。同距離は高値",
  cvd_slope_10m: "600個の秒末CVDのOLS傾き×60、枚/分。Nは加減算しない",
  cvd_divergence: "10分前後半の最初の極値実到達のCVD。高値更新/CVD非更新=1、安値更新/CVD非更新=-1、他0、両成立null",
  absorption_buy_60s: "buy60/(max(0,last60-first60)+1)、枚/tick。取消や真の吸収の確定ではない",
  absorption_sell_60s: "sell60/(max(0,first60-last60)+1)、枚/tick",
  imbalance_1: "直前の確定1秒列の上位1段(bid-ask)/(bid+ask)。限月/coverage/段数不明はnull",
  imbalance_5: "同上位5段", imbalance_10: "同上位10段",
  near_size: "reference±2ticks内の直前列の両側枚数、公表範囲外はnull",
  near_change_60s: "同価格帯の直前列と60秒前列の枚数差",
};
for (const [n, suffix] of [[30, "30s"], [60, "60s"], [300, "5m"]] as const)
  for (const side of ["buy", "sell", "unknown", "total", "delta"])
    FORMULAS[`${side}_${suffix}`] = `${n}秒の${side}枚数。total=B+A+N、delta=B-A。coverage/限月不完全はnull`;
export const X_ALLOWLIST = Object.freeze(Object.keys(FORMULAS));
export const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
interface Bar {
  open: number; high: number; low: number; close: number; firstUs: number; lastUs: number;
  firstSeq: number; lastSeq: number; buy: number; sell: number; unknown: number; count: number; mixed: boolean;
}
export interface HistoryRow {
  from_us: string; to_us: string; coverage_mask: number; contract_mask: number;
  open: number | null; high: number | null; low: number | null; close: number | null;
  buy: number | null; sell: number | null; unknown: number | null; count: number | null;
  carried_close: number | null; carried: number;
}
export class SampleBuilder {
  readonly anchor: Anchor; readonly config: Calculation; readonly input: MarketInput;
  private bars = new Map<number, Bar>();
  private profile = new Map<number, number>();
  private sessionMixed = false;
  private sessionHigh = -Infinity;
  private sessionLow = Infinity;
  private reference: Tick | null = null;
  private referenceMixed = false;
  private events: Tick[] = [];
  private eventBudget = false;
  private boards = new Map<number, Board>();
  private futures: { last: Tick | null; high: number; low: number; mixed: boolean }[];
  readonly startUs: number;
  readonly sessionUs: number;
  audit = { records: 0, past: 0, future: 0, buy: 0, sell: 0, unknown: 0, unknownContract: 0,
    otherContract: 0, unavailablePast: 0, boardRecords: 0, boardIdentityMissing: 0 };
  constructor(anchor: Anchor, config: Calculation, input: MarketInput) {
    if (!knownContract(anchor.contract)) throw Error("v2_requires_explicit_confirmed_contract");
    this.anchor = anchor; this.config = config; this.input = input;
    this.startUs = anchor.asOfUs - config.lookbackSeconds * 1e6;
    this.sessionUs = sessionStartSec(anchor.asOfUs / 1e6) * 1e6;
    this.futures = config.horizonsSeconds.map(() => ({ last: null, high: -Infinity, low: Infinity, mixed: false }));
  }
  accept(t: Tick) {
    for (const n of [t.tsUs, t.recvUs, t.seq, t.price, t.size])
      if (!Number.isSafeInteger(n)) throw Error("invalid_trade_integer");
    if (t.size <= 0 || t.price <= 0 || !["buy", "sell", "unknown"].includes(t.side)) throw Error("invalid_trade");
    const a = this.anchor.asOfUs;
    if (t.tsUs < Math.min(this.startUs, this.sessionUs) || t.tsUs >= a + Math.max(...this.config.horizonsSeconds) * 1e6) return;
    this.audit.records++; this.audit[t.side] += t.size;
    if (!knownContract(t.contract ?? "UNKNOWN")) this.audit.unknownContract++;
    else if (t.contract !== this.anchor.contract) this.audit.otherContract++;
    if (t.tsUs >= a) {
      this.audit.future++;
      this.futures.forEach((f, i) => {
        if (t.tsUs >= a + this.config.horizonsSeconds[i]! * 1e6) return;
        f.mixed ||= t.contract !== this.anchor.contract;
        f.high = Math.max(f.high, t.price); f.low = Math.min(f.low, t.price);
        if (!f.last || t.tsUs > f.last.tsUs || t.tsUs === f.last.tsUs && t.seq >= f.last.seq) f.last = t;
      });
      return;
    }
    this.audit.past++;
    if (!eligible(t.availability, a, this.config.mode)) { this.audit.unavailablePast++; return; }
    if (t.tsUs >= this.sessionUs) {
      this.sessionMixed ||= t.contract !== this.anchor.contract;
      if (t.contract === this.anchor.contract) {
        this.profile.set(t.price, (this.profile.get(t.price) ?? 0) + t.size);
        this.sessionHigh = Math.max(this.sessionHigh, t.price); this.sessionLow = Math.min(this.sessionLow, t.price);
        if (this.profile.size > 100_000) throw Error("v2_profile_memory_budget");
      }
    }
    if (!this.reference || t.tsUs > this.reference.tsUs || t.tsUs === this.reference.tsUs && t.seq >= this.reference.seq) {
      this.reference = t; this.referenceMixed = t.contract !== this.anchor.contract;
    }
    if (t.tsUs < this.startUs) return;
    const i = Math.floor((t.tsUs - this.startUs) / 1e6);
    let b = this.bars.get(i);
    if (!b) this.bars.set(i, b = { open: t.price, high: t.price, low: t.price, close: t.price,
      firstUs: t.tsUs, lastUs: t.tsUs, firstSeq: t.seq, lastSeq: t.seq, buy: 0, sell: 0, unknown: 0, count: 0, mixed: false });
    b.mixed ||= t.contract !== this.anchor.contract;
    b.high = Math.max(b.high, t.price); b.low = Math.min(b.low, t.price); b[t.side] += t.size; b.count++;
    if (!Number.isSafeInteger(b.buy + b.sell + b.unknown)) throw Error("quantity_overflow");
    if (t.tsUs < b.firstUs || t.tsUs === b.firstUs && t.seq < b.firstSeq) { b.firstUs = t.tsUs; b.firstSeq = t.seq; b.open = t.price; }
    if (t.tsUs > b.lastUs || t.tsUs === b.lastUs && t.seq >= b.lastSeq) { b.lastUs = t.tsUs; b.lastSeq = t.seq; b.close = t.price; }
    if (t.tsUs >= a - 600e6) {
      if (this.events.length < this.config.maxDivergenceEvents) this.events.push(t);
      else this.eventBudget = true;
    }
  }
  acceptBoard(b: Board) {
    const sec = b.column.tsSec, a = this.anchor.asOfUs, now = Math.floor(a / 1e6) - 1;
    if (sec < now - 60 || sec > now) return;
    this.audit.boardRecords++;
    if (!b.contract) this.audit.boardIdentityMissing++;
    if (eligible(b.availability, a, this.config.mode)) this.boards.set(sec, b);
  }
  finish() {
    const a = this.anchor.asOfUs, mode = this.config.mode, x: Record<string, string | number | null> =
      Object.fromEntries(X_ALLOWLIST.map(k => [k, null])), reasons: Record<string, string> = {};
    const put = (k: string, v: string | number | null, why: string) => {
      x[k] = typeof v === "number" && !Number.isFinite(v) ? null : v;
      if (x[k] === null) reasons[k] = why;
    };
    const reference = this.reference && !this.referenceMixed
      && covered(this.input.ticks, this.reference.tsUs, a, mode, a) ? this.reference : null;
    const ref = reference?.price ?? null;
    let carried: number | null = null;
    const history: HistoryRow[] = [];
    for (let i = 0; i < this.config.lookbackSeconds; i++) {
      const from = this.startUs + i * 1e6, b = this.bars.get(i);
      const mask = covered(this.input.ticks, from, from + 1e6, mode, a);
      const identity = !b?.mixed, good = mask && identity;
      if (!good) carried = null; else if (b) carried = b.close;
      history.push({ from_us: String(from), to_us: String(from + 1e6), coverage_mask: +mask, contract_mask: +identity,
        open: good && b ? b.open : null, high: good && b ? b.high : null, low: good && b ? b.low : null,
        close: good && b ? b.close : null, buy: good ? b?.buy ?? 0 : null, sell: good ? b?.sell ?? 0 : null,
        unknown: good ? b?.unknown ?? 0 : null, count: good ? b?.count ?? 0 : null,
        carried_close: carried, carried: +(good && !b && carried !== null) });
    }
    const window = (n: number) => history.slice(-n);
    const good = (n: number) => this.config.lookbackSeconds >= n && window(n).every(b => b.coverage_mask && b.contract_mask);
    const generic = mode === "arrival_verified" ? "local_arrival_or_finalization_or_coverage_unverified" : "coverage_or_contract_incomplete";
    const c = sessionClock(a / 1e6);
    put("session", c.session, ""); put("minutes_from_ct17", c.minutesFromSession, ""); put("minutes_from_us_open", c.minutesFromUsOpen, "");
    for (const [n, suffix] of [[30, "30s"], [60, "60s"], [300, "5m"]] as const) {
      const sums = { buy: 0, sell: 0, unknown: 0 };
      for (const b of window(n)) for (const k of ["buy", "sell", "unknown"] as const) sums[k] += b[k] ?? 0;
      const sums2 = { ...sums, total: sums.buy + sums.sell + sums.unknown, delta: sums.buy - sums.sell };
      for (const [k, v] of Object.entries(sums2)) {
        if (!Number.isSafeInteger(v)) throw Error("quantity_overflow");
        put(`${k}_${suffix}`, good(n) ? v : null, generic);
      }
    }
    for (const [n, name] of [[300, "rv_5m"], [1800, "rv_30m"]] as const) {
      const rows = window(n); let rv = 0;
      for (let i = 1; i < rows.length; i++) rv += ((rows[i]!.carried_close ?? NaN) - (rows[i - 1]!.carried_close ?? NaN)) ** 2;
      put(name, good(n) && rows.every(r => r.carried_close !== null) ? Math.sqrt(rv) : null, generic + "_or_initial_price_unknown");
    }
    const rows30 = window(1800).filter(b => b.count && b.open !== null);
    const high = Math.max(...rows30.map(b => b.high!)), low = Math.min(...rows30.map(b => b.low!));
    put("range_30m", good(1800) && rows30.length ? high - low : null, generic);
    put("direction_30m", good(1800) && high > low ? (rows30.at(-1)!.close! - rows30[0]!.open!) / (high - low) : null, generic + "_or_zero_range");
    const sg = !this.sessionMixed && covered(this.input.ticks, this.sessionUs, a, mode, a);
    put("distance_session_high", sg && ref !== null && Number.isFinite(this.sessionHigh) ? ref - this.sessionHigh : null, generic + "_or_no_reference");
    put("distance_session_low", sg && ref !== null && Number.isFinite(this.sessionLow) ? ref - this.sessionLow : null, generic + "_or_no_reference");
    const va = sg ? valueArea(this.profile) : null;
    for (const k of ["poc", "vah", "val"] as const)
      put(`distance_${k}`, va && ref !== null ? ref - va[k] : null, generic + "_or_empty_profile_reference");
    const roundTicks = (this.anchor.symbol === "NQ" ? 100 : 10) * INSTRUMENTS[this.anchor.symbol].ticksPerPoint;
    put("distance_round", ref !== null ? ref - Math.round(ref / roundTicks) * roundTicks : null, "reference_unavailable");
    const r60 = window(60).filter(b => b.open !== null), first = r60[0]?.open, last = r60.at(-1)?.close;
    for (const side of ["buy", "sell"] as const)
      put(`absorption_${side}_60s`, good(60) && first != null && last != null
        ? (x[`${side}_60s`] as number) / (Math.max(0, (last - first) * (side === "buy" ? 1 : -1)) + 1) : null, generic + "_or_no_trade");
    if (good(600)) {
      const cvds: number[] = []; let cvd = 0;
      for (const b of window(600)) { cvd += b.buy! - b.sell!; cvds.push(cvd); }
      let numerator = 0, denominator = 0;
      cvds.forEach((v, i) => { numerator += (i - 299.5) * v; denominator += (i - 299.5) ** 2; });
      put("cvd_slope_10m", numerator / denominator * 60, "");
      if (!this.eventBudget) {
        const halves = [{ h: -Infinity, l: Infinity, hc: 0, lc: 0 }, { h: -Infinity, l: Infinity, hc: 0, lc: 0 }];
        cvd = 0;
        for (const t of this.events.sort((u, v) => u.tsUs - v.tsUs || u.seq - v.seq)) {
          cvd += t.side === "buy" ? t.size : t.side === "sell" ? -t.size : 0;
          const h = halves[t.tsUs < a - 300e6 ? 0 : 1]!;
          if (t.price > h.h) { h.h = t.price; h.hc = cvd; }
          if (t.price < h.l) { h.l = t.price; h.lc = cvd; }
        }
        const [u, v] = halves as [typeof halves[number], typeof halves[number]];
        const bear = v.h > u.h && v.hc <= u.hc, bull = v.l < u.l && v.lc >= u.lc;
        put("cvd_divergence", Number.isFinite(u.h + v.h) && !(bear && bull) ? bear ? 1 : bull ? -1 : 0 : null, "no_trades_or_ambiguous");
      }
    }
    if (x.cvd_slope_10m === null) reasons.cvd_slope_10m = generic;
    if (x.cvd_divergence === null) reasons.cvd_divergence ??= this.eventBudget ? "event_sort_resource_budget" : generic;
    const nowSec = Math.floor(a / 1e6) - 1;
    const board = (s: number) => {
      const b = this.boards.get(s);
      return b && b.contract === this.anchor.contract && covered(this.input.books, s * 1e6, (s + 1) * 1e6, mode, a) ? b.column : null;
    };
    const now = board(nowSec), before = board(nowSec - 60);
    for (const n of [1, 5, 10]) {
      const sum = (side: "bids" | "asks") => now!.bids.length >= n && now!.asks.length >= n
        ? now![side].slice(0, n).reduce((s, b) => s + b.size, 0) : NaN;
      const b = now ? sum("bids") : NaN, q = now ? sum("asks") : NaN;
      put(`imbalance_${n}`, b + q > 0 ? (b - q) / (b + q) : null, "book_coverage_contract_depth_or_availability_unverified");
    }
    const near = (b: typeof now) => b && ref !== null && b.bids.length && b.asks.length
      && ref - 2 >= Math.min(...b.bids.map(v => v.price)) && ref + 2 <= Math.max(...b.asks.map(v => v.price))
      ? [...b.bids, ...b.asks].filter(v => Math.abs(v.price - ref) <= 2).reduce((s, v) => s + v.size, 0) : null;
    const n = near(now), p = near(before);
    put("near_size", n, "book_reference_depth_identity_or_availability_unverified");
    put("near_change_60s", n !== null && p !== null ? n - p : null, "both_book_snapshots_reference_or_depth_unverified");
    const targets = this.futures.map((f, i) => {
      const end = a + this.config.horizonsSeconds[i]! * 1e6;
      const ok = reference && !f.mixed && covered(this.input.ticks, a, end, "event_time_research", end);
      return { horizon_seconds: this.config.horizonsSeconds[i]!, from_us: String(a), to_us: String(end),
        observation_end_us: ok ? String(end) : null, last_trade_us: ok && f.last ? String(f.last.tsUs) : null,
        endpoint_change_ticks: ok ? (f.last?.price ?? ref!) - ref! : null,
        upward_excursion_ticks: ok ? Math.max(0, (Number.isFinite(f.high) ? f.high : ref!) - ref!) : null,
        downward_excursion_ticks: ok ? Math.max(0, ref! - (Number.isFinite(f.low) ? f.low : ref!)) : null,
        missing_reason: ok ? null : !reference ? "reference_unavailable" : f.mixed ? "future_contract_changed_or_unknown" : "future_coverage_incomplete",
        availability_basis: "event_time_research" };
    });
    for (const k of X_ALLOWLIST) if (x[k] === null) reasons[k] ??= generic;
    return { reference_price_ticks: ref, reference_price_ts: reference ? String(reference.tsUs) : null,
      reference_age_us: reference ? String(a - reference.tsUs) : null,
      reference_reason: reference ? null : this.referenceMixed ? "latest_trade_contract_unverified" : "no_contiguous_known_reference",
      x, history, targets, reasons, audit: this.audit,
      feature_start_us: String(this.startUs), session_start_us: String(this.sessionUs),
      target_end_us: String(a + Math.max(...this.config.horizonsSeconds) * 1e6) };
  }
}
