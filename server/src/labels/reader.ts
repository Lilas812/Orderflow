import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { finished } from "node:stream/promises";
import type { LabelHourInput } from "./input.ts";
import { columnFileRange, tradeFileEntries } from "../store/records.ts";
import { DayData, valueArea, put, boardFeatures, type FeatureResult } from "./features.ts";
import type { TurningLabel } from "../../../lib/market/labels.ts";
import type { Trade } from "../types.ts";
import type { Column } from "../aggregate/columns.ts";

export type Lease = <T>(hour: number, work: (input: LabelHourInput) => Promise<T>) => Promise<T>;
async function hash(file: string) {
  const stream = createReadStream(file), h = createHash("sha256");
  try { for await (const b of stream) h.update(b); return h.digest("hex"); }
  finally { stream.destroy(); await finished(stream).catch(() => {}); }
}
export function immutableLease(input: Lease) {
  const versions = new Map<number, { book: string | null; tick: string | null; coverage: string }>();
  const lease: Lease = (hour, work) => input(hour, async source => {
    const signature = {
      book: source.book ? await hash(source.book) : null,
      tick: source.tick ? await hash(source.tick) : null,
      coverage: createHash("sha256").update(JSON.stringify([source.bookCoverage, source.tickCoverage])).digest("hex"),
    };
    const previous = versions.get(hour);
    if (previous && JSON.stringify(previous) !== JSON.stringify(signature)) throw Error("labels_input_changed_retry");
    versions.set(hour, signature); return work(source);
  });
  return { lease, versions };
}
const hourOf = (t: number) => Math.floor(t / 3600) * 3600;
export async function readDay(start: number, lease: Lease) {
  const data = new DayData(start);
  for (let hour = hourOf(data.start); hour < data.end; hour += 3600) {
    await lease(hour, async input => {
      for (const [a, b] of input.tickCoverage) data.cover(a, b);
      if (input.tick) for await (const { trade } of tradeFileEntries(input.tick)) data.add(trade);
    });
  }
  data.finish(); return data;
}
/** Stream full-session VP in timestamp-second order with only one hour's price sums.
 * Equal and out-of-order trades are never deduplicated. No post-target second is included.
 */
