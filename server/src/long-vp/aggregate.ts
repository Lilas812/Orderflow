import type { Trade } from "../types.ts";
export interface PriceVolume { startUs: number; contract: string; price: number; buy: number; sell: number; }
export interface MinuteBar {
  startUs: number; contract: string; open: number; high: number; low: number; close: number;
  buy: number; sell: number; firstUs: number; lastUs: number;
}
/** Aggregates only, never retains the tick tape. Prices remain integer quarter-point ticks. */
export class LongAggregate {
  readonly volumes = new Map<string, PriceVolume>();
  readonly minutes = new Map<string, MinuteBar>();
  count = 0;
  add(t: Pick<Trade, "tsUs" | "price" | "size" | "side">, contract: string) {
    const startUs = Math.floor(t.tsUs / 1_800_000_000) * 1_800_000_000;
    const key = `${contract}:${startUs}:${t.price}`;
    let v = this.volumes.get(key);
    if (!v) { v = { startUs, contract, price: t.price, buy: 0, sell: 0 }; this.volumes.set(key, v); }
    v[t.side] += t.size;
    const minute = Math.floor(t.tsUs / 60_000_000) * 60_000_000, mk = `${contract}:${minute}`;
    let b = this.minutes.get(mk);
    if (!b) {
      b = { startUs: minute, contract, open: t.price, high: t.price, low: t.price, close: t.price,
        buy: 0, sell: 0, firstUs: t.tsUs, lastUs: t.tsUs };
      this.minutes.set(mk, b);
    }
    b.high = Math.max(b.high, t.price); b.low = Math.min(b.low, t.price);
    if (t.tsUs < b.firstUs) { b.firstUs = t.tsUs; b.open = t.price; }
    if (t.tsUs >= b.lastUs) { b.lastUs = t.tsUs; b.close = t.price; }
    b[t.side] += t.size;
    this.count++;
  }
  snapshot() { return { trades: this.count, volumeRows: this.volumes.size, minuteRows: this.minutes.size }; }
}
