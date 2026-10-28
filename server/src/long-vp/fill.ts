import { LongAggregate } from "./aggregate.ts";
import type { Roll, LongSource } from "./rest.ts";
import type { Gap, Interval } from "./store.ts";
import { setImmediate as yieldLoop } from "node:timers/promises";

export function missing(startUs: number, endUs: number, coverage: Interval[]): Interval[] {
  const result: Interval[] = [];
  let cursor = startUs;
  for (const c of [...coverage].sort((a, b) => a.startUs - b.startUs)) {
    if (c.endUs <= cursor || c.startUs >= endUs) continue;
    if (c.startUs > cursor) result.push({ startUs: cursor, endUs: Math.min(c.startUs, endUs) });
    cursor = Math.max(cursor, c.endUs);
  }
  if (cursor < endUs) result.push({ startUs: cursor, endUs });
  return result;
}
export function contractAt(us: number, rolls: Roll[]) {
  return [...rolls].sort((a, b) => b.sinceUs - a.sinceUs).find(r => r.sinceUs <= us)?.contract ?? null;
}
export function mergeCoverage(rows: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const row of [...rows].sort((a, b) => a.startUs - b.startUs)) {
    const last = merged.at(-1);
    if (last && last.endUs >= row.startUs) last.endUs = Math.max(last.endUs, row.endUs);
    else merged.push({ ...row });
  }
  return merged;
}
/** Fill missing intervals sequentially. A truncated response is discarded, not partially counted. */
export async function fill(source: LongSource, aggregate: LongAggregate, ranges: Interval[], rolls: Roll[],
  signal: AbortSignal, onWindow: (interval: Interval, gap: Gap | null) => void = () => {}) {
  const coverage: Interval[] = [], gaps: Gap[] = [];
  async function window(startUs: number, endUs: number): Promise<void> {
    signal.throwIfAborted();
    const interval = { startUs, endUs };
    const fail = (reason: string) => { const g = { ...interval, reason }; gaps.push(g); onWindow(interval, g); };
    if (!contractAt(startUs, rolls)) { fail("unverified_contract"); return; }
    try {
      const page = await source.ticks(startUs, endUs, signal);
      if (page.truncated) {
        // REST boundaries have whole-second precision; never split within one second.
        const middle = Math.floor((startUs + endUs) / 2 / 1e6) * 1e6;
        if (middle <= startUs || middle >= endUs) { fail("truncated_single_second"); return; }
        await window(startUs, middle); await window(middle, endUs); return;
      }
      for (const [index, t] of page.trades.entries()) {
        if (t.tsUs < startUs || t.tsUs >= endUs) continue;
        const contract = contractAt(t.tsUs, rolls);
        if (!contract) throw Error("unverified_contract");
        aggregate.add(t, contract);
        if (index % 1000 === 999) { await yieldLoop(); signal.throwIfAborted(); }
      }
      coverage.push(interval); onWindow(interval, null);
    } catch (e) {
      signal.throwIfAborted();
      const reason = e instanceof Error && /^long_rest_|^unverified_contract/.test(e.message) ? e.message : "long_rest_window_failed";
      // Authentication is not a missing market interval. Stop and expose a fatal error.
      if (reason === "long_rest_auth_failed") throw Error(reason);
      fail(reason);
    }
  }
  for (const r of ranges) {
    // Contract transitions can fall inside a 30-minute bucket or a REST second.
    // Exact half-open filtering keeps both contracts separate without erasing legitimate prints.
    const boundaries = [r.startUs, ...rolls.map(x => x.sinceUs)
      .filter(x => x > r.startUs && x < r.endUs), r.endUs].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++)
      for (let a = boundaries[i]; a < boundaries[i + 1]; a += 900_000_000)
        await window(a, Math.min(a + 900_000_000, boundaries[i + 1]));
  }
  return { coverage: mergeCoverage(coverage), gaps };
}
