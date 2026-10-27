export type DrawLayer = "all" | "heat" | "trades" | "book" | "big" | "vp" | "delta";

/** Coalesces updates without allowing a book-only update to touch other canvases. */
export class LayerScheduler {
  private queued = false;
  private depth = false;
  private trades = false;
  private book = false;
  private big = false;
  private vp = false;
  private delta = false;
  private axes = false;
  private readonly enqueue: (draw: () => void) => void;
  private readonly callbacks: {
    depth: (redrawAxes: boolean) => void; trades: () => void; book: () => void;
    big?: () => void;
    vp?: () => void;
    delta?: () => void;
    after: (redrewDepth: boolean, start: number, redrewTrades: boolean) => void;
  };

  constructor(enqueue: (draw: () => void) => void, callbacks: LayerScheduler["callbacks"]) {
    this.enqueue = enqueue; this.callbacks = callbacks;
  }

  request(layer: DrawLayer): void {
    this.depth ||= layer === "all" || layer === "heat";
    this.axes ||= layer === "all";
    this.trades ||= layer === "all" || layer === "trades";
    this.book ||= layer === "all" || layer === "book" || layer === "heat";
    this.big ||= layer === "all" || layer === "big";
    this.vp ||= layer === "all" || layer === "vp";
    this.delta ||= layer === "all" || layer === "delta";
    if (this.queued) return;
    this.queued = true;
    this.enqueue(() => {
      const start = performance.now();
      const depth = this.depth, trades = this.trades, book = this.book, big = this.big, vp = this.vp;
      const delta = this.delta;
      const axes = this.axes;
      this.queued = this.depth = this.trades = this.book = this.big = this.vp = false;
      this.delta = false;
      this.axes = false;
      // The book must consume the heatmap's updated P99, not calculate its own.
      if (depth) this.callbacks.depth(axes);
      if (book) this.callbacks.book();
      if (trades) this.callbacks.trades();
      if (big) this.callbacks.big?.();
      if (vp) this.callbacks.vp?.();
      if (delta) this.callbacks.delta?.();
      this.callbacks.after(depth, start, trades);
    });
  }
}
