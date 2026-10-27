import type { HeatColumn, Viewport } from "../domain.ts";
import { priceTicksToY, timeUsToX } from "./coordinates.ts";
import { colorize } from "./renderer.ts";

/** Confirmed column's right edge, not the timestamp of the provisional book. */
export function bookBandStart(rightEdgeUs: number | null, view: Viewport, width: number): number | null {
  if (rightEdgeUs === null) return null;
  const x = Math.max(0, Math.ceil(timeUsToX(rightEdgeUs, view, width)));
  return x < width ? x : null;
}

/** One value per physical row, with the same tick-cell coverage as the heatmap. */
export function currentBookRows(book: HeatColumn | null, view: Viewport, height: number, sellRows?: Uint8Array): Uint32Array {
  const rows = new Uint32Array(height);
  sellRows?.fill(0);
  if (!book) return rows;
  for (const side of [book.bids, book.asks]) {
    for (let i = 0; i < side.prices.length; i++) {
      const price = side.prices[i]!, size = side.sizes[i]!;
      const top = priceTicksToY(price + 0.5, view, height);
      const bottom = priceTicksToY(price - 0.5, view, height);
      const first = Math.max(0, Math.floor(top));
      const last = Math.min(height - 1, Math.ceil(bottom) - 1);
      for (let y = first; y <= last; y++) {
        // User decision: greatest individual level, with ask winning a tie.
        if (size > rows[y]! || (side === book.asks && size > 0 && size === rows[y]!)) {
          rows[y] = size;
          if (sellRows) sellRows[y] = side === book.asks ? 1 : 0;
        }
      }
    }
  }
  return rows;
}

export class CurrentBookRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private samples: number[] = [];
  metrics = { drawMs: 0, meanMs: 0, maxMs: 0, drawCount: 0, paintedRows: 0, timeUs: null as number | null, p99: 1,
    bandStart: null as number | null };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Current book Canvas 2D is unavailable");
    this.context = context;
  }

  draw(book: HeatColumn | null, view: Viewport, p99: number, rightEdgeUs: number | null = null,
    barPct = 10, opacity = .5): void {
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
    const sellRows = new Uint8Array(height);
    const rows = currentBookRows(book, view, height, sellRows);
    const bandStart = book ? bookBandStart(rightEdgeUs, view, width) : null;
    // Use the very same LUT, saturation and rounding as historical heatmap cells.
    if (bandStart !== null) {
      const colors = colorize(rows, p99);
      ctx.globalAlpha = 1;
      for (let y = 0; y < height; y++) {
        if (rows[y]! < 1) continue;
        const i = y * 4;
        ctx.fillStyle = `rgb(${colors[i]},${colors[i + 1]},${colors[i + 2]})`;
        ctx.fillRect(bandStart, y, width - bandStart, 1);
      }
    }
    ctx.globalAlpha = opacity;
    let paintedRows = 0;
    for (let y = 0; y < height; y++) {
      const size = rows[y]!;
      if (size < 1) continue;
      ctx.fillStyle = sellRows[y] ? "#8a3cff" : "#d9d9d9";
      const length = Math.min(size / p99, 1) * width * barPct / 100;
      ctx.fillRect(width - length, y, length, 1);
      paintedRows++;
    }
    ctx.globalAlpha = 1;
    const drawMs = performance.now() - start;
    // Same last-30-draw window as the existing frame debug metrics.
    this.samples.push(drawMs);
    this.samples = this.samples.slice(-30);
    this.metrics = { drawMs, meanMs: this.samples.reduce((a, b) => a + b, 0) / this.samples.length,
      maxMs: Math.max(...this.samples), drawCount: this.metrics.drawCount + 1, paintedRows,
      timeUs: book?.timeUs ?? null, p99, bandStart };
  }
}
