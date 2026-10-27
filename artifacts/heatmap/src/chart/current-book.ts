import type { HeatColumn, Viewport } from "../domain.ts";
import { priceTicksToY } from "./coordinates.ts";

/** One value per physical row, with the same tick-cell coverage as the heatmap. */
export function currentBookRows(book: HeatColumn | null, view: Viewport, height: number): Uint32Array {
  const rows = new Uint32Array(height);
  if (!book) return rows;
  for (const side of [book.bids, book.asks]) {
    for (let i = 0; i < side.prices.length; i++) {
      const price = side.prices[i]!, size = side.sizes[i]!;
      const top = priceTicksToY(price + 0.5, view, height);
      const bottom = priceTicksToY(price - 0.5, view, height);
      const first = Math.max(0, Math.floor(top));
      const last = Math.min(height - 1, Math.ceil(bottom) - 1);
      for (let y = first; y <= last; y++) rows[y] = Math.max(rows[y]!, size);
    }
  }
  return rows;
}

export class CurrentBookRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private samples: number[] = [];
  metrics = { drawMs: 0, meanMs: 0, maxMs: 0, drawCount: 0, paintedRows: 0, timeUs: null as number | null, p99: 1 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Current book Canvas 2D is unavailable");
    this.context = context;
  }

  draw(book: HeatColumn | null, view: Viewport, p99: number): void {
    const start = performance.now();
    const rect = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (rect.width < 1 || rect.height < 1) return;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
    }
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    if (book && book.bids.prices.length && book.asks.prices.length) {
      const top = Math.max(0, priceTicksToY(book.asks.prices[0]! + 0.5, view, height));
      const bottom = Math.min(height, priceTicksToY(book.bids.prices[0]! - 0.5, view, height));
      ctx.fillStyle = "#808080"; ctx.globalAlpha = 0.2;
      if (bottom > top) ctx.fillRect(0, top, width, bottom - top);
      ctx.globalAlpha = 1;
    }
    const rows = currentBookRows(book, view, height);
    ctx.fillStyle = "#8a3cff";
    let paintedRows = 0;
    for (let y = 0; y < height; y++) {
      const size = rows[y]!;
      if (size < 1) continue;
      const length = Math.min(size / p99, 1) * width;
      ctx.fillRect(width - length, y, length, 1);
      paintedRows++;
    }
    const drawMs = performance.now() - start;
    // Same last-30-draw window as the existing frame debug metrics.
    this.samples.push(drawMs);
    this.samples = this.samples.slice(-30);
    this.metrics = { drawMs, meanMs: this.samples.reduce((a, b) => a + b, 0) / this.samples.length,
      maxMs: Math.max(...this.samples), drawCount: this.metrics.drawCount + 1, paintedRows,
      timeUs: book?.timeUs ?? null, p99 };
  }
}
