export type VpLevel = [number, number, number];
export class VpState {
  sessionStartSec: number | null = null;
  upToSec = 0;
  loading = true;
  levels = new Map<number, VpLevel>();
  reset() { this.sessionStartSec = null; this.upToSec = 0; this.loading = true; this.levels.clear(); }
  accept(message: Record<string, unknown>) {
    const { sessionStartSec, upToSec, levels, type, loading } = message;
    if (!Number.isSafeInteger(sessionStartSec) || typeof upToSec !== "number" || !Number.isFinite(upToSec)
      || upToSec < (sessionStartSec as number) || !Array.isArray(levels)
      || (type === "vp" && typeof loading !== "boolean")
      || (type === "vpUpdate" && sessionStartSec !== this.sessionStartSec)) throw Error("invalid_vp_message");
    const seen = new Set<number>();
    for (const row of levels) {
      if (!Array.isArray(row) || row.length !== 3 || !row.every(Number.isSafeInteger)
        || row[1] < 0 || row[2] < 0 || seen.has(row[0])) throw Error("invalid_vp_level");
      seen.add(row[0]);
    }
    if (type === "vp") { this.levels.clear(); this.loading = loading as boolean; }
    this.sessionStartSec = sessionStartSec as number; this.upToSec = upToSec;
    for (const row of levels as VpLevel[]) {
      if (row[1] + row[2] > 0) this.levels.set(row[0], row);
      else this.levels.delete(row[0]);
    }
  }
}

/** POC ties use the higher price; adjacent empty ticks have zero volume.
 * Skipping a run of empty upper ticks is equivalent to repeatedly taking the
 * upper zero-volume neighbor on a tie, and avoids loops over huge price gaps.
 */
export function valueArea(levels: Iterable<VpLevel>) {
  const sorted = [...levels].filter(([, b, s]) => b + s > 0).sort(([a], [b]) => a - b);
  let total = 0, maximum = 0, pocIndex = -1;
  sorted.forEach(([, buy, sell], i) => {
    total += buy + sell;
    if (buy + sell >= maximum) { maximum = buy + sell; pocIndex = i; }
  });
  if (pocIndex < 0) return { poc: null, low: null, high: null, total: 0, included: 0 };
  const poc = sorted[pocIndex][0];
  let low = poc, high = poc, included = maximum, down = pocIndex - 1, up = pocIndex + 1;
  while (included < total * 0.7) {
    const lower = sorted[down], upper = sorted[up];
    const lowerSize = lower?.[0] === low - 1 ? lower[1] + lower[2] : 0;
    const upperSize = upper?.[0] === high + 1 ? upper[1] + upper[2] : 0;
    if (upper && (!lower || upperSize >= lowerSize)) {
      high = upper[0]; included += upper[1] + upper[2]; up++;
    } else if (lower) {
      low = lower[0]; included += lower[1] + lower[2]; down--;
    } else break;
  }
  return { poc, low, high, total, included };
}
