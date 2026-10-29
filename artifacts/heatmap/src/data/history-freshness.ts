import type { TimeRange } from "./cache.ts";

function intersect(a: TimeRange, b: TimeRange): TimeRange[] {
  const range = { fromSec: Math.max(a.fromSec, b.fromSec), toSec: Math.min(a.toSec, b.toSec) };
  return range.fromSec < range.toSec ? [range] : [];
}

function subtract(ranges: readonly TimeRange[], cut: TimeRange): TimeRange[] {
  return ranges.flatMap(range => {
    if (range.toSec <= cut.fromSec || range.fromSec >= cut.toSec) return [range];
    const parts: TimeRange[] = [];
    if (range.fromSec < cut.fromSec) parts.push({ fromSec: range.fromSec, toSec: cut.fromSec });
    if (range.toSec > cut.toSec) parts.push({ fromSec: cut.toSec, toSec: range.toSec });
    return parts;
  });
}

/** One revalidation per cached interval per observed completion, not a polling TTL.
 * Columns/trades remain intact; only the request coverage is invalidated lazily.
 */
export class HistoryFreshness {
  private completion: string | null = null;
  private stale: TimeRange[] = [];

  reset(): void { this.completion = null; this.stale = []; }

  observe(status: Record<string, unknown>, covered: readonly TimeRange[]): boolean {
    const phase = status.phase2a as { backfill?: Record<string, unknown> } | undefined;
    const backfill = phase?.backfill;
    if (!backfill) return false;
    if (backfill.state === "running") {
      this.completion = null;
      return false;
    }
    if (backfill.state !== "complete") return false;
    // These are existing status fields, not a new wire contract. A legacy
    // status without metadata still gets one revalidation, not one per status.
    const key = JSON.stringify([backfill.startedAtUs ?? null, backfill.finishedAtUs ?? null,
      backfill.startSec ?? null, backfill.endSec ?? null]);
    if (key === this.completion) return false;
    this.completion = key;
    const fromSec = backfill.startSec, toSec = backfill.endSec;
    const scope = Number.isSafeInteger(fromSec) && Number.isSafeInteger(toSec) && Number(fromSec) < Number(toSec)
      ? { fromSec: Number(fromSec), toSec: Number(toSec) } : null;
    const changed = covered.flatMap(range => scope ? intersect(range, scope) : [{ ...range }]);
    // A later completion for another window must not forget an unvisited
    // interval made stale by the previous completion.
    const merged: TimeRange[] = [];
    for (const range of [...this.stale, ...changed].sort((a,b)=>a.fromSec-b.fromSec)) {
      const last = merged.at(-1);
      if (last && range.fromSec <= last.toSec) last.toSec = Math.max(last.toSec,range.toSec);
      else merged.push({ ...range });
    }
    this.stale = merged;
    return true;
  }

  visible(view: TimeRange, pending: TimeRange | null): TimeRange[] {
    const ranges = this.stale.flatMap(range => intersect(range, view));
    return pending ? subtract(ranges, pending) : ranges;
  }

  dispatched(range: TimeRange): void { this.stale = subtract(this.stale, range); }

  retain(covered: readonly TimeRange[]): void {
    this.stale = this.stale.flatMap(range => covered.flatMap(other => intersect(range, other)));
  }
}
