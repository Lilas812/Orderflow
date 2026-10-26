import { MAX_CACHE_SECONDS, US_PER_SECOND, type Trade } from "../domain.ts";

export interface TradeCell { secondUs: number; price: number; buy: number; sell: number; }
export interface LastPrice { secondUs: number; price: number; }
interface Bucket {
  records: Map<string, Trade>;
  cells: Map<number, TradeCell>;
  last: Trade;
}
interface Pending {
  fromUs: number; toUs: number; rows: Trade[]; live: Trade[];
}
const secondOf = (us: number) => Math.floor(us / US_PER_SECOND) * US_PER_SECOND;
const identity = (trade: Trade) => `${trade.recvUs}:${trade.seq}`;

/** Exchange seconds and tick integers only. No rendering or socket dependencies. */
export class TradeAggregator {
  private buckets = new Map<number, Bucket>();
  private pending = new Map<number, Pending>();
  private fromUs = -Infinity;
  private toUs = Infinity;
  private count = 0;
  private revisionValue = 0;
  get size(): number { return this.count; }
  get revision(): number { return this.revisionValue; }
  get trades(): readonly Trade[] {
    return [...this.buckets].sort(([a], [b]) => a - b).flatMap(([, bucket]) => [...bucket.records.values()]);
  }

  appendLive(trades: readonly Trade[]): void {
    for (const trade of trades) {
      for (const p of this.pending.values()) {
        if (trade.tsUs >= p.fromUs && trade.tsUs < p.toUs
          && trade.tsUs >= this.fromUs && trade.tsUs < this.toUs) p.live.push(trade);
      }
      this.add(trade);
    }
  }

  beginRange(reqId: number, fromUs: number, toUs: number): void {
    if (!Number.isSafeInteger(fromUs) || !Number.isSafeInteger(toUs)
      || fromUs % US_PER_SECOND || toUs % US_PER_SECOND || fromUs >= toUs) throw new Error("invalid_trade_range");
    this.pending.set(reqId, { fromUs, toUs, rows: [], live: [] });
  }
  appendRangeChunk(reqId: number, trades: readonly Trade[]): void {
    const p = this.pending.get(reqId);
    if (!p) throw new Error("unknown_trade_range");
    for (const trade of trades) {
      if (trade.tsUs < p.fromUs || trade.tsUs >= p.toUs) throw new Error("trade_outside_range");
      if (trade.tsUs >= this.fromUs && trade.tsUs < this.toUs) p.rows.push(trade);
    }
  }
  commitRange(reqId: number): void {
    const p = this.pending.get(reqId);
    if (!p) throw new Error("unknown_trade_range");
    for (const [second, bucket] of this.buckets) {
      if (second >= p.fromUs && second < p.toUs) {
        this.count -= bucket.records.size;
        this.buckets.delete(second);
      }
    }
    // The snapshot and concurrent stream may contain the same delivery identity.
    // Preserve server reception order within each second, including timestamp rollback.
    const rows = p.rows.concat(p.live).sort((a, b) => a.seq - b.seq);
    for (const trade of rows) this.add(trade);
    this.pending.delete(reqId);
    this.revisionValue++;
  }
  abortRange(reqId: number): void { this.pending.delete(reqId); }
  retain(fromUs: number, toUs: number): void {
    if (fromUs > toUs || toUs - fromUs > MAX_CACHE_SECONDS * US_PER_SECOND) throw new Error("invalid_trade_retention");
    if (fromUs === this.fromUs && toUs === this.toUs) return;
    this.fromUs = fromUs; this.toUs = toUs;
    for (const [second, bucket] of this.buckets) {
      if (second < fromUs || second >= toUs) {
        this.count -= bucket.records.size; this.buckets.delete(second); this.revisionValue++;
      }
    }
    for (const p of this.pending.values()) {
      p.rows = p.rows.filter(t => t.tsUs >= fromUs && t.tsUs < toUs);
      p.live = p.live.filter(t => t.tsUs >= fromUs && t.tsUs < toUs);
    }
  }
  cells(fromUs: number, toUs: number, cutoffUs = Infinity): TradeCell[] {
    const result: TradeCell[] = [];
    for (const [second, bucket] of this.buckets) {
      if (second < fromUs || second >= toUs || second > cutoffUs) continue;
      if (second + US_PER_SECOND <= cutoffUs) {
        for (const cell of bucket.cells.values()) result.push({ ...cell });
      } else {
        const partial = new Map<number, TradeCell>();
        for (const t of bucket.records.values()) {
          if (t.tsUs > cutoffUs) continue;
          const cell = partial.get(t.price) ?? { secondUs: second, price: t.price, buy: 0, sell: 0 };
          cell[t.side] += t.size; partial.set(t.price, cell);
        }
        result.push(...partial.values());
      }
    }
    return result;
  }
  lastPrices(fromUs: number, toUs: number, cutoffUs = Infinity): LastPrice[] {
    const seconds = [...this.buckets.keys()].sort((a, b) => a - b);
    let previous: number | null = null, index = 0;
    const first = secondOf(fromUs);
    while (index < seconds.length && seconds[index]! < first) {
      previous = this.buckets.get(seconds[index++]!)!.last.price;
    }
    const result: LastPrice[] = [];
    for (let second = first; second < Math.min(toUs, cutoffUs + 1); second += US_PER_SECOND) {
      const bucket = this.buckets.get(second);
      if (bucket && second + US_PER_SECOND <= cutoffUs) previous = bucket.last.price;
      else if (bucket) for (const t of bucket.records.values()) if (t.tsUs <= cutoffUs) previous = t.price;
      if (previous !== null) result.push({ secondUs: second, price: previous });
    }
    return result;
  }
  latestAt(cutoffUs: number): Trade | null {
    let latest: Trade | null = null;
    let latestSecond = -Infinity;
    for (const [second, bucket] of this.buckets) {
      if (second > cutoffUs || second < latestSecond) continue;
      for (const trade of bucket.records.values()) {
        if (trade.tsUs <= cutoffUs) { latest = trade; latestSecond = second; }
      }
    }
    return latest;
  }
  reset(): void {
    this.buckets.clear(); this.pending.clear(); this.count = 0;
    this.fromUs = -Infinity; this.toUs = Infinity; this.revisionValue++;
  }
  private add(trade: Trade): void {
    if (trade.tsUs < this.fromUs || trade.tsUs >= this.toUs) return;
    const second = secondOf(trade.tsUs), id = identity(trade);
    let bucket = this.buckets.get(second);
    if (!bucket) {
      bucket = { records: new Map(), cells: new Map(), last: trade };
      this.buckets.set(second, bucket);
    }
    if (bucket.records.has(id)) return;
    bucket.records.set(id, trade); bucket.last = trade;
    let cell = bucket.cells.get(trade.price);
    if (!cell) { cell = { secondUs: second, price: trade.price, buy: 0, sell: 0 }; bucket.cells.set(trade.price, cell); }
    cell[trade.side] += trade.size;
    this.count++; this.revisionValue++;
  }
}

/** Independent of the historical retention window and historical range delivery. */
export class CurrentTradeState {
  private value: Trade | null = null;
  get trade(): Trade | null { return this.value; }
  reset(): void { this.value = null; }
  accept(trades: readonly Trade[], cutoffUs = Infinity): void {
    for (const trade of trades) {
      if (trade.tsUs > cutoffUs) continue;
      this.value = trade;
    }
  }
}
