import { dayEndSec, dayStartSec, isRthSec, weekEndSec, weekKey, weekStartSec, shiftDate, shiftTradingDays } from "./time.ts";
import { validContract, UNKNOWN_CONTRACT, type MarketSymbol } from "../../../../lib/market/instruments.ts";
import { ACTIVE_SYMBOL } from "../instrument.ts";

export type BarRow = [number, number, number, number, number, number, number, number];
export type VolumeRow = [number, number, number, number, number];
export interface DayData {
  version: 1; tradingDate: string; startSec: number; endSec: number;
  contracts: { contract: string; fromSec: number; toSec: number }[];
  bars1m: BarRow[]; vp30m: VolumeRow[]; gaps: [number, number][];
  complete: boolean; builtAtUs: number;
}
export interface RollData {
  from: string; to: string; atSec: number; diffTicks: number; method: string;
  detail?: Record<string, unknown>;
}

const ints = (row: unknown, n: number) => Array.isArray(row) && row.length === n && row.every(Number.isSafeInteger);
/** Structural validation of a received day; throws with a short reason. */
export function parseDay(value: unknown, symbol: MarketSymbol = ACTIVE_SYMBOL): DayData {
  const d = value as DayData;
  if (!d || typeof d !== "object" || d.version !== 1 || typeof d.tradingDate !== "string"
    || !Number.isFinite(d.startSec) || !Number.isFinite(d.endSec) || !Array.isArray(d.contracts)
    || !Array.isArray(d.bars1m) || !Array.isArray(d.vp30m) || !Array.isArray(d.gaps)) throw Error("日次データの形式が不正です");
  if (!/^\d{4}-\d\d-\d\d$/.test(d.tradingDate) || d.startSec >= d.endSec || typeof d.complete !== "boolean")
    throw Error("日次データの形式が不正です");
  for (const c of d.contracts) if (!c || !validContract(c.contract, symbol, true) || !Number.isFinite(c.fromSec) || !Number.isFinite(c.toSec))
    throw Error("限月の形式が不正です");
  for (const r of d.bars1m) if (!ints(r, 8) || r[7] < 0 || r[7] >= d.contracts.length || r[5] < 0 || r[6] < 0
    || r[2] < Math.max(r[1], r[3], r[4]) || r[3] > Math.min(r[1], r[2], r[4])) throw Error("1分足の形式が不正です");
  for (const r of d.vp30m) if (!ints(r, 5) || r[4] < 0 || r[4] >= d.contracts.length || r[2] < 0 || r[3] < 0)
    throw Error("出来高の形式が不正です");
  for (const g of d.gaps) if (!Array.isArray(g) || g.length !== 2 || !g.every(Number.isFinite) || g[0] >= g[1])
    throw Error("欠損区間の形式が不正です");
  return d;
}
export function parseRolls(value: unknown, symbol: MarketSymbol = ACTIVE_SYMBOL): RollData[] {
  if (!Array.isArray(value)) throw Error("乗り換え記録の形式が不正です");
  for (const r of value as RollData[]) if (!r || !validContract(r.from, symbol) || !validContract(r.to, symbol)
    || r.from === r.to || !Number.isSafeInteger(r.diffTicks) || !Number.isFinite(r.atSec)) throw Error("乗り換え記録の形式が不正です");
  return value as RollData[];
}

/* ---------- roll adjustment ---------- */

/** Ticks to add so `contract` prices align to `latest`. null = UNKNOWN (never treated as zero). */
export function adjustmentTable(contracts: Iterable<string>, rolls: RollData[], latest: string | null) {
  const out = new Map<string, number | null>();
  const sorted = rolls.slice().sort((a, b) => a.atSec - b.atSec);
  for (const c of contracts) {
    if (out.has(c)) continue;
    if (latest === null || c === UNKNOWN_CONTRACT || latest === UNKNOWN_CONTRACT) { out.set(c, null); continue; }
    let cur = c, sum = 0, ok = true, after = -Infinity;
    const seen = new Set<string>();
    while (cur !== latest) {
      if (seen.has(cur)) { ok = false; break; }
      seen.add(cur);
      const next = sorted.find(r => r.from === cur && r.atSec > after);
      if (!next) { ok = false; break; }
      sum += next.diffTicks; after = next.atSec; cur = next.to;
    }
    out.set(c, ok ? sum : null);
  }
  return out;
}
/** Front contract: newest of loaded/today contract periods and the newest roll target. */
export function latestContract(days: DayData[], rolls: RollData[] = []): string | null {
  let best: { contract: string; at: number } | null = null;
  for (const d of days) for (const c of d.contracts) if (c.contract !== UNKNOWN_CONTRACT && (!best || c.toSec >= best.at)) best = { contract: c.contract, at: c.toSec };
  for (const r of rolls) if (!best || r.atSec > best.at) best = { contract: r.to, at: r.atSec };
  return best?.contract ?? null;
}

