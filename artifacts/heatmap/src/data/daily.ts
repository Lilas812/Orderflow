import type { MarketSymbol } from "../../../../lib/market/instruments.ts";
import type { DailyPoint } from "../chart/daily-renderer.ts";

type Row = [number, number, number, number, number];
interface Prefix extends DailyPoint { buy: number; sell: number; weighted: number; unknown: number; }
/** Authoritative absolute second counters, NOT another copy of raw trades. */
export class DailyState {
  readonly symbol: MarketSymbol;
  private rows = new Map<number, Row>();
  private times: number[] = [];
  private prefix: Prefix[] = [];
  private dirty = Infinity;
  private revision = -1;
  historyRevision = 0;
  sessionStartSec: number | null = null;
  upToUs = 0;
  loading = true;
  available = false;
  constructor(symbol: MarketSymbol) { this.symbol = symbol; }
  reset() {
    this.rows.clear(); this.times = []; this.prefix = []; this.dirty = Infinity;
    this.revision = -1; this.sessionStartSec = null; this.upToUs = 0;
    this.loading = true; this.available = false; this.historyRevision++;
  }
  accept(m: Record<string, unknown>): boolean {
    if (m.symbol !== this.symbol || !Number.isSafeInteger(m.sessionStartSec)
      || !Number.isSafeInteger(m.revision) || !Number.isSafeInteger(m.upToUs)
      || typeof m.loading !== "boolean" || typeof m.full !== "boolean" || !Array.isArray(m.points)) return false;
    const start = m.sessionStartSec as number, revision = m.revision as number, upToUs = m.upToUs as number;
    if (this.sessionStartSec !== null && start < this.sessionStartSec) return false;
    if (start === this.sessionStartSec && revision < this.revision) return false;
    const rows: Row[] = [];
    for (const raw of m.points) {
      if (!Array.isArray(raw) || raw.length !== 5 || !raw.every(Number.isFinite) || !Number.isSafeInteger(raw[0])) return false;
      const r = raw as Row;
      if (r[0] < start * 1e6 || r[0] % 1e6 || r.slice(1).some(v => v < 0)
        || r[0] > upToUs || r[4] > r[1] + r[2]) return false;
      rows.push(r);
    }
    if (m.full || start !== this.sessionStartSec) {
      this.rows.clear(); this.times = []; this.prefix = []; this.dirty = 0; this.historyRevision++;
    }
    const priorLast = this.times.at(-1) ?? -Infinity;
    for (const r of rows) {
      let lo = 0, hi = this.times.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.times[mid]! < r[0]) lo = mid + 1; else hi = mid; }
      if (this.times[lo] !== r[0]) this.times.splice(lo, 0, r[0]);
      this.rows.set(r[0], r); this.dirty = Math.min(this.dirty, lo);
      if (r[0] < priorLast) this.historyRevision++;
    }
    this.available = true; this.sessionStartSec = start; this.revision = revision;
    this.loading = m.loading; this.upToUs = upToUs;
    return true;
  }
  /** Rebuild only changed suffix, once per draw after coalescing batches. */
  series(): readonly DailyPoint[] {
    for (let i = this.dirty; i < this.times.length; i++) {
      const r = this.rows.get(this.times[i]!)!, p = this.prefix[i - 1];
      const buy = (p?.buy ?? 0) + r[1], sell = (p?.sell ?? 0) + r[2];
      const weighted = (p?.weighted ?? 0) + r[3], total = buy + sell;
      this.prefix[i] = { timeUs: r[0], buy, sell, weighted, unknown: (p?.unknown ?? 0) + r[4],
        cvd: buy - sell, vwap: total ? weighted / total : 0 };
    }
    this.dirty = Infinity; this.prefix.length = this.times.length;
    return this.prefix;
  }
  snapshot() {
    const p = this.prefix.at(-1);
    return { available: this.available, sessionStartSec: this.sessionStartSec, loading: this.loading,
      derivedPending: this.dirty !== Infinity,
      upToUs: this.upToUs, total: (p?.buy ?? 0) + (p?.sell ?? 0), cvd: p?.cvd ?? 0,
      vwapTicks: p?.vwap ?? null, unknownQuantity: p?.unknown ?? 0, points: this.times.length, adjusted: false };
  }
}
