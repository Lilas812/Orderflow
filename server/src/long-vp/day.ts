import { atET, parts, shiftDate } from "./calendar.ts";
import { LongAggregate } from "./aggregate.ts";
import type { Roll } from "./rest.ts";

export type BarRow = [number, number, number, number, number, number, number, number, number?];
export type VolumeRow = [number, number, number, number, number, number?];
export interface DayData {
  version: 1; tradingDate: string; startSec: number; endSec: number;
  contracts: { contract: string; fromSec: number; toSec: number }[];
  bars1m: BarRow[]; vp30m: VolumeRow[]; gaps: [number, number][];
  complete: boolean; builtAtUs: number;
}
export interface RollData {
  from: string; to: string; atSec: number; diffTicks: number; method: "edge";
  detail: { beforeUs: number; afterUs: number; beforePrice: number; afterPrice: number; gapSeconds: number;
    fromSinceUs?: number };
}
export function improvesDay(old: DayData, next: DayData) {
  if (next.gaps.some(([a, b]) => !old.gaps.some(([x, y]) => x <= a && b <= y))) return false;
  const key = (d: DayData, r: DayData["vp30m"][number]) => `${r[0]}:${r[1]}:${d.contracts[r[4]].contract}`;
  const rows = new Map(next.vp30m.map(r => [key(next, r), r]));
  return old.vp30m.every(r => {
    const n = rows.get(key(old, r));
    return n !== undefined && n[2] >= r[2] && n[3] >= r[3] && (n[5] ?? 0) >= (r[5] ?? 0);
  });
}
export function validDate(date: string) {
  return /^\d{4}-\d\d-\d\d$/.test(date) && Number.isFinite(Date.parse(date + "T12:00:00Z"))
    && new Date(date + "T12:00:00Z").toISOString().slice(0, 10) === date;
}
export function tradingDate(date: string) {
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  return weekday !== 0 && weekday !== 6;
}
export function dayBounds(date: string) {
  return { startUs: atET(shiftDate(date, -1), 18), endUs: atET(date, 18) };
}
export function dayAt(us: number): string | null {
  const p = parts(us), date = p.hour >= 18 ? shiftDate(p.date, 1) : p.date;
  return tradingDate(date) ? date : null;
}
export function datesBetween(from: string, to: string, max = 60) {
  if (!validDate(from) || !validDate(to) || from > to) throw Error("invalid_date_range");
  const dates: string[] = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) {
    if (tradingDate(date)) dates.push(date);
    if (dates.length > max) throw Error("range_exceeds_60_trading_days");
  }
  return dates;
}
export function nextFinalizeUs(us: number) {
  const p = parts(us);
  for (let i = 0; i < 8; i++) {
    const date = shiftDate(p.date, i), candidate = atET(date, 18, 5);
    if (tradingDate(date) && candidate > us) return candidate;
  }
  throw Error("no_next_trading_day");
}
export function isRth(us: number) {
  const p = parts(us);
  return tradingDate(p.date) && us >= atET(p.date, 9, 30) && us < atET(p.date, 16);
}
export function weekStartUs(us: number) {
  const date = dayAt(us);
  if (!date) return null;
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  return atET(shiftDate(date, -weekday), 18);
}
export function mergeAggregates(a: LongAggregate, b: LongAggregate) {
  const result = new LongAggregate();
  for (const source of [a, b]) {
    for (const [key, v] of source.volumes) {
      const old = result.volumes.get(key);
      result.volumes.set(key, old ? { ...v, buy: old.buy + v.buy, sell: old.sell + v.sell,
        ...((old.undirected ?? 0) + (v.undirected ?? 0) ? { undirected: (old.undirected ?? 0) + (v.undirected ?? 0) } : {}) } : { ...v });
    }
    for (const [key, v] of source.minutes) {
      const old = result.minutes.get(key);
      result.minutes.set(key, old ? { ...v, open: old.firstUs <= v.firstUs ? old.open : v.open,
        close: old.lastUs > v.lastUs ? old.close : v.close, high: Math.max(old.high, v.high),
        low: Math.min(old.low, v.low), buy: old.buy + v.buy, sell: old.sell + v.sell,
        ...((old.undirected ?? 0) + (v.undirected ?? 0) ? { undirected: (old.undirected ?? 0) + (v.undirected ?? 0) } : {}),
        firstUs: Math.min(old.firstUs, v.firstUs), lastUs: Math.max(old.lastUs, v.lastUs) } : { ...v });
    }
    result.count += source.count;
  }
  return result;
}
export function serializeDay(date: string, aggregate: LongAggregate, timeline: Roll[],
  gaps: [number, number][], nowUs: number, provisional = false, recordContracts = false,
  verifiedContracts?: DayData["contracts"]): DayData {
  const { startUs, endUs } = dayBounds(date);
  const contracts: DayData["contracts"] = verifiedContracts?.map(c => ({ ...c })) ?? [];
  const sorted = timeline.slice().sort((a, b) => a.sinceUs - b.sinceUs);
  for (let i = 0; verifiedContracts === undefined && i < sorted.length; i++) {
    const from = Math.max(startUs, sorted[i].sinceUs), to = Math.min(endUs, sorted[i + 1]?.sinceUs ?? endUs);
    if (from < to) contracts.push({ contract: sorted[i].contract, fromSec: from / 1e6, toSec: to / 1e6 });
  }
  if (recordContracts) {
    // These are row-attribution spans, NOT inferred expiry activation times.
    // Unknown and explicit identities may overlap within the same minute.
    contracts.length = 0;
    const identities = new Set([...aggregate.minutes.values()].map(b => b.contract));
    for (const contract of identities) {
      const rows = [...aggregate.minutes.values()].filter(b => b.contract === contract);
      contracts.push({ contract, fromSec: Math.max(startUs / 1e6, Math.min(...rows.map(b => b.firstUs)) / 1e6),
        toSec: Math.min(endUs / 1e6, (Math.max(...rows.map(b => b.lastUs)) + 1) / 1e6) });
    }
  }
  const index = (contract: string, us: number) => {
    const n = contracts.findIndex(c => c.contract === contract && us < c.toSec * 1e6
      && us + 1800e6 > c.fromSec * 1e6);
    if (n < 0) throw Error("unverified_contract_index");
    return n;
  };
  return { version: 1, tradingDate: date, startSec: startUs / 1e6, endSec: endUs / 1e6, contracts,
    bars1m: [...aggregate.minutes.values()].sort((a, b) => a.startUs - b.startUs || a.contract.localeCompare(b.contract))
      .map((b): BarRow => b.undirected
        ? [b.startUs / 1e6, b.open, b.high, b.low, b.close, b.buy, b.sell, index(b.contract, b.startUs), b.undirected]
        : [b.startUs / 1e6, b.open, b.high, b.low, b.close, b.buy, b.sell, index(b.contract, b.startUs)]),
    vp30m: [...aggregate.volumes.values()].sort((a, b) => a.startUs - b.startUs || a.price - b.price || a.contract.localeCompare(b.contract))
      .map((v): VolumeRow => v.undirected
        ? [v.startUs / 1e6, v.price, v.buy, v.sell, index(v.contract, v.startUs), v.undirected]
        : [v.startUs / 1e6, v.price, v.buy, v.sell, index(v.contract, v.startUs)]),
    gaps, complete: !provisional && gaps.length === 0, builtAtUs: nowUs };
}
export function edgeDifference(from: string, to: string, atUs: number,
  before: { tsUs: number; price: number } | null, after: { tsUs: number; price: number } | null): RollData {
  if (!before || !after || before.tsUs >= atUs || after.tsUs < atUs) throw Error("roll_edge_unavailable");
  if (![before.price, after.price, atUs, before.tsUs, after.tsUs].every(Number.isSafeInteger))
    throw Error("invalid_roll_edge");
  return { from, to, atSec: atUs / 1e6, diffTicks: after.price - before.price, method: "edge",
    detail: { beforeUs: before.tsUs, afterUs: after.tsUs, beforePrice: before.price,
      afterPrice: after.price, gapSeconds: (after.tsUs - before.tsUs) / 1e6 } };
}
