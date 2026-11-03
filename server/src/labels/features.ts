import type { Trade } from "../types.ts";
import type { Column } from "../aggregate/columns.ts";
import type { TurningLabel } from "../../../lib/market/labels.ts";
import { sessionStartSec } from "../vp/state.ts";

const ct = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
export function clock(second: number) {
  const p = Object.fromEntries(ct.formatToParts(new Date(second * 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: +p.hour * 60 + +p.minute };
}
export function nextSession(start: number) { return sessionStartSec(start + 36 * 3600); }
const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short" });
export function precedingSession(start: number) {
  let before = sessionStartSec(start - 1);
  while (["Fri", "Sat"].includes(weekday.format(new Date(before * 1000)))) before = sessionStartSec(before - 1);
  return before;
}
export function sessionClock(second: number) {
  const start = sessionStartSec(second), m = clock(second).minute;
  // Search calendar wall time, not a fixed UTC offset across a DST transition.
  let open = start;
  for (let t = start; t < nextSession(start); t += 1800) if (clock(t).minute === 510) { open = t; break; }
  return { session: m >= 1020 || m < 60 ? "asia" : m < 480 ? "europe" : m < 540 ? "us_open"
    : m < 870 ? "us_day" : m < 900 ? "us_close" : "other",
  minutesFromSession: (second - start) / 60, minutesFromUsOpen: (second - open) / 60 };
}

export interface Second {
  o: number; h: number; l: number; c: number; first: number; last: number;
  firstSeq: number; lastSeq: number; count: number; buy: number; sell: number; unknown: number;
  max: number; bp: number[]; sp: number[]; contract: string;
}
export class DayData {
  start: number; end: number; session: number;
  frames: (Second | undefined)[];
  known: Uint8Array;
  closes: Float64Array;
  cvd: Float64Array;
  private knownPrefix: Uint32Array;
  private rvPrefix: Float64Array;
  private rvKnown: Uint32Array;
  private changes: Uint32Array;
  private nextTrade: Int32Array;
  private previousTrade: Int32Array;
  constructor(session: number) {
    this.session = session; this.start = session - 1801; this.end = nextSession(session) + 901;
    const n = this.end - this.start;
    this.frames = new Array(n); this.known = new Uint8Array(n);
    this.closes = new Float64Array(n).fill(NaN); this.cvd = new Float64Array(n + 1);
    this.knownPrefix = new Uint32Array(n + 1); this.rvPrefix = new Float64Array(n + 1);
    this.rvKnown = new Uint32Array(n + 1);
    this.changes = new Uint32Array(n + 1);
    this.nextTrade = new Int32Array(n).fill(-1); this.previousTrade = new Int32Array(n).fill(-1);
  }
  cover(a: number, b: number) {
    if (b <= a || b <= this.start || a >= this.end) return;
    this.known.fill(1, Math.max(0, a - this.start), Math.min(this.known.length, b - this.start));
  }
  add(t: Trade) {
    const i = Math.floor(t.tsUs / 1e6) - this.start;
    if (i < 0 || i >= this.frames.length) return;
    if (!Number.isSafeInteger(t.price) || !Number.isSafeInteger(t.size) || t.size <= 0
      || !Number.isSafeInteger(t.tsUs) || !["buy", "sell", "unknown"].includes(t.side)) throw Error("invalid_saved_trade");
    const identity = t.contract ?? "UNKNOWN";
    let f = this.frames[i];
    if (!f) this.frames[i] = f = { o: t.price, h: t.price, l: t.price, c: t.price, first: t.tsUs, last: t.tsUs,
      firstSeq: t.seq, lastSeq: t.seq, count: 0, buy: 0, sell: 0, unknown: 0, max: 0, bp: [], sp: [], contract: identity };
    if (identity !== f.contract) f.contract = "MIXED";
    if (t.tsUs < f.first || t.tsUs === f.first && t.seq < f.firstSeq) {
      f.first = t.tsUs; f.firstSeq = t.seq; f.o = t.price;
    }
    if (t.tsUs > f.last || t.tsUs === f.last && t.seq >= f.lastSeq) {
      f.last = t.tsUs; f.lastSeq = t.seq; f.c = t.price;
    }
    f.h = Math.max(f.h, t.price); f.l = Math.min(f.l, t.price); f.count++; f[t.side] += t.size;
    if (!Number.isSafeInteger(f.buy + f.sell + f.unknown)) throw Error("quantity_overflow");
    f.max = Math.max(f.max, t.size);
    const prices = t.side === "buy" ? f.bp : t.side === "sell" ? f.sp : null;
    if (prices && prices.length < 3 && !prices.includes(t.price)) prices.push(t.price);
  }
  finish() {
    let close = NaN;
    let previous = -1, changes = 0;
    for (let i = 0; i < this.frames.length; i++) {
      if (this.frames[i]) {
        if (this.frames[i]!.contract === "MIXED" || previous >= 0
          && this.frames[previous]!.contract !== this.frames[i]!.contract) changes++;
        previous = i;
      }
      this.previousTrade[i] = previous; this.changes[i + 1] = changes;
      if (!this.known[i]) close = NaN;
      else if (this.frames[i]) close = this.frames[i]!.c;
      this.closes[i] = close;
      this.knownPrefix[i + 1] = this.knownPrefix[i]! + this.known[i]!;
      this.cvd[i + 1] = this.cvd[i]! + (this.frames[i]?.buy ?? 0) - (this.frames[i]?.sell ?? 0);
      if (!Number.isSafeInteger(this.cvd[i + 1])) throw Error("quantity_overflow");
      const d = i > 0 ? close - this.closes[i - 1]! : NaN;
      this.rvPrefix[i + 1] = this.rvPrefix[i]! + (Number.isFinite(d) ? d * d : 0);
      this.rvKnown[i + 1] = this.rvKnown[i]! + Number(Number.isFinite(d));
    }
    let next = -1;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i]) next = i;
      this.nextTrade[i] = next;
    }
  }
  identity(a: number, b: number) {
    if (a < this.start || b > this.end || b <= a) return "MIXED";
    const first = this.nextTrade[a - this.start]!, last = this.previousTrade[b - 1 - this.start]!;
    if (first < 0 || last < first) return "UNKNOWN";
    return this.frames[first]!.contract === "MIXED"
      || this.changes[last + 1]! !== this.changes[first + 1]! ? "MIXED" : this.frames[first]!.contract;
  }
  complete(a: number, b: number) {
    const i = a - this.start, j = b - this.start;
    return i >= 0 && j <= this.frames.length && j >= i
      && this.knownPrefix[j]! - this.knownPrefix[i]! === j - i;
  }
  frame(t: number) { return this.frames[t - this.start]; }
  close(t: number) { return this.closes[t - this.start]; }
  rv(a: number, b: number): number | null {
    if (!this.complete(a, b)) return null;
    const i = a + 1 - this.start, j = b - this.start;
    return this.rvKnown[j]! - this.rvKnown[i]! === j - i
      ? Math.sqrt(Math.max(0, this.rvPrefix[j]! - this.rvPrefix[i]!)) : null;
  }
  range(a: number, b: number) {
    let high = -Infinity, low = Infinity;
    for (let t = a; t < b; t++) {
      const f = this.frame(t);
      if (f) { high = Math.max(high, f.h); low = Math.min(low, f.l); }
    }
    return Number.isFinite(high + low) ? { high, low } : null;
  }
}

