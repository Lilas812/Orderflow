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
  if (!(start < end)) return result;
  // Keep every original edge, including boundaries between overlapping covered
  // intervals. Sweep once rather than allocating ranges.flat() for every edge.
  const events = new Map<number, number>([[start, 0], [end, 0]]);
  let active = 0;
  for (const [x, y] of ranges) {
    for (const edge of [x, y]) if (edge > start && edge < end && !events.has(edge)) events.set(edge, 0);
    if (!(x < y)) continue;
    if (x <= start && start < y) active++;
    if (x > start && x < end) events.set(x, (events.get(x) ?? 0) + 1);
    if (y > start && y < end) events.set(y, (events.get(y) ?? 0) - 1);
  }
  const edges = [...events.keys()].sort((a, b) => a - b);
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i];
    if (i) active += events.get(a)!;
    result.push({ start: a, end: edges[i + 1], covered: active > 0 });
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
  let acceptedRanges: [number, number][] = [];
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
    acceptedRanges.push([start, end]);
    state.apiSeconds += end - start;
  }
  try {
    for (let a = options.start; a < options.end; a += 900) {
      signal.throwIfAborted();
      const b = Math.min(a + 900, options.end);
      await locked(store, async () => {
        signal.throwIfAborted();
        acceptedRanges = [];
        for (const segment of coverageSegments(await store.recordedTickCoverage(), a, b)) {
          if (segment.covered) {
            acceptedRanges.push([segment.start, segment.end]);
            state.fileSeconds += segment.end - segment.start;
          } else await take(segment.start, segment.end);
        }
        // Read once per physical window, not once per tiny coverage island.
        const segments = coverageSegments(acceptedRanges, a, b), before = schedule.now();
        if (acceptedRanges.length) {
          await reader.visit(a, b, t => {
            const sec = t.tsUs / 1e6;
            let lo = 0, hi = segments.length;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (segments[mid].start <= sec) lo = mid + 1; else hi = mid;
            }
            const segment = segments[lo - 1];
            if (segment?.covered && sec < segment.end) { visit(t); state.importedTrades++; }
          });
          state.fileWindows++;
        }
        state.fileReadMs += schedule.now() - before;
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
      const b = Math.min(a + 900, options.end);
      for (const segment of coverageSegments(coverage, a, b)) {
        options.signal.throwIfAborted();
        if (!segment.covered) {
          state.gaps.push({ startSec: segment.start, endSec: segment.end, reason: "not_recorded" });
        }
        // Partially received rows are still useful; missing coverage must remain a gap.
        if (segment.covered) state.fileSeconds += segment.end - segment.start;
      }
      const before = performance.now();
      await reader.visit(a, b, t => { state.importedTrades++; options.visit(t); });
      state.fileReadMs += performance.now() - before; state.fileWindows++;
    }
    return state;
  } finally { await reader.close(); }
}
