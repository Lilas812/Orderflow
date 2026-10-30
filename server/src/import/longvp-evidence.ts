/** Read-only evidence checks. Never authorizes a production write. */
import * as fs from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";
import { LongAggregate } from "../long-vp/aggregate.ts";
import { dayBounds, serializeDay, type DayData } from "../long-vp/day.ts";
import { improvesDay } from "../long-vp/app-service.ts";
import { tradeFileEntries } from "../store/records.ts";
import { canonical, sha } from "./databento-stage.ts";
import { checkedDay, validateAssignments, validateInventory, type Assignment, type Inventory } from "./longvp-promotion.ts";

export interface PinnedFile { file: string; sha256: string; }
const LIMIT = 4 * 1024 * 1024;
export async function verifyPinned(input: PinnedFile) {
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || await sha(input.file) !== input.sha256)
    throw Error("evidence_input_hash_changed");
}
export async function readPinnedDay(input: PinnedFile, symbol: MarketSymbol) {
  await verifyPinned(input);
  if ((await fs.stat(input.file)).size > LIMIT) throw Error("evidence_day_budget");
  const b = await fs.readFile(input.file);
  const day = checkedDay(JSON.parse((b[0] === 31 && b[1] === 139
    ? gunzipSync(b, { maxOutputLength: LIMIT }) : b).toString()), symbol);
  await verifyPinned(input);
  return day;
}
/** Existing NQ timeline only; GC contracts are row attribution, NOT a front-month timeline. */
export async function verifyExistingNqAssignments(windows: Assignment[], inventory: Inventory) {
  validateInventory(inventory, "NQ"); validateAssignments(windows, "NQ");
  const spans: { contract: string; fromSec: number; toSec: number }[] = [];
  for (const o of inventory.objects) {
    const day = await readPinnedDay(o, "NQ");
    if (!o.name.endsWith(`/${day.tradingDate}.json.gz`)) throw Error("evidence_snapshot_date_mismatch");
    spans.push(...day.contracts);
  }
  for (const w of windows) {
    const year = new Date(w.fromSec * 1000).getUTCFullYear();
    if (canonical(w.sourceContract, year) !== canonical(w.targetContract, year)
      || !spans.some(c => c.contract === w.targetContract && c.fromSec <= w.fromSec && w.toSec <= c.toSec))
      throw Error("assignment_not_supported_by_existing_nq_timeline");
  }
  return { basis: "existing_nq_snapshot_only", intervals: windows.map(w => ({
    sourceContract: w.sourceContract, targetContract: w.targetContract,
    fromUtc: new Date(w.fromSec * 1000).toISOString(), toUtc: new Date(w.toSec * 1000).toISOString(),
  })), authorizesNewDates: false, authorizesGc: false };
}
function rows(day: DayData, kind: "bars1m" | "vp30m", selected: Set<number>) {
  const index = kind === "bars1m" ? 7 : 4, extra = index + 1;
  return day[kind].filter(r => selected.has(Math.floor(r[0] / 1800) * 1800))
    .map(r => [...r.slice(0, index), day.contracts[r[index]!]!.contract, r[extra] ?? 0])
    .map(r => JSON.stringify(r)).sort();
}
function equal(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function coverageRanges(value: unknown): [number, number][] {
  if (!Array.isArray(value) || value.some(r => !Array.isArray(r) || r.length !== 2
    || !r.every(Number.isSafeInteger) || r[0] >= r[1])) throw Error("invalid_evidence_tick_coverage");
  const merged: [number, number][] = [];
  for (const [a, b] of value.slice().sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  return merged;
}
export interface RawDayEvidence {
  symbol: MarketSymbol; source: DayData; candidate: DayData; base: DayData | null;
  sourceContract: string; targetContract: string; accepted: number[];
  /** Hash-pinned event-hour files. Every adopted hour must be present, even for zero rows. */
  rawFiles: PinnedFile[]; coverage: PinnedFile;
}
/** Independently rebuilds from immutable raw rows using the product aggregator.
 * A successful result proves ONLY the selected source slots, not production raw completeness.
 */
export async function verifyRawDay(input: RawDayEvidence) {
  const { symbol, source, candidate, base, sourceContract, targetContract } = input;
  checkedDay(source, symbol); checkedDay(candidate, symbol);
  if (base) checkedDay(base, symbol);
  if (source.tradingDate !== candidate.tradingDate || (base && base.tradingDate !== source.tradingDate)
    || source.contracts.some(c => c.contract !== sourceContract)) throw Error("evidence_day_identity");
  const year = Number(source.tradingDate.slice(0, 4));
  if (canonical(sourceContract, year) !== canonical(targetContract, year)) throw Error("evidence_contract_identity");
  const selected = new Set(input.accepted);
  if (!selected.size || selected.size !== input.accepted.length || [...selected].some(b =>
    !Number.isSafeInteger(b) || b % 1800 || b < source.startSec || b + 1800 > source.endSec))
    throw Error("invalid_evidence_buckets");
  await verifyPinned(input.coverage);
  if ((await fs.stat(input.coverage.file)).size > LIMIT) throw Error("evidence_coverage_budget");
  const coverage = coverageRanges(JSON.parse(await fs.readFile(input.coverage.file, "utf8")).tick);
  for (const b of selected) {
    if (!coverage.some(([a, z]) => a <= b && b + 1800 <= z)
      || source.gaps.some(([a, z]) => a < b + 1800 && b < z)
      || candidate.gaps.some(([a, z]) => a < b + 1800 && b < z)
      || (base && (!base.gaps.some(([a, z]) => a <= b && b + 1800 <= z)
        || [...base.bars1m, ...base.vp30m].some(r => Math.floor(r[0] / 1800) * 1800 === b))))
      throw Error("evidence_coverage_or_overlap_conflict");
    if (!candidate.contracts.some(c => c.contract === targetContract && c.fromSec <= b && b + 1800 <= c.toSec))
      throw Error("evidence_candidate_assignment");
  }
  const aggregate = new LongAggregate(), paths = new Set<string>(), hours = new Set<number>();
  let acceptedTrades = 0, buy = 0, sell = 0, unknown = 0, weightedTicks = 0n;
  // Only one day of aggregates, one streamed row at a time. No month-sized tape in memory.
  for (const raw of input.rawFiles.slice().sort((a, b) => a.file.localeCompare(b.file))) {
    const match = raw.file.replaceAll("\\", "/").match(/\/trades\/(NQ|GC)\/(\d{4}-\d\d-\d\d)\/(\d\d)\.jsonl\.gz$/);
    const hour = match ? Date.parse(`${match[2]}T${match[3]}:00:00Z`) / 1000 : NaN;
    const real = await fs.realpath(raw.file);
    if (!match || match[1] !== symbol || hour < source.startSec || hour + 3600 > source.endSec
      || !Number.isSafeInteger(hour) || hours.has(hour) || paths.has(real)) throw Error("invalid_evidence_hour_inventory");
    hours.add(hour); paths.add(real); await verifyPinned(raw);
    for await (const { trade: t } of tradeFileEntries(raw.file)) {
      if (![t.tsUs, t.recvUs, t.seq, t.price, t.size].every(Number.isSafeInteger) || t.size <= 0
        || !["buy", "sell", "unknown"].includes(t.side)
        || t.tsUs < hour * 1e6 || t.tsUs >= (hour + 3600) * 1e6) throw Error("invalid_evidence_raw_row");
      if (t.contract !== sourceContract) continue;
      aggregate.add(t, targetContract);
      if (!selected.has(Math.floor(t.tsUs / 1800e6) * 1800)) continue;
      acceptedTrades++; if (t.side === "buy") buy += t.size;
      else if (t.side === "sell") sell += t.size; else unknown += t.size;
      weightedTicks += BigInt(t.price) * BigInt(t.size);
    }
    await verifyPinned(raw);
  }
  // Missing adopted hours cannot silently mean zero trades. Non-adopted hours are
  // checked against the source aggregates below, NOT certified as complete feed hours.
  for (const b of selected) if (!hours.has(Math.floor(b / 3600) * 3600)) throw Error("evidence_missing_adopted_hour");
  if (![acceptedTrades, buy, sell, unknown].every(Number.isSafeInteger)) throw Error("unsafe_evidence_quantity");
  const rebuilt = serializeDay(source.tradingDate, aggregate,
    [{ contract: targetContract, sinceUs: dayBounds(source.tradingDate).startUs }],
    source.gaps.map(g => [...g]), source.builtAtUs);
  const mapped = { ...source, contracts: source.contracts.map(c => ({ ...c, contract: targetContract })) };
  for (const kind of ["vp30m", "bars1m"] as const) {
    if (!equal(rows(rebuilt, kind, selected), rows(mapped, kind, selected))
      || !equal(rows(candidate, kind, selected), rows(mapped, kind, selected)))
      throw Error(`raw_${kind}_mismatch`);
  }
  const allSlots = new Set(Array.from({ length: (source.endSec - source.startSec) / 1800 },
    (_, i) => source.startSec + i * 1800));
  const entireSourceRebuilt = (["vp30m", "bars1m"] as const).every(kind =>
    equal(rows(rebuilt, kind, allSlots), rows(mapped, kind, allSlots)));
  if (base) {
    if (!equal(candidate.contracts.slice(0, base.contracts.length), base.contracts))
      throw Error("evidence_existing_contracts_changed");
    for (const kind of ["vp30m", "bars1m"] as const) {
      // All original tuples, including optional fields and relative order, must survive.
      let i = 0;
      for (const row of candidate[kind]) if (equal(row, base[kind][i])) i++;
      if (i !== base[kind].length) throw Error("evidence_existing_rows_changed");
    }
    if (!improvesDay(base, candidate)) throw Error("evidence_candidate_loses_existing_data");
  }
  await verifyPinned(input.coverage);
  return { date: source.tradingDate, slots: selected.size, acceptedTrades, buy, sell, unknown,
    weightedTicks: weightedTicks.toString(), rawFiles: hours.size, rawBarsAndPricesMatch: true,
    existingRowsRetained: true, sourceCoverageMatches: true,
    entireSourceRebuilt,
    purchasedOnlyRebuildPreservesCandidate: entireSourceRebuilt && improvesDay(candidate, rebuilt),
    productionRawAndCoverageVerified: false, productionWriteAuthorized: false };
}