export const FEATURES: Record<string, string> = {
  session: "CT17–01 Asia /01–08 Europe /08–09 US open /09–14:30 US day /14:30–15 US close /other",
  minutes_from_ct17: "実経過分。America/Chicago17:00起点、DST対応",
  minutes_from_us_open: "CT08:30（米国現物寄り）からの実経過分",
  rv_5m: "過去300秒内の1秒終値変化の二乗和の平方根、ticks",
  rv_30m: "過去1800秒内の1秒終値変化の二乗和の平方根、ticks",
  range_30m: "過去1800秒の約定高値−安値、ticks",
  direction_30m: "過去1800秒の(最終価格−最初の約定価格)/(高値−安値)、無単位",
  distance_session_high: "マーク価格−当セッション既知高値、ticks。CT17から完全な区間のみ",
  distance_session_low: "マーク価格−当セッション既知安値、ticks。CT17から完全な区間のみ",
  distance_previous_high: "マーク価格−直前の実在セッション高値、ticks。同限月の完全データのみ",
  distance_previous_low: "マーク価格−直前の実在セッション安値、ticks。同限月の完全データのみ",
  distance_poc: "マーク価格−セッションPOC、ticks。N含む数量。同量なら高価格",
  distance_vah: "マーク価格−70%VAH、ticks。上下隣接価格の大きい側、同量なら上",
  distance_val: "マーク価格−70%VAL、ticks",
  distance_round: "マーク価格−最寄りNQ100pt/GC10ドル、ticks。同距離は高い価格",
  buy_30s: "直前30秒の買い主導枚数", sell_30s: "直前30秒の売り主導枚数", delta_30s: "buy_30s−sell_30s",
  buy_60s: "直前60秒の買い主導枚数", sell_60s: "直前60秒の売り主導枚数", delta_60s: "buy_60s−sell_60s",
  buy_5m: "直前300秒の買い主導枚数", sell_5m: "直前300秒の売り主導枚数", delta_5m: "buy_5m−sell_5m",
  cvd_slope_10m: "直前600個の秒末CVDを秒にOLS回帰した傾き×60、枚/分",
  cvd_divergence: "過去10分の後半5分が前半5分より価格高値更新/CVD非更新(1)、安値更新/CVD非更新(-1)、その他0。極値の最初の実約定時点、時刻・sequence順",
  count_z_60s: "(最新60秒件数−それ以前29個の60秒件数の平均)/母標準偏差。偏差0は空欄",
  max_size_5m: "過去300秒の個別約定最大枚数。N含む",
  sweep_seconds_5m: "過去300秒で同方向主導の3以上の異なる価格がある秒数。買売両成立でも1秒",
  absorption_60s: "期待反転が下なら買い、上なら売りの60秒枚数/(その方向への終値−初値の進行ticks、最低0、+1)",
  imbalance_1: "t−1秒の上位1段(bid−ask)/(bid+ask)", imbalance_5: "同5段", imbalance_10: "同10段",
  bid10_change_60s: "t−1秒とt−61秒の上位10段買い数量の差、枚",
  ask10_change_60s: "t−1秒とt−61秒の上位10段売り数量の差、枚",
  near_size: "t−1秒のマーク価格±2ticksの両側合計数量、枚",
  near_change_60s: "同価格帯のt−1秒とt−61秒の数量差、枚",
  estimated_pull_60s: "直前60秒、各側各価格のmax(0,前秒数量−当秒数量−同秒同価格の全約定枚数)の合計。取消の確定ではない",
};
export const OUTCOMES: Record<string, string> = {
  move_1m: "tから60秒未満の最終約定価格−マーク価格、ticks。符号は生の価格方向",
  move_5m: "同300秒", move_15m: "同900秒",
  favorable_15m: "期待反転方向への最大進行、ticks、最低0",
  adverse_15m: "期待反転と逆方向への最大進行、ticks、最低0",
  crossed_15m: "期待反転と逆方向へマーク価格を1tick以上抜けたら1、それ以外0",
};
export interface FeatureResult {
  values: Record<string, string | number | null>;
  reasons: Record<string, string>;
}
export function result(): FeatureResult {
  return { values: Object.fromEntries([...Object.keys(FEATURES), ...Object.keys(OUTCOMES)].map(k => [k, null])),
    reasons: {} };
}
export function put(out: FeatureResult, k: string, value: string | number | null, reason = "incomplete_tick_coverage") {
  out.values[k] = value;
  if (value === null || typeof value === "number" && !Number.isFinite(value)) {
    out.values[k] = null; out.reasons[k] = reason;
  } else delete out.reasons[k];
}
export function contractIn(data: DayData, a: number, b: number) {
  return data.identity(a, b);
}
export function calculate(label: TurningLabel, data: DayData): FeatureResult {
  const out = result(), t = label.tsSec, clock = sessionClock(t);
  for (const k of Object.keys(out.values)) out.reasons[k] = "data_unavailable";
  put(out, "session", clock.session); put(out, "minutes_from_ct17", clock.minutesFromSession);
  put(out, "minutes_from_us_open", clock.minutesFromUsOpen);
  const round = label.symbol === "NQ" ? 400 : 100;
  put(out, "distance_round", label.priceTicks - Math.round(label.priceTicks / round) * round);
  const compatible = (a: number, b: number) => data.complete(a, b) && contractIn(data, a, b) !== "MIXED";
  for (const [seconds, suffix] of [[30, "30s"], [60, "60s"], [300, "5m"]] as const) {
    let buy = 0, sell = 0;
    for (let s = t - seconds; s < t; s++) { buy += data.frame(s)?.buy ?? 0; sell += data.frame(s)?.sell ?? 0; }
    if (!Number.isSafeInteger(buy) || !Number.isSafeInteger(sell)) throw Error("quantity_overflow");
    for (const [name, v] of [["buy", buy], ["sell", sell], ["delta", buy - sell]] as const)
      put(out, `${name}_${suffix}`, compatible(t - seconds, t) ? v : null, "coverage_or_contract_mixed");
  }
  for (const [n, name] of [[300, "rv_5m"], [1800, "rv_30m"]] as const)
    put(out, name, compatible(t - n, t) ? data.rv(t - n, t) : null, "coverage_contract_or_reference_price");
  const r = data.range(t - 1800, t);
  const complete30 = compatible(t - 1800, t);
  put(out, "range_30m", complete30 && r ? r.high - r.low : null);
  const first = data.frames.slice(Math.max(0, t - 1800 - data.start), t - data.start).find(Boolean);
  put(out, "direction_30m", complete30 && r && r.high > r.low && first
    ? (data.close(t - 1)! - first.o) / (r.high - r.low) : null, "coverage_contract_or_zero_range");
  const sr = data.range(data.session, t);
  for (const side of ["high", "low"] as const)
    put(out, `distance_session_${side}`, compatible(data.session, t) && sr ? label.priceTicks - sr[side] : null);
  if (compatible(t - 300, t)) {
    let max = 0, sweep = 0;
    for (let s = t - 300; s < t; s++) {
      const f = data.frame(s); if (!f) continue;
      max = Math.max(max, f.max); sweep += Number(f.bp.length === 3 || f.sp.length === 3);
    }
    put(out, "max_size_5m", max); put(out, "sweep_seconds_5m", sweep);
  }
  if (compatible(t - 60, t)) {
    const rows = data.frames.slice(t - 60 - data.start, t - data.start).filter(Boolean) as Second[];
    const start = rows[0]?.o, end = rows.at(-1)?.c;
    const approach = label.expectedDirection === "down" ? 1 : -1;
    const qty = label.expectedDirection === "down" ? out.values.buy_60s : out.values.sell_60s;
    put(out, "absorption_60s", start !== undefined && end !== undefined && typeof qty === "number"
      ? qty / (Math.max(0, (end - start) * approach) + 1) : null, "no_reference_price");
  }
  if (compatible(t - 600, t)) {
    const n = 600, meanX = (n - 1) / 2;
    let numerator = 0, denominator = 0;
    for (let i = 0; i < n; i++) {
      numerator += (i - meanX) * data.cvd[t - 600 - data.start + i + 1]!;
      denominator += (i - meanX) ** 2;
    }
    put(out, "cvd_slope_10m", numerator / denominator * 60);
  }
  if (complete30) {
    const counts: number[] = [];
    for (let j = 0; j < 30; j++) {
      let count = 0;
      for (let s = t - (j + 1) * 60; s < t - j * 60; s++) count += data.frame(s)?.count ?? 0;
      counts.push(count);
    }
    const baseline = counts.slice(1), mean = baseline.reduce((a, b) => a + b, 0) / 29;
    const sd = Math.sqrt(baseline.reduce((v, x) => v + (x - mean) ** 2, 0) / 29);
    put(out, "count_z_60s", sd ? (counts[0]! - mean) / sd : null, "zero_standard_deviation");
  }
  const direction = label.expectedDirection === "up" ? 1 : -1;
  const origin = data.identity(t - 1800, t);
  const futureCompatible = (end: number) => compatible(t, end) && origin !== "MIXED"
    && (data.identity(t, end) === origin || data.range(t, end) === null);
  for (const [n, key] of [[60, "move_1m"], [300, "move_5m"], [900, "move_15m"]] as const)
    put(out, key, futureCompatible(t + n) && Number.isFinite(data.close(t + n - 1))
      ? data.close(t + n - 1)! - label.priceTicks : null, "incomplete_future_or_contract_mixed");
  const constant = data.close(t + 899);
  const after = data.range(t, t + 900) ?? (Number.isFinite(constant) ? { high: constant!, low: constant! } : null);
  if (futureCompatible(t + 900) && after) {
    const favorable = direction === 1 ? after.high - label.priceTicks : label.priceTicks - after.low;
    const adverse = direction === 1 ? label.priceTicks - after.low : after.high - label.priceTicks;
    put(out, "favorable_15m", Math.max(0, favorable)); put(out, "adverse_15m", Math.max(0, adverse));
    put(out, "crossed_15m", Number(adverse >= 1));
  }
  return out;
}