/* ---------- normalized, adjusted series ---------- */

export interface Bar { t: number; o: number; h: number; l: number; c: number; }
export interface Series {
  bars: Bar[];                 // adjusted, 1m, sorted; unadjustable bars omitted
  cvd: { t: number; v: number; week: string }[];   // minute end, weekly cumulative
  vwap: { t: number; v: number; week: string }[];  // 30m block end, weekly cumulative
  volumes: { t: number; p: number; v: number; date: string }[]; // adjusted 30m rows
  unadjustableDates: Set<string>;
  gaps: [number, number][];
}

/** Builds all derived series. Days must cover whole weeks so weekly totals are complete. */
export function buildSeries(days: DayData[], rolls: RollData[], latest: string | null): Series {
  const sorted = days.slice().sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
  const adj = adjustmentTable(sorted.flatMap(d => d.contracts.map(c => c.contract)), rolls, latest);
  const bars: Bar[] = [], cvdRaw: { t: number; d: number; week: string }[] = [];
  const volumes: Series["volumes"] = [], unadjustableDates = new Set<string>(), gaps: [number, number][] = [];
  for (const day of sorted) {
    const offsets = day.contracts.map(c => adj.get(c.contract) ?? null);
    for (const g of day.gaps) gaps.push([g[0], g[1]]);
    const week = weekKey(day.tradingDate);
    for (const r of day.bars1m) {
      cvdRaw.push({ t: r[0] + 60, d: r[5] - r[6], week });
      const o = offsets[r[7]];
      if (o === null) { unadjustableDates.add(day.tradingDate); continue; }
      bars.push({ t: r[0], o: r[1] + o, h: r[2] + o, l: r[3] + o, c: r[4] + o });
    }
    for (const r of day.vp30m) {
      const o = offsets[r[4]];
      if (o === null) { unadjustableDates.add(day.tradingDate); continue; }
      volumes.push({ t: r[0], p: r[1] + o, v: r[2] + r[3], date: day.tradingDate });
    }
  }
  bars.sort((a, b) => a.t - b.t);
  cvdRaw.sort((a, b) => a.t - b.t);
  volumes.sort((a, b) => a.t - b.t || a.p - b.p);
  return { bars, cvd: weeklyCvd(cvdRaw), vwap: weeklyVwap(volumes), volumes, unadjustableDates, gaps };
}

/** Cumulative buy-sell per minute, reset at each week start (Sunday CT 17:00). */
export function weeklyCvd(rows: { t: number; d: number; week: string }[]) {
  const out: Series["cvd"] = [];
  let week = "", sum = 0;
  for (const r of rows) {
    if (r.week !== week) { week = r.week; sum = 0; }
    sum += r.d; out.push({ t: r.t, v: sum, week });
  }
  return out;
}
/** Σ(price×volume)/Σvolume per 30m block, reset weekly. Input rows must be adjusted. */
export function weeklyVwap(rows: { t: number; p: number; v: number; date: string }[]) {
  const out: Series["vwap"] = [];
  let week = "", pv = 0, vol = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], w = weekKey(r.date);
    if (w !== week) { week = w; pv = 0; vol = 0; }
    pv += r.p * r.v; vol += r.v;
    const last = i === rows.length - 1 || rows[i + 1].t !== r.t || weekKey(rows[i + 1].date) !== w;
    if (last && vol > 0) out.push({ t: r.t + 1800, v: pv / vol, week });
  }
  return out;
}

/* ---------- profiles ---------- */

