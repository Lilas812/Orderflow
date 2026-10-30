import type { LocalStore } from "../store/local.ts";
import type { Trade } from "../types.ts";
import { coverageSegments } from "../vp/trade-history.ts";
import { LongAggregate } from "./aggregate.ts";
import { dayBounds } from "./day.ts";

/** No history client, maturity wait, or shared history lock. Include partial saved prints too. */
export async function recordedDay(store: LocalStore, date: string, nowUs: number, signal: AbortSignal,
  contract: (trade: Trade) => string | null) {
  const bounds = dayBounds(date), end = Math.min(bounds.endUs / 1e6, Math.floor(nowUs / 1e6));
  const start = bounds.startUs / 1e6, aggregate = new LongAggregate();
  const coverage = await store.recordedTickCoverage();
  const gaps: [number, number][] = coverageSegments(coverage, start, end)
    .filter(s => !s.covered).map(s => [s.start, s.end]);
  if (end < bounds.endUs / 1e6) gaps.push([end, bounds.endUs / 1e6]);
  const reader = store.tradeReadSession(signal);
  try {
    for (let a = start; a < end; a += 3600) {
      signal.throwIfAborted();
      await reader.visit(a, Math.min(end, a + 3600), t => {
        if (t.tsUs >= end * 1e6) return;
        const identity = contract(t);
        if (identity) aggregate.add(t, identity);
        else gaps.push([Math.floor(t.tsUs / 1e6), Math.min(end, Math.floor(t.tsUs / 1e6) + 1)]);
      });
    }
  } finally { await reader.close(); }
  return { aggregate, gaps };
}
