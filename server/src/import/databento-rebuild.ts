import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { LongAggregate } from "../long-vp/aggregate.ts";
import { dayAt, dayBounds, serializeDay } from "../long-vp/day.ts";
import { VolumeProfile, sessionStartSec } from "../vp/state.ts";
import { tradeFileEntries } from "../store/records.ts";
import { count, emptyStats, atomic, sha } from "./databento-stage.ts";
import { coverageSegments } from "../vp/history.ts";

/** Rebuild EVERY affected historical session, not only the latest seven days. */
export async function rebuild(root: string, contract: string, signal?: AbortSignal, certified: [number, number][] = []) {
  const symbol = contract.startsWith("NQ") ? "NQ" : "GC", base = path.join(root, `trades/${symbol}`);
  const files = (await fs.readdir(base, { recursive: true })).filter(n => /^\d{4}-\d\d-\d\d\/\d\d\.jsonl\.gz$/.test(n)).sort();
  const sessions: object[] = [], totals = emptyStats();
  // CT17:00 and ET18:00 boundaries are whole UTC hours in these 2026 files.
  // Cache by the ACTUAL event hour (not filename/capture hour); timestamp rewinds
  // remain intact, while timezone formatting is not repeated for millions of rows.
  const hours = new Map<number, { session: number; date: string | null }>();
  const priceTotals = new Map<number, { buy: number; sell: number }>();
  let session: number | null = null, profile: VolumeProfile | null = null, aggregate = new LongAggregate();
  let stats = emptyStats(), dates = new Set<string>(), ignoredContractRows = 0;
  const flush = async () => {
    if (session === null || !profile) return;
    const date = new Date(session * 1000).toISOString().replaceAll(":", "-");
    const daily = profile.dailyMessage(); // loading stays true: imported subset is NOT a feed completeness claim.
    const dailyFile = path.join(root, "daily", date + ".json");
    await atomic(dailyFile, daily);
    for (const tradingDate of dates) {
      const bounds = dayBounds(tradingDate);
      const gaps = coverageSegments(certified, bounds.startUs / 1e6, bounds.endUs / 1e6)
        .filter(s => !s.covered).map(s => [s.start, s.end] as [number, number]);
      const data = serializeDay(tradingDate, aggregate, [], gaps, Date.now() * 1000, false, true);
      data.complete = false;
      await atomic(path.join(root, "longvp", tradingDate + ".json"), data);
    }
    sessions.push({ sessionStartSec: session, dates: [...dates], stats, dailyFile, sha256: await sha(dailyFile),
      cvd: stats.buy - stats.sell, vwapTicks: stats.weighted / (stats.buy + stats.sell), partial: true });
  };
  for (const file of files) for await (const { trade: t } of tradeFileEntries(path.join(base, file), signal)) {
    if (t.contract !== contract) { ignoredContractRows++; continue; }
    const eventHour = Math.floor(t.tsUs / 3600e6);
    let timing = hours.get(eventHour);
    if (!timing) {
      timing = { session: sessionStartSec(eventHour * 3600), date: dayAt(eventHour * 3600e6) };
      hours.set(eventHour, timing);
    }
    const next = timing.session;
    if (session !== null && next < session) throw Error("hour_order_crosses_session_backwards");
    if (next !== session) {
      await flush(); session = next; profile = new VolumeProfile(next + 1);
      aggregate = new LongAggregate(); dates = new Set(); stats = emptyStats();
    }
    profile!.add(t); count(stats, t); count(totals, t);
    const v = priceTotals.get(t.price) ?? { buy: 0, sell: 0 }; v[t.side] += t.size; priceTotals.set(t.price, v);
    const date = timing.date;
    if (date) { dates.add(date); aggregate.add(t, contract); }
  }
  await flush();
  const prices = [...priceTotals].sort(([a], [b]) => a - b);
  await atomic(path.join(root, "price-volumes.json"), prices);
  const result = { contract, totals, ignoredContractRows, sessions, pricesSha256: await sha(path.join(root, "price-volumes.json")) };
  await atomic(path.join(root, "rebuild.json"), result); return result;
}
