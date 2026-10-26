import type { HeatColumn, Trade } from "../domain.ts";
import { MAX_CACHE_SECONDS, US_PER_SECOND } from "../domain.ts";

export interface TimeRange {
  fromSec: number;
  toSec: number;
}

export class ColumnCache {
  private readonly bySecond = new Map<number, HeatColumn>();
  private coverage: TimeRange[] = [];
  private _trades: Trade[] = [];
  private tradeIds = new Set<string>();
  private anchorSec: number | null = null;
  private _latestTimeUs: number | null = null;
  private _latestBook: HeatColumn | null = null;
  private retentionFromSec: number | null = null;
  private retentionToSec: number | null = null;
  private retentionPinned = false;
  private followRetention = false;

  get size(): number { return this.bySecond.size; }
  get latestTimeUs(): number | null { return this._latestTimeUs; }
  get latestBook(): HeatColumn | null { return this._latestBook; }
  get trades(): readonly Trade[] { return this._trades; }

  get columns(): HeatColumn[] {
    return [...this.bySecond.values()].sort((a, b) => a.timeUs - b.timeUs);
  }

  get orderedSeconds(): number[] {
    return [...this.bySecond.keys()].sort((a, b) => a - b);
  }

  addColumn(column: HeatColumn): void {
    this.addColumns([column]);
  }

  addColumns(columns: readonly HeatColumn[]): void {
    for (const column of columns) {
      const second = Math.floor(column.timeUs / US_PER_SECOND);
      this.bySecond.set(second, column);
      if (this._latestTimeUs === null || column.timeUs > this._latestTimeUs) this._latestTimeUs = column.timeUs;
      this.markCovered(second, second + 1);
    }
    if (this.followRetention && this._latestTimeUs !== null) {
      const second = Math.floor(this._latestTimeUs / US_PER_SECOND);
      this.retentionToSec = second + 1;
      this.retentionFromSec = this.retentionToSec - MAX_CACHE_SECONDS;
      this.anchorSec = second;
    }
    this.trim();
  }

  setLatestBook(column: HeatColumn): void {
    this._latestBook = column;
  }

  addTrades(trades: readonly Trade[]): void {
    // Only transport identity is deduplicated. Equal time/price/size/side may be distinct executions.
    // Iterate rather than push(...trades): an initial/range batch can exceed the JS argument limit.
    for (const trade of trades) {
      const id = `${trade.recvUs}:${trade.seq}`;
      if (this.tradeIds.has(id)) continue;
      this.tradeIds.add(id);
      this._trades.push(trade);
    }
    this.trim();
  }

  setRetentionAnchor(viewFromUs: number, viewToUs: number, follow: boolean, latestUs: number | null): void {
    this.retentionPinned = true;
    this.followRetention = follow;
    const from = Math.floor(viewFromUs / US_PER_SECOND);
    const to = Math.ceil(viewToUs / US_PER_SECOND);
    if (follow && latestUs !== null) {
      this.retentionToSec = Math.floor(latestUs / US_PER_SECOND) + 1;
      this.retentionFromSec = this.retentionToSec - MAX_CACHE_SECONDS;
    } else {
      const viewLength = Math.min(MAX_CACHE_SECONDS, Math.max(1, to - from));
      const padding = Math.floor((MAX_CACHE_SECONDS - viewLength) / 2);
      this.retentionFromSec = from - padding;
      this.retentionToSec = this.retentionFromSec + MAX_CACHE_SECONDS;
    }
    this.anchorSec = Math.floor(((this.retentionFromSec ?? from) + (this.retentionToSec ?? to)) / 2);
    this.trim();
  }

  markCovered(fromSec: number, toSec: number): void {
    if (!Number.isInteger(fromSec) || !Number.isInteger(toSec) || fromSec >= toSec) return;
    const last = this.coverage.at(-1);
    if (last && fromSec >= last.fromSec && fromSec <= last.toSec) {
      last.toSec = Math.max(last.toSec, toSec);
      return;
    }
    if (last && fromSec >= last.toSec) {
      if (fromSec === last.toSec) last.toSec = Math.max(last.toSec, toSec);
      else this.coverage.push({ fromSec, toSec });
      this.trimCoverage();
      return;
    }
    this.coverage.push({ fromSec, toSec });
    this.coverage.sort((a, b) => a.fromSec - b.fromSec);
    const merged: TimeRange[] = [];
    for (const range of this.coverage) {
      const last = merged.at(-1);
      if (last && range.fromSec <= last.toSec) last.toSec = Math.max(last.toSec, range.toSec);
      else merged.push({ ...range });
    }
    this.coverage = merged;
    this.trimCoverage();
  }