export interface Profile {
  key: string; startSec: number; endSec: number;
  levels: Map<number, number>;  // 1 tick price -> volume
  total: number; poc: number | null; vah: number | null; val: number | null;
  unadjustable: boolean;
}
export function periodBounds(date: string, period: "day" | "week") {
  return period === "day" ? { key: date, startSec: dayStartSec(date), endSec: dayEndSec(date) }
    : { key: weekKey(date), startSec: weekStartSec(date), endSec: weekEndSec(date) };
}
/** Extend into 10% of the NEXT trading period, including over closed weekends/DST. */
export function pocExtensionEnd(key: string, period: "day" | "week") {
  const nextDate = period === "day" ? shiftTradingDays(key, 1) : shiftDate(key, 8);
  const next = periodBounds(nextDate, period);
  return next.startSec + (next.endSec - next.startSec) * .1;
}
export function buildProfiles(series: Series, period: "day" | "week", rthOnly: boolean, dates: string[]): Profile[] {
  const map = new Map<string, Profile>();
  for (const date of dates) {
    const b = periodBounds(date, period);
    if (!map.has(b.key)) map.set(b.key, { ...b, levels: new Map(), total: 0, poc: null, vah: null, val: null, unadjustable: false });
    if (series.unadjustableDates.has(date)) map.get(b.key)!.unadjustable = true;
  }
  for (const r of series.volumes) {
    if (rthOnly && !isRthSec(r.t)) continue;
    const p = map.get(period === "day" ? r.date : weekKey(r.date));
    if (!p || r.v <= 0) continue;
    p.levels.set(r.p, (p.levels.get(r.p) ?? 0) + r.v); p.total += r.v;
  }
  const out = [...map.values()].sort((a, b) => a.startSec - b.startSec);
  for (const p of out) Object.assign(p, valueArea(p.levels));
  return out;
}

/** POC (tie: higher price) and 70% value area at fixed 1-tick resolution. Ties expand upward. */
export function valueArea(levels: Map<number, number>, fraction = .7) {
  if (levels.size === 0) return { poc: null, vah: null, val: null };
  let poc = 0, best = -1, lo = Infinity, hi = -Infinity, total = 0;
  for (const [p, v] of levels) {
    total += v; lo = Math.min(lo, p); hi = Math.max(hi, p);
    if (v > best || (v === best && p > poc)) { best = v; poc = p; }
  }
  let up = poc, down = poc, sum = best;
  const target = total * fraction;
  while (sum < target && (up < hi || down > lo)) {
    const a = up < hi ? levels.get(up + 1) ?? 0 : -1, b = down > lo ? levels.get(down - 1) ?? 0 : -1;
    if (a >= b) { up++; sum += Math.max(0, a); } else { down--; sum += b; }
  }
  return { poc, vah: up, val: down };
}

/** Display grouping: sums 1-tick levels into buckets of `group` ticks (bucket = floor(p/g)*g). */
export function groupLevels(levels: Map<number, number>, group: number) {
  const out = new Map<number, number>();
  for (const [p, v] of levels) { const k = Math.floor(p / group) * group; out.set(k, (out.get(k) ?? 0) + v); }
  return out;
}
export interface PixelRow { y: number; h: number; v: number; }
/** Collapses grouped rows into device-pixel rows. Volumes landing in the same 1px row are SUMMED;
 *  buckets taller than one pixel become bands clipped to [0,height). */
export function pixelRows(grouped: Map<number, number>, group: number, priceToY: (p: number) => number, height: number): PixelRow[] {
  const single = new Map<number, number>(), out: PixelRow[] = [];
  for (const [p, v] of grouped) {
    const top = Math.floor(priceToY(p + group - .5)), bottom = Math.floor(priceToY(p - .5));
    if (bottom - top > 1) {
      const y0 = Math.max(0, top), y1 = Math.min(height, bottom);
      if (y1 > y0) out.push({ y: y0, h: y1 - y0, v });
      continue;
    }
    const y = Math.floor(priceToY(p + (group - 1) / 2));
    if (y < 0 || y >= height) continue;
    single.set(y, (single.get(y) ?? 0) + v);
  }
  for (const [y, v] of single) out.push({ y, h: 1, v });
  return out.sort((a, b) => a.y - b.y);
}

/* ---------- adaptive bar granularity ---------- */

export const BAR_MINUTES = [1, 2, 5, 15, 30, 60, 120, 240] as const;
/** Smallest bar size giving at least `minPx` CSS pixels per bar. */
export function barMinutes(secPerPx: number, minPx = 4): number {
  for (const m of BAR_MINUTES) if ((m * 60) / secPerPx >= minPx) return m;
  return BAR_MINUTES.at(-1)!;
}
/** Aggregates 1m bars; buckets aligned to the UTC epoch, never across missing minutes' gaps. */
export function aggregateBars(bars: Bar[], minutes: number, fromSec: number, toSec: number): Bar[] {
  const size = minutes * 60, out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars) {
    if (b.t + 60 < fromSec - size || b.t > toSec + size) continue;
    const t = Math.floor(b.t / size) * size;
    if (cur && cur.t === t) { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
    else { cur = { ...b, t }; out.push(cur); }
  }
  return out;
}