export async function enrichProfiles(labels: TurningLabel[], data: DayData,
  results: Map<string, FeatureResult>, lease: Lease) {
  const targets = labels.filter(l => data.complete(data.session, l.tsSec)
    && data.identity(data.session, l.tsSec) !== "MIXED").sort((a, b) => a.tsSec - b.tsSec);
  const profile = new Map<number, number>();
  let index = 0;
  for (let hour = hourOf(data.session); index < targets.length; hour += 3600) {
    const seconds = new Map<number, Map<number, number>>();
    await lease(hour, async input => {
      if (input.tick) for await (const { trade: t } of tradeFileEntries(input.tick)) {
        const second = Math.floor(t.tsUs / 1e6);
        if (second < data.session || second >= targets.at(-1)!.tsSec) continue;
        let levels = seconds.get(second); if (!levels) seconds.set(second, levels = new Map());
        levels.set(t.price, (levels.get(t.price) ?? 0) + t.size);
      }
    });
    const emit = (until: number) => {
      while (index < targets.length && targets[index]!.tsSec <= until) {
        const label = targets[index++]!, result = results.get(label.id)!, va = valueArea(profile);
        for (const name of ["poc", "vah", "val"] as const)
          put(result, `distance_${name}`, va ? label.priceTicks - va[name] : null, "empty_profile");
      }
    };
    for (const second of [...seconds.keys()].sort((a, b) => a - b)) {
      emit(second);
      for (const [price, size] of seconds.get(second)!) profile.set(price, (profile.get(price) ?? 0) + size);
    }
    emit(hour + 3600);
  }
}
export async function enrichBoards(labels: TurningLabel[], data: DayData,
  results: Map<string, FeatureResult>, lease: Lease) {
  const target = new Map<number, TurningLabel[]>();
  const neededHours = new Set<number>();
  for (const l of labels) {
    const a = target.get(l.tsSec - 1) ?? []; a.push(l); target.set(l.tsSec - 1, a);
    for (let h = hourOf(l.tsSec - 61); h <= hourOf(l.tsSec - 1); h += 3600) neededHours.add(h);
  }
  const ring = new Map<number, Column>(), qty = new Map<number, Map<number, number>>();
  for (const hour of [...neededHours].sort((a, b) => a - b)) {
    await lease(hour, async input => {
      const needed = (s: number) => labels.some(l => s >= l.tsSec - 61 && s < l.tsSec);
      if (input.tick) for await (const { trade: t } of tradeFileEntries(input.tick)) {
        const s = Math.floor(t.tsUs / 1e6); if (!needed(s)) continue;
        let prices = qty.get(s); if (!prices) qty.set(s, prices = new Map());
        prices.set(t.price, (prices.get(t.price) ?? 0) + t.size);
      }
      if (input.book) for await (const c of columnFileRange(input.book, hour, hour + 3600)) {
        if (!needed(c.tsSec) || !input.bookCoverage.some(([a, b]) => c.tsSec >= a && c.tsSec < b)) continue;
        ring.set(c.tsSec, c);
        for (const s of ring.keys()) if (s < c.tsSec - 60) ring.delete(s);
        for (const label of target.get(c.tsSec) ?? [])
          boardFeatures(label, ring, qty, data.complete(label.tsSec - 60, label.tsSec), results.get(label.id)!);
      }
    });
    for (const s of qty.keys()) if (s < hour + 3600 - 61) qty.delete(s);
  }
}
/** Exact event-order divergence. Bound the temporary sort, not the exported quantities.
 * If a 300-second sort would exceed its resource budget, only this feature is unavailable.
 */
export async function enrichDivergence(label: TurningLabel, data: DayData, out: FeatureResult, lease: Lease) {
  const t = label.tsSec;
  if (!data.complete(t - 600, t) || data.identity(t - 600, t) === "MIXED") return;
  let cvd = 0;
  const halves = [{ h: -Infinity, hc: 0, l: Infinity, lc: 0 }, { h: -Infinity, hc: 0, l: Infinity, lc: 0 }];
  for (let a = t - 600; a < t; a += 300) {
    const trades: Trade[] = [];
    let budget = false;
    for (let hour = hourOf(a); hour < a + 300; hour += 3600) {
      await lease(hour, async input => {
        if (input.tick) for await (const { trade } of tradeFileEntries(input.tick)) {
          if (trade.tsUs < a * 1e6 || trade.tsUs >= (a + 300) * 1e6) continue;
          if (trades.length === 100_000) { budget = true; break; }
          trades.push(trade);
        }
      });
      if (budget) break;
    }
    if (budget) { put(out, "cvd_divergence", null, "event_order_sort_budget"); return; }
    trades.sort((a, b) => a.tsUs - b.tsUs || a.seq - b.seq);
    const half = halves[a < t - 300 ? 0 : 1]!;
    for (const trade of trades) {
      cvd += trade.side === "buy" ? trade.size : trade.side === "sell" ? -trade.size : 0;
      if (trade.price > half.h) { half.h = trade.price; half.hc = cvd; }
      if (trade.price < half.l) { half.l = trade.price; half.lc = cvd; }
    }
  }
  const [a, b] = halves as [typeof halves[number], typeof halves[number]];
  const bearish = b.h > a.h && b.hc <= a.hc, bullish = b.l < a.l && b.lc >= a.lc;
  put(out, "cvd_divergence", !Number.isFinite(a.h + b.h) || bearish && bullish ? null
    : bearish ? 1 : bullish ? -1 : 0, "no_trades_or_both_divergences");
}
