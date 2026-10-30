/** Purchased-volume front-month proposal only. No active-pointer or production writes. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";
import { session, sessionAt, parts, shiftDate } from "../long-vp/calendar.ts";
import { datesBetween } from "../long-vp/day.ts";
import { tradeFileEntries } from "../store/records.ts";
import { canonical, sha, type StagedFile } from "./databento-stage.ts";

export type DailyVolumes = Map<string, Map<string, number>>;
export interface RankedContract { contract: string; volume: number; }
export function expiry(contract: string) {
  const m = /^(NQ|GC)([FGHJKMNQUVXZ])(\d{2})$/.exec(contract);
  if (!m) throw Error("invalid_front_month_contract");
  return (2000 + Number(m[3])) * 12 + "FGHJKMNQUVXZ".indexOf(m[2]!);
}
function sum(a: number, b: number) {
  const n = a + b;
  if (!Number.isSafeInteger(n) || n < 0) throw Error("unsafe_front_month_volume");
  return n;
}
/** Keep distinct purchased rows. The stage already excludes spreads and retains B/A/N. */
export async function purchasedVolumes(activeFile: string, symbol: MarketSymbol) {
  const activeHash = await sha(activeFile), active = JSON.parse(await fs.readFile(activeFile, "utf8"));
  if (active.state !== "verified_isolated" || !Array.isArray(active.staged)
    || typeof active.stage !== "string" || !Number.isSafeInteger(active.fromUs)
    || !Number.isSafeInteger(active.toUs) || active.fromUs >= active.toUs) throw Error("invalid_verified_import");
  const daily: DailyVolumes = new Map(), hours = new Map<number, ReturnType<typeof sessionAt>>();
  let rows = 0, quantity = 0, maintenanceRows = 0, maintenanceVolume = 0, spreads = 0, files = 0;
  let outsideRows = 0, outsideVolume = 0;
  const members = new Set<string>(), inputs: { file: string; sha256: string }[] = [];
  for (const staged of active.staged as StagedFile[]) {
    if (staged.errors || members.has(staged.sha256)) throw Error("unverified_or_duplicate_purchased_day");
    members.add(staged.sha256); spreads += staged.spreads;
    const verified = path.join(active.stage, staged.sha256, "verified.json");
    if (JSON.stringify(JSON.parse(await fs.readFile(verified, "utf8"))) !== JSON.stringify(staged))
      throw Error("stage_record_changed");
    const totals = new Map<string, { count: number; buy: number; sell: number; unknown: number }>();
    const names = new Set<string>();
    for (const output of staged.outputs) {
      const m = /^(known|unknown)\/([^/]+)\/(\d{4}-\d\d-\d\d)\/(\d\d)\.jsonl\.gz$/.exec(output.path);
      const excluded = output.path === "excluded.jsonl.gz";
      if ((!m && !excluded) || names.has(output.path) || (m && !m[2]!.startsWith(symbol)))
        throw Error("invalid_purchased_output");
      names.add(output.path);
      const file = path.join(active.stage, staged.sha256, output.path);
      if (await sha(file) !== output.sha256) throw Error("purchased_file_hash_changed");
      const content = createHash("sha256"); let fileRows = 0;
      for await (const { line, trade: t } of tradeFileEntries(file)) {
        content.update(line + "\n"); fileRows++;
        if (excluded) {
          if (JSON.parse(line).reason !== "calendar_spread") throw Error("unexpected_excluded_purchased_row");
          continue;
        }
        if (t.contract !== m![2] || !Number.isSafeInteger(t.tsUs)
          || !Number.isSafeInteger(t.size) || t.size <= 0 || !["buy", "sell", "unknown"].includes(t.side)
          || (m![1] === "unknown") !== (t.side === "unknown")) throw Error("invalid_purchased_row");
        const c = totals.get(t.contract) ?? { count: 0, buy: 0, sell: 0, unknown: 0 };
        c.count++; c[t.side] = sum(c[t.side], t.size); totals.set(t.contract, c);
        rows++; quantity = sum(quantity, t.size);
        if (t.tsUs < active.fromUs || t.tsUs >= active.toUs) {
          outsideRows++; outsideVolume = sum(outsideVolume, t.size); continue;
        }
        const hour = Math.floor(t.tsUs / 3600e6);
        if (!hours.has(hour)) hours.set(hour, sessionAt(hour * 3600e6));
        const s = hours.get(hour)!;
        if (!s) { maintenanceRows++; maintenanceVolume = sum(maintenanceVolume, t.size); continue; }
        const volumes = daily.get(s.date) ?? new Map<string, number>();
        volumes.set(t.contract, sum(volumes.get(t.contract) ?? 0, t.size)); daily.set(s.date, volumes);
      }
      if (fileRows !== output.count || content.digest("hex") !== output.contentHash || await sha(file) !== output.sha256)
        throw Error("purchased_readback_changed");
      if (excluded && fileRows !== staged.spreads) throw Error("excluded_spread_count_mismatch");
      files++; inputs.push({ file, sha256: output.sha256 });
    }
    for (const [contract, expected] of Object.entries(staged.contracts)) {
      const actual = totals.get(contract);
      if (!actual || actual.count !== expected.count || actual.buy !== expected.buy
        || actual.sell !== expected.sell || actual.unknown !== expected.unknown) throw Error("purchased_contract_totals_mismatch");
    }
    if (totals.size !== Object.keys(staged.contracts).length) throw Error("unexpected_purchased_contract");
  }
  if (await sha(activeFile) !== activeHash) throw Error("import_pointer_changed_during_read");
  return { daily, fromUs: active.fromUs as number, toUs: active.toUs as number,
    audit: { activeFile, activeHash, files, rows, quantity, excludedSpreadRows: spreads,
      excludedMaintenanceRows: maintenanceRows, excludedMaintenanceVolume: maintenanceVolume,
      outsideRequestedRows: outsideRows, outsideRequestedVolume: outsideVolume,
      rawHashesAndContentVerified: true, inputs } };
}
/** Daily winner among non-expired-backwards candidates. Never switches within a day. */
export function selectFrontMonths(daily: DailyVolumes, fromUs: number, toUs: number,
  existing: Map<string, string[]> = new Map()) {
  // UTC midnight can already belong to the NEXT CT trading date.
  const first = sessionAt(fromUs)?.date ?? shiftDate(parts(fromUs).date, 1);
  const last = sessionAt(toUs - 1)?.date ?? parts(toUs - 1).date;
  const output = [];
  let previous: string | null = null;
  for (const date of datesBetween(first, last)) {
    const bounds = session(date), volumes = daily.get(date) ?? new Map<string, number>();
    if (bounds.startUs >= toUs || bounds.endUs <= fromUs) continue;
    const ranked: RankedContract[] = [...volumes].map(([contract, volume]) => ({ contract, volume }))
      .sort((a, b) => b.volume - a.volume || expiry(a.contract) - expiry(b.contract));
    const eligible = ranked.filter(c => previous === null || expiry(c.contract) >= expiry(previous));
    // Equal maxima retain yesterday's front; otherwise the earliest expiry wins ties.
    const retained = eligible.find(c => c.contract === previous && c.volume === eligible[0]?.volume);
    const front: RankedContract | null = retained ?? eligible[0]
      ?? (previous ? { contract: previous, volume: volumes.get(previous) ?? 0 } : null);
    const runnerUp = ranked.find(c => c.contract !== front?.contract) ?? null;
    const original = existing.get(date) ?? [];
    const normalized = original.map(c => {
      try { return canonical(c, Number(date.slice(0, 4))); } catch { return "unknown"; }
    });
    const conflict = front !== null && normalized.some(c => c !== front.contract);
    output.push({ date, fromUtc: new Date(bounds.startUs / 1000).toISOString(),
      toUtc: new Date(bounds.endUs / 1000).toISOString(), partialPurchasePeriod: fromUs > bounds.startUs || toUs < bounds.endUs,
      front, runnerUp, dailyLeader: ranked[0] ?? null, dailySecond: ranked[1] ?? null,
      monotonicHeld: front !== null && ranked.length > 0 && front.contract !== ranked[0]!.contract,
      existingContracts: original, existingStatus: !existing.has(date) ? "not_present"
        : conflict ? "mismatch" : front === null ? "no_volume" : normalized.length ? "match" : "no_contract",
      totalVolume: ranked.reduce((n, c) => sum(n, c.volume), 0), allContracts: ranked });
    if (front) previous = front.contract;
  }
  return output;
}
