import { setTimeout as delay } from "node:timers/promises";
import type { HistorySource } from "../history/client.ts";
import { WindowUnavailableError, WindowSplitRequired, timeoutSplit } from "../history/client.ts";
import { historyTrades, inWindow } from "../history/decode.ts";
import type { LocalStore } from "../store/local.ts";
import type { Metrics } from "../ingest/metrics.ts";
import type { Trade } from "../types.ts";
import { decodedTrades, inputRows } from "../history/prepared.ts";

export function coverageSegments(ranges: readonly [number, number][], start: number, end: number) {
  const result: { start: number; end: number; covered: boolean }[] = [];
  for (let a = start; a < end;) {
    const covered = ranges.some(([x, y]) => x <= a && a < y);
    const b = Math.min(end, ...ranges.flat().filter(x => x > a && x < end));
    result.push({ start: a, end: b, covered }); a = b;
  }
  return result;
}
export function historyProgress() {
  return { fileSeconds: 0, apiSeconds: 0, fileReadMs: 0, apiMs: 0,
    fileWindows: 0, apiWindows: 0, splitRequests: 0, emptyRetries: 0, importedTrades: 0,
    pendingMaturityUntilUs: null as number | null,
    gaps: [] as { startSec: number; endSec: number; reason: string }[],
    noData: [] as { startSec: number; endSec: number; attempts: number }[] };
}
// Recheck coverage *inside* the common lock: two VP consumers cannot insert the same window.
const queues = new WeakMap<LocalStore, Promise<void>>();
async function locked<T>(store: LocalStore, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(store) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  queues.set(store, current.then(() => {}, () => {}));
  return current;
}
export async function readTradeRange(options: {
  store: LocalStore; source: HistorySource; metrics: Metrics; nextSeq(): number;
  start: number; end: number; signal: AbortSignal; visit(t: Trade): void;
  state?: ReturnType<typeof historyProgress>;
  schedule?: { now(): number; wait(ms: number, signal: AbortSignal): Promise<void> };
}) {
  const { store, source, metrics, nextSeq, signal, visit } = options;
  const state = options.state ?? historyProgress();
  const reader = store.tradeReadSession(signal);
  const schedule = options.schedule ?? { now: Date.now,
    wait: async (ms: number, s: AbortSignal) => { await delay(ms, undefined, { signal: s }); } };
  async function take(start: number, end: number, retry = 0): Promise<void> {
    signal.throwIfAborted();
    const wait = (end + 300) * 1000 - schedule.now();
    if (wait > 0) {
      state.pendingMaturityUntilUs = (end + 300) * 1e6;
      try { await schedule.wait(wait, signal); } finally { state.pendingMaturityUntilUs = null; }
    }
    const before = schedule.now();
    let response;
    try { state.apiWindows++; response = await source.get("tick", start, end, signal); }
    catch (error) {
      if (error instanceof WindowSplitRequired) {
        const middle = timeoutSplit(start, end);
        if (middle !== null) {
          state.splitRequests++;
          await take(start, middle); await take(middle, end); return;
        }
      }
      if (!(error instanceof WindowUnavailableError)) throw error;
      state.gaps.push({ startSec: start, endSec: end, reason: error.reason }); return;
    } finally { state.apiMs += schedule.now() - before; }
    if (response.truncated) {
      if (end - start <= 1) {
        state.gaps.push({ startSec: start, endSec: end, reason: "truncated_at_one_second" }); return;
      }
      state.splitRequests++;
      const middle = start + Math.floor((end - start) / 2);
      await take(start, middle); await take(middle, end); return;
    }
    if (inputRows(response, start, end) === 0) {
      if ((retry > 0 || end >= schedule.now() / 1000 - 600) && retry < 3) {
        state.emptyRetries++; await schedule.wait(120000, signal);
        return take(start, end, retry + 1);
      }
      state.noData.push({ startSec: start, endSec: end, attempts: retry + 1 });
    }
    const trades = decodedTrades(response, start, end, metrics, nextSeq, source.symbol);
    if (trades.length !== inputRows(response, start, end)) {
      state.gaps.push({ startSec: start, endSec: end, reason: "invalid_history_tick" }); return;
    }
    signal.throwIfAborted();
    // Live writes may have completed during the request. Split/recheck rather than overwrite.
    await store.insertUncoveredTradeRange(start, end, trades);
    await reader.visit(start, end, visit);
    state.apiSeconds += end - start;
    state.importedTrades += trades.length;
  }
  try {
    for (let a = options.start; a < options.end; a += 900) {
      signal.throwIfAborted();
      const b = Math.min(a + 900, options.end);
      await locked(store, async () => {
        signal.throwIfAborted();
        for (const segment of coverageSegments(await store.recordedTickCoverage(), a, b)) {
          if (segment.covered) {
            const before = schedule.now();
            await reader.visit(segment.start, segment.end, t => { visit(t); state.importedTrades++; });
            state.fileReadMs += schedule.now() - before; state.fileWindows++;
            state.fileSeconds += segment.end - segment.start;
          } else await take(segment.start, segment.end);
        }
      });
    }
    return state;
  } finally { await reader.close(); }
}

/** Daily snapshots never join the network-fill queue, wait for maturity, or call the API. */
export async function readRecordedTradeRange(options: {
  store: LocalStore; start: number; end: number; signal: AbortSignal; visit(t: Trade): void;
}) {
  const state = historyProgress(), reader = options.store.tradeReadSession(options.signal);
  try {
    const coverage = await options.store.recordedTickCoverage();
    for (let a = options.start; a < options.end; a += 900) {
      for (const segment of coverageSegments(coverage, a, Math.min(a + 900, options.end))) {
        options.signal.throwIfAborted();
        if (!segment.covered) {
          state.gaps.push({ startSec: segment.start, endSec: segment.end, reason: "not_recorded" });
        }
        // Partially received rows are still useful; missing coverage must remain a gap.
        const before = performance.now();
        await reader.visit(segment.start, segment.end, t => { state.importedTrades++; options.visit(t); });
        state.fileReadMs += performance.now() - before;
        state.fileWindows++; if (segment.covered) state.fileSeconds += segment.end - segment.start;
      }
    }
    return state;
  } finally { await reader.close(); }
}
