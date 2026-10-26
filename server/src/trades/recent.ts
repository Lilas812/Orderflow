import type { Trade } from "../types.ts";

export class RecentTrades {
  private rows: Trade[] = [];
  private next = 0;
  readonly capacity = 1000;

  push(trade: Trade) {
    if (this.rows.length < this.capacity) this.rows.push(trade);
    else {
      this.rows[this.next] = trade;
      this.next = (this.next + 1) % this.capacity;
    }
  }

  get size() { return this.rows.length; }

  latest(count = 5): Trade[] {
    const ordered = this.rows.length < this.capacity
      ? this.rows : this.rows.slice(this.next).concat(this.rows.slice(0, this.next));
    return ordered.slice(-count);
  }
}
