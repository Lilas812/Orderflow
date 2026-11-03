import { setImmediate } from "node:timers/promises";
import type { Coverage, Kind, Range } from "./local.ts";

/** Sorted, merged half-open ranges. No per-query full-history scan. */
export function firstEndingAfter(input: readonly Range[], second: number) {
  let lo = 0, hi = input.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (input[mid][1] <= second) lo = mid + 1; else hi = mid;
  }
  return lo;
}
export function containsSecond(input: readonly Range[], second: number) {
  const r = input[firstEndingAfter(input, second)];
  return !!r && r[0] <= second;
}
export function overlapsRange(input: readonly Range[], start: number, end: number) {
  const r = input[firstEndingAfter(input, start)];
  return !!r && r[0] < end;
}
export function includesRanges(input: readonly Range[], candidate: readonly Range[]) {
  return candidate.every(([a, b]) => {
    const r = input[firstEndingAfter(input, a)];
    return !!r && r[0] <= a && r[1] >= b;
  });
}
export function clipRanges(input: readonly Range[], start: number, end: number): Range[] {
  const out: Range[] = [];
  for (let i = firstEndingAfter(input, start); i < input.length && input[i][0] < end; i++)
    out.push([Math.max(start, input[i][0]), Math.min(end, input[i][1])]);
  return out;
}
export function* coveredHours(input: readonly Range[]) {
  let previous = -Infinity;
  for (const [a, b] of input) {
    for (let h = Math.max(Math.floor(a / 3600) * 3600, previous + 3600); h < b; h += 3600) {
      previous = h; yield h;
    }
  }
}
/** Keep CPU slices small, including all-durable (otherwise await-free) runs. */
export function sliceBudget() {
  let at = performance.now();
  return async () => {
    if (performance.now() - at >= 8) { await setImmediate(); at = performance.now(); }
  };
}
export async function durableHours(index: Coverage) {
  const result: Record<Kind, Set<number>> = { book: new Set(), tick: new Set() };
  const checkpoint = sliceBudget();
  for (const kind of ["book", "tick"] as const) for (const h of coveredHours(index[kind])) {
    result[kind].add(h); await checkpoint();
  }
  return result;
}
/** Only INTERNAL holes <=30s with complete book evidence. Never extend edges. */
export async function compactTickGaps(index: Coverage, durable?: Set<number>): Promise<Coverage> {
  const tick: Range[] = [], checkpoint = sliceBudget();
  for (const [a, b] of index.tick) {
    const last = tick.at(-1), gap = last ? a - last[1] : Infinity;
    const book = last ? index.book[firstEndingAfter(index.book, last[1])] : undefined;
    let allowed = gap > 0 && gap <= 30 && !!book && book[0] <= last![1] && book[1] >= a;
    if (allowed && durable) {
      for (let h = Math.floor(last![1] / 3600) * 3600; h < a; h += 3600)
        if (!durable.has(h)) { allowed = false; break; }
    }
    if (allowed) last![1] = b; else tick.push([a, b]);
    await checkpoint();
  }
  return { ...index, book: index.book.map(([a, b]) => [a, b]), tick, tickGapCompactionVersion: 1 };
}
