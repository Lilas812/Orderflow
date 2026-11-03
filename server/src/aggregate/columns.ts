import type { BookLevel, BookSnapshot } from "../types.ts";

export interface Column {
  tsSec: number;
  source: "live" | "history";
  bids: BookLevel[];
  asks: BookLevel[];
}

/** Only accepted, normalized snapshots enter here. No filling of absent seconds. */
export class ColumnAggregator {
  private pending: BookSnapshot | null = null;
  private finalized = -1;
  private emit: (column: Column) => void;
  constructor(emit: (column: Column) => void) { this.emit = emit; }
  get pendingSecond(): number | null { return this.pending ? Math.floor(this.pending.tsUs / 1_000_000) : null; }

  accept(book: BookSnapshot) {
    const second = Math.floor(book.tsUs / 1_000_000);
    if (second <= this.finalized) return false; // A timed-out column cannot be changed retroactively.
    if (this.pending && second > Math.floor(this.pending.tsUs / 1_000_000)) this.finish();
    if (!this.pending || book.tsUs >= this.pending.tsUs) this.pending = book;
    return true;
  }

  expire(nowUs: number) {
    if (this.pending && nowUs >= (Math.floor(this.pending.tsUs / 1_000_000) + 3) * 1_000_000) this.finish();
  }

  /** History input is complete for a half-open window, so its last second is final. */
  finish() {
    if (!this.pending) return;
    const book = this.pending;
    this.pending = null;
    const tsSec = Math.floor(book.tsUs / 1_000_000);
    this.finalized = tsSec;
    this.emit({ tsSec, source: book.source, bids: book.bids, asks: book.asks });
  }
}
