export type DrawLayer = "all" | "trades" | "book" | "big";

/** Coalesces updates without allowing a book-only update to touch other canvases. */
export class LayerScheduler {
  private queued = false;
  private depth = false;
  private trades = false;
  private book = false;
  private big = false;
  private readonly enqueue: (draw: () => void) => void;
  private readonly callbacks: {
    depth: () => void; trades: () => void; book: () => void;
    big?: () => void;
    after: (redrewDepth: boolean, start: number, redrewTrades: boolean) => void;
  };

  constructor(enqueue: (draw: () => void) => void, callbacks: LayerScheduler["callbacks"]) {
    this.enqueue = enqueue; this.callbacks = callbacks;
  }

  request(layer: DrawLayer): void {
    this.depth ||= layer === "all";
    this.trades ||= layer === "all" || layer === "trades";
    this.book ||= layer === "all" || layer === "book";
    this.big ||= layer === "all" || layer === "big";
    if (this.queued) return;
    this.queued = true;
    this.enqueue(() => {
      const start = performance.now();
      const depth = this.depth, trades = this.trades, book = this.book, big = this.big;
      this.queued = this.depth = this.trades = this.book = this.big = false;
      // The book must consume the heatmap's updated P99, not calculate its own.
      if (depth) this.callbacks.depth();
      if (book) this.callbacks.book();
      if (trades) this.callbacks.trades();
      if (big) this.callbacks.big?.();
      this.callbacks.after(depth, start, trades);
    });
  }
}
