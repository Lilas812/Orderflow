export type DrawLayer = "all" | "trades" | "book";

/** Coalesces updates without allowing a book-only update to touch other canvases. */
export class LayerScheduler {
  private queued = false;
  private depth = false;
  private trades = false;
  private book = false;
  private readonly enqueue: (draw: () => void) => void;
  private readonly callbacks: {
    depth: () => void; trades: () => void; book: () => void;
    after: (redrewDepth: boolean, start: number, redrewTrades: boolean) => void;
  };

  constructor(enqueue: (draw: () => void) => void, callbacks: LayerScheduler["callbacks"]) {
    this.enqueue = enqueue; this.callbacks = callbacks;
  }

  request(layer: DrawLayer): void {
    this.depth ||= layer === "all";
    this.trades ||= layer !== "book";
    this.book ||= layer !== "trades";
    if (this.queued) return;
    this.queued = true;
    this.enqueue(() => {
      const start = performance.now();
      const depth = this.depth, trades = this.trades, book = this.book;
      this.queued = this.depth = this.trades = this.book = false;
      // The book must consume the heatmap's updated P99, not calculate its own.
      if (depth) this.callbacks.depth();
      if (book) this.callbacks.book();
      if (trades) this.callbacks.trades();
      this.callbacks.after(depth, start, trades);
    });
  }
}