export function valueArea(profile: Map<number, number>) {
  const rows = [...profile].sort((a, b) => a[0] - b[0]);
  if (!rows.length) return null;
  let p = 0, total = 0;
  rows.forEach(([_, q], i) => { total += q; if (q >= rows[p]![1]) p = i; });
  let low = p, high = p, count = rows[p]![1];
  while (count < total * .7 && (low > 0 || high + 1 < rows.length)) {
    if (high + 1 < rows.length && (low === 0 || rows[high + 1]![1] >= rows[low - 1]![1])) count += rows[++high]![1];
    else count += rows[--low]![1];
  }
  return { poc: rows[p]![0], vah: rows[high]![0], val: rows[low]![0] };
}

export function boardFeatures(label: TurningLabel, rows: Map<number, Column>,
  quantities: Map<number, Map<number, number>>, ticksComplete: boolean, out: FeatureResult) {
  const t = label.tsSec, now = rows.get(t - 1), before = rows.get(t - 61);
  const sum = (a: readonly { price: number; size: number }[], n: number) => a.slice(0, n).reduce((s, x) => s + x.size, 0);
  const near = (c: Column) => c.bids.length && c.asks.length
    && label.priceTicks - 2 >= Math.min(...c.bids.map(x => x.price))
    && label.priceTicks + 2 <= Math.max(...c.asks.map(x => x.price))
    ? [...c.bids, ...c.asks].filter(x => Math.abs(x.price - label.priceTicks) <= 2).reduce((s, x) => s + x.size, 0) : null;
  if (now) {
    for (const n of [1, 5, 10]) {
      const b = sum(now.bids, n), a = sum(now.asks, n);
      put(out, `imbalance_${n}`, b + a ? (b - a) / (b + a) : null, "zero_depth");
    }
    put(out, "near_size", near(now), "outside_published_depth");
  }
  if (now && before) {
    put(out, "bid10_change_60s", sum(now.bids, 10) - sum(before.bids, 10));
    put(out, "ask10_change_60s", sum(now.asks, 10) - sum(before.asks, 10));
    const n = near(now), p = near(before);
    put(out, "near_change_60s", n !== null && p !== null ? n - p : null, "outside_published_depth");
  }
  let pull = 0;
  for (let s = t - 60; s < t; s++) {
    const a = rows.get(s - 1), b = rows.get(s);
    if (!a || !b || !ticksComplete) { put(out, "estimated_pull_60s", null, "incomplete_book_or_tick_coverage"); return; }
    for (const side of ["bids", "asks"] as const) {
      const next = new Map(b[side].map(v => [v.price, v.size]));
      // Prices beyond the new published depth are UNKNOWN, not a cancellation.
      const prices = b[side].map(v => v.price);
      if (!prices.length) { put(out, "estimated_pull_60s", null, "unknown_published_depth"); return; }
      const low = Math.min(...prices), high = Math.max(...prices);
      for (const row of a[side]) {
        if (row.price < low || row.price > high) {
          if ((quantities.get(s)?.get(row.price) ?? 0) < row.size) {
            put(out, "estimated_pull_60s", null, "unknown_published_depth_shift"); return;
          }
          continue;
        }
        pull += Math.max(0, row.size - (next.get(row.price) ?? 0) - (quantities.get(s)?.get(row.price) ?? 0));
      }
    }
  }
  put(out, "estimated_pull_60s", pull);
}
