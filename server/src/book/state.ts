import type { BookSnapshot } from "../types.ts";

export class BookState {
  private snapshot: BookSnapshot | null = null;

  replace(snapshot: BookSnapshot) { this.snapshot = snapshot; }
  get latest(): BookSnapshot | null { return this.snapshot; }

  summary() {
    const book = this.snapshot;
    if (!book) return null;
    return {
      tsUs: book.tsUs, recvUs: book.recvUs, source: book.source,
      bestBid: book.bids[0] ?? null, bestAsk: book.asks[0] ?? null,
      bidDepth: book.bids.length, askDepth: book.asks.length,
    };
  }
}
