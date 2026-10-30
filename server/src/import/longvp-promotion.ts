/** Offline, conservative LONG VP gap filling. No runtime, network, or write client. */
import { validContract, type MarketSymbol } from "../../../lib/market/instruments.ts";
import { dayBounds, type BarRow, type DayData, type VolumeRow } from "../long-vp/day.ts";
import { validateDay } from "../long-vp/objects.ts";

export interface Assignment {
  fromSec: number; toSec: number;
  sourceContract: string; targetContract: string; evidence: string;
}
export interface Inventory {
  version: 1; symbol: MarketSymbol; capturedAt: string;
  objects: { name: string; file: string; sha256: string }[];
}
export interface Guard { name: string; sha256: string | null; }
export interface FillAudit {
  accepted: number[]; skipped: Record<string, number>;
  buy: number; sell: number; unknown: number; weightedTicks: string;
}
export const dayObject = (symbol: MarketSymbol, date: string) => `prod/longvp/${symbol}/days/${date}.json.gz`;
export function validateAssignments(windows: Assignment[], symbol: MarketSymbol) {
  let end = -Infinity;
  for (const w of windows.slice().sort((a, b) => a.fromSec - b.fromSec)) {
    if (!Number.isSafeInteger(w.fromSec) || !Number.isSafeInteger(w.toSec) || w.fromSec >= w.toSec
      || w.fromSec < end || !validContract(w.sourceContract, symbol) || !validContract(w.targetContract, symbol)
      || typeof w.evidence !== "string" || !w.evidence.trim()) throw Error("invalid_or_overlapping_assignment");
    end = w.toSec;
  }
}
export function validateInventory(value: Inventory, symbol: MarketSymbol): Inventory {
  if (value?.version !== 1 || value.symbol !== symbol || !Number.isFinite(Date.parse(value.capturedAt))
    || !Array.isArray(value.objects)) throw Error("invalid_inventory");
  const names = new Set<string>();
  for (const o of value.objects) {
    const date = o.name?.match(/\/(\d{4}-\d\d-\d\d)\.json\.gz$/)?.[1];
    if (!date || o.name !== dayObject(symbol, date) || !/^[a-f0-9]{64}$/.test(o.sha256)
      || typeof o.file !== "string" || !o.file || names.has(o.name)) throw Error("invalid_inventory_object");
    names.add(o.name);
  }
  return value;
}
/** Detects changes in a freshly supplied snapshot, NOT an atomic cloud write/CAS. */
export function checkGuards(guards: Guard[], inventory: Inventory, symbol: MarketSymbol) {
  validateInventory(inventory, symbol);
  const current = new Map(inventory.objects.map(o => [o.name, o.sha256]));
  for (const g of guards) if ((current.get(g.name) ?? null) !== g.sha256)
    throw Error(`production_snapshot_changed:${g.name}`);
}
function normalized(gaps: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of gaps.slice().sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
function subtract(gaps: [number, number][], a: number, b: number): [number, number][] {
  return gaps.flatMap(([x, y]) => y <= a || x >= b ? [[x, y] as [number, number]]
    : [...(x < a ? [[x, a] as [number, number]] : []), ...(b < y ? [[b, y] as [number, number]] : [])]);
}
function ordered<T extends { 0: number }>(rows: T[]): T[] {
  for (let i = 1; i < rows.length; i++) if (rows[i - 1]![0]! > rows[i]![0]!) throw Error("unordered_day_rows");
  return rows;
}
function merge<T extends { 0: number }>(a: T[], b: T[]): T[] {
  ordered(a); ordered(b);
  const out: T[] = []; let i = 0, j = 0;
  while (i < a.length || j < b.length)
    out.push(j >= b.length || (i < a.length && a[i]![0]! <= b[j]![0]!) ? a[i++]! : b[j++]!);
  return out;
}
export function checkedDay(value: unknown, symbol: MarketSymbol): DayData {
  const d = validateDay(value, symbol), b = dayBounds(d.tradingDate);
  if (d.startSec !== b.startUs / 1e6 || d.endSec !== b.endUs / 1e6) throw Error("incorrect_day_bounds");
  ordered(d.bars1m); ordered(d.vp30m);
  return d;
}
export function fillDay(base: DayData | null, source: DayData, windows: Assignment[],
  symbol: MarketSymbol, builtAtUs: number): { day: DayData; audit: FillAudit } {
  validateAssignments(windows, symbol); checkedDay(source, symbol);
  if (base) checkedDay(base, symbol);
  if (!Number.isSafeInteger(builtAtUs) || (base && base.tradingDate !== source.tradingDate)) throw Error("invalid_fill_day");
  const day: DayData = base ? { ...base, contracts: base.contracts.map(c => ({ ...c })),
    bars1m: base.bars1m.slice(), vp30m: base.vp30m.slice(), gaps: normalized(base.gaps) }
    : { ...source, contracts: [], bars1m: [], vp30m: [], gaps: [[source.startSec, source.endSec]], complete: false };
  const oldContracts = day.contracts.length;
  const audit: FillAudit = { accepted: [], skipped: {}, buy: 0, sell: 0, unknown: 0, weightedTicks: "0" };
  const skip = (reason: string) => { audit.skipped[reason] = (audit.skipped[reason] ?? 0) + 1; };
  const occupied = new Set([...day.bars1m, ...day.vp30m].map(r => Math.floor(r[0] / 1800) * 1800));
  const bars = new Map<number, BarRow[]>(), volumes = new Map<number, VolumeRow[]>();
  for (const r of source.bars1m) {
    const b = Math.floor(r[0] / 1800) * 1800, list = bars.get(b) ?? [];
    list.push(r); bars.set(b, list);
  }
  for (const r of source.vp30m) { const list = volumes.get(r[0]) ?? []; list.push(r); volumes.set(r[0], list); }
  const incomingBars: BarRow[] = [], incomingVolumes: VolumeRow[] = [];
  let weighted = 0n;
  for (let b = source.startSec; b < source.endSec; b += 1800) {
    const w = windows.find(w => w.fromSec <= b && b + 1800 <= w.toSec);
    if (!w) { skip("unassigned_or_boundary"); continue; }
    if ((b + 1800) * 1e6 > builtAtUs) { skip("not_closed_at_snapshot"); continue; }
    if (occupied.has(b)) { skip("existing_rows"); continue; }
    if (!day.gaps.some(([a, z]) => a <= b && b + 1800 <= z)) { skip("not_a_confirmed_gap"); continue; }
    if (source.gaps.some(([a, z]) => a < b + 1800 && b < z)) { skip("source_gap"); continue; }
    if (day.contracts.some(c => c.fromSec < b + 1800 && b < c.toSec && c.contract !== w.targetContract)) {
      skip("target_contract_conflict"); continue;
    }
    const bs = (bars.get(b) ?? []).filter(r => source.contracts[r[7]]!.contract === w.sourceContract);
    const vs = (volumes.get(b) ?? []).filter(r => source.contracts[r[4]]!.contract === w.sourceContract);
    if (!bs.length || !vs.length) { skip("no_certified_rows"); continue; }
    const vb = vs.reduce((a, r) => [a[0]! + r[2], a[1]! + r[3], a[2]! + (r[5] ?? 0)], [0, 0, 0]);
    const bb = bs.reduce((a, r) => [a[0]! + r[5], a[1]! + r[6], a[2]! + (r[8] ?? 0)], [0, 0, 0]);
    if (vb.some((v, i) => !Number.isSafeInteger(v) || v !== bb[i])) throw Error("source_bar_vp_quantity_mismatch");
    let index = day.contracts.findIndex(c => c.contract === w.targetContract && c.fromSec <= b && b + 1800 <= c.toSec);
    if (index < 0) {
      const previous = day.contracts.at(-1);
      if (day.contracts.length > oldContracts && previous?.contract === w.targetContract && previous.toSec === b) {
        previous.toSec = b + 1800; index = day.contracts.length - 1;
      } else {
        index = day.contracts.length; day.contracts.push({ contract: w.targetContract, fromSec: b, toSec: b + 1800 });
      }
    }
    for (const r of bs) { const copy = r.slice() as BarRow; copy[7] = index; incomingBars.push(copy); }
    for (const r of vs) {
      const copy = r.slice() as VolumeRow; copy[4] = index; incomingVolumes.push(copy);
      weighted += BigInt(r[1]) * (BigInt(r[2]) + BigInt(r[3]) + BigInt(r[5] ?? 0));
    }
    audit.buy += vb[0]!; audit.sell += vb[1]!; audit.unknown += vb[2]!;
    if (![audit.buy, audit.sell, audit.unknown].every(Number.isSafeInteger)) throw Error("unsafe_daily_quantity");
    audit.accepted.push(b); day.gaps = subtract(day.gaps, b, b + 1800); occupied.add(b);
  }
  day.bars1m = merge(day.bars1m, incomingBars); day.vp30m = merge(day.vp30m, incomingVolumes);
  day.complete = day.gaps.length === 0;
  if (audit.accepted.length) day.builtAtUs = builtAtUs;
  audit.weightedTicks = weighted.toString();
  checkedDay(day, symbol);
  return { day, audit };
}