  getCoverage(): readonly TimeRange[] {
    return this.coverage.map((range) => ({ ...range }));
  }

  removeCoverage(fromSec: number, toSec: number): void {
    this.coverage = this.coverage.flatMap((range) => {
      if (range.toSec <= fromSec || range.fromSec >= toSec) return [range];
      const parts: TimeRange[] = [];
      if (range.fromSec < fromSec) parts.push({ fromSec: range.fromSec, toSec: fromSec });
      if (range.toSec > toSec) parts.push({ fromSec: toSec, toSec: range.toSec });
      return parts;
    });
    this.trimCoverage();
  }

  planMissingRanges(fromSec: number, toSec: number, maxSeconds = 3_600): TimeRange[] {
    const lower = Math.max(fromSec, this.retentionFromSec ?? fromSec);
    const upper = Math.min(toSec, this.retentionToSec ?? toSec);
    if (lower >= upper) return [];
    const uncovered: TimeRange[] = [];
    let cursor = lower;
    for (const range of this.coverage) {
      if (range.toSec <= cursor) continue;
      if (range.fromSec >= upper) break;
      if (range.fromSec > cursor) uncovered.push({ fromSec: cursor, toSec: Math.min(range.fromSec, upper) });
      cursor = Math.max(cursor, range.toSec);
      if (cursor >= upper) break;
    }
    if (cursor < upper) uncovered.push({ fromSec: cursor, toSec: upper });
    return uncovered.flatMap((range) => {
      const chunks: TimeRange[] = [];
      for (let start = range.fromSec; start < range.toSec; start += maxSeconds) {
        chunks.push({ fromSec: start, toSec: Math.min(range.toSec, start + maxSeconds) });
      }
      return chunks;
    });
  }

  reset(): void {
    this.bySecond.clear();
    this.coverage = [];
    this._trades = [];
    this.tradeIds.clear();
    this._latestTimeUs = null;
    this._latestBook = null;
    this.retentionFromSec = null;
    this.retentionToSec = null;
    this.anchorSec = null;
    this.retentionPinned = false;
    this.followRetention = false;
  }

  private trim(): void {
    if (!this.retentionPinned && this._latestTimeUs !== null) {
      const newest = Math.floor(this._latestTimeUs / US_PER_SECOND);
      this.retentionToSec = newest + 1;
      this.retentionFromSec = this.retentionToSec - MAX_CACHE_SECONDS;
      this.anchorSec = newest;
    }
    if (this.anchorSec === null) {
      const newest = this._latestTimeUs === null ? null : Math.floor(this._latestTimeUs / US_PER_SECOND);
      if (newest !== null) {
        this.anchorSec = newest;
        this.retentionToSec = newest + 1;
        this.retentionFromSec = newest + 1 - MAX_CACHE_SECONDS;
      }
    }
    if (this.anchorSec === null || this.retentionFromSec === null || this.retentionToSec === null) return;
    const from = this.retentionFromSec;
    const to = this.retentionToSec;
    for (const second of this.bySecond.keys()) if (second < from || second >= to) this.bySecond.delete(second);
    this._trades = this._trades.filter((trade) => {
      const retain = trade.tsUs >= from * US_PER_SECOND && trade.tsUs < to * US_PER_SECOND;
      if (!retain) this.tradeIds.delete(`${trade.recvUs}:${trade.seq}`);
      return retain;
    });
    this.trimCoverage();
  }

  private trimCoverage(): void {
    if (this.retentionFromSec === null || this.retentionToSec === null) return;
    const from = this.retentionFromSec;
    const to = this.retentionToSec;
    this.coverage = this.coverage.flatMap((range) => {
      const clipped = { fromSec: Math.max(from, range.fromSec), toSec: Math.min(to, range.toSec) };
      return clipped.fromSec < clipped.toSec ? [clipped] : [];
    });
  }
}
