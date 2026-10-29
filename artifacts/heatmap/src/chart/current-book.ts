import type { HeatColumn, Viewport } from "../domain.ts";
import { priceTicksToY, timeUsToX } from "./coordinates.ts";
import { colorize } from "./renderer.ts";
import { glowBookColumn } from "./glow.ts";
import { BOOK_NUMBER_RIGHT_INSET, bookBandEnd, bookNumberFont, bookNumberRows, type BookNumberRow } from "./book-numbers.ts";

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

export interface CurrentBookOptions { lower?: number; gamma?: number; style?: "glow" | "block"; }

/** Phase 14: colour band + numeric quantities (no bars; bookBarPct / bookBarOpacity are unused). */
export class CurrentBookRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private scratch: HTMLCanvasElement | null = null;
  private samples: number[] = [];
  metrics = { drawMs: 0, meanMs: 0, maxMs: 0, drawCount: 0, paintedRows: 0, timeUs: null as number | null, p99: 1,
    bandStart: null as number | null, bandEnd: null as number | null, numbers: 0, groupTicks: 1,
    style: "glow" as "glow" | "block" };
  lastNumbers: BookNumberRow[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Current book Canvas 2D is unavailable");
    this.context = context;
  }

  draw(book: HeatColumn | null, view: Viewport, p99: number, rightEdgeUs: number | null = null,
    options: CurrentBookOptions = {}): void {
    const lower = options.lower ?? 0, gamma = options.gamma ?? 1, style = options.style ?? "glow";
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
    const scale = { upper: p99, lower, gamma };
    const numbers = bookNumberRows(book, view, rect.height, scale);
    // Measure each drawn number with its own (bold or regular) font: the band stops 5px before the widest.
    let widest = 0;
    for (const row of numbers) {
      ctx.font = bookNumberFont(row.bold);
      widest = Math.max(widest, ctx.measureText(String(row.total)).width); // CSS px: font is 10 CSS px
    }
    const bandStart = book ? bookBandStart(rightEdgeUs, view, width) : null;
    const bandEnd = Math.round(bookBandEnd(rect.width, widest) * dpr);
    let paintedRows = 0;
    if (bandStart !== null && bandEnd > bandStart) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000000";
      ctx.fillRect(bandStart, 0, bandEnd - bandStart, height);
      if (style === "block") {
        const rows = currentBookRows(book, view, height);
        const colors = colorize(rows, p99, undefined, lower, gamma);
        for (let y = 0; y < height; y++) {
          if (rows[y]! < 1 || rows[y]! <= lower) continue;
          const i = y * 4;
          ctx.fillStyle = `rgb(${colors[i]},${colors[i + 1]},${colors[i + 2]})`;
          ctx.fillRect(bandStart, y, bandEnd - bandStart, 1);
          paintedRows++;
        }
      } else {
        const column = glowBookColumn(book, view, height, scale);
        this.scratch ??= document.createElement("canvas");
        this.scratch.width = 1; this.scratch.height = column.rgba.length / 4;
        const sctx = this.scratch.getContext("2d")!;
        sctx.putImageData(new ImageData(column.rgba as Uint8ClampedArray<ArrayBuffer>, 1, column.rgba.length / 4), 0, 0);
        const yTop = priceTicksToY(column.topPrice + 0.5, view, height);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.scratch, 0, 0, 1, column.rgba.length / 4, bandStart, yTop, bandEnd - bandStart,
          column.priceCount * height / view.priceSpanTicks);
        paintedRows = height;
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    numbers.forEach(row => {
      ctx.font = bookNumberFont(row.bold);
      ctx.fillStyle = row.color;
      ctx.fillText(String(row.total), rect.width - BOOK_NUMBER_RIGHT_INSET, row.y);
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lastNumbers = numbers;
    const drawMs = performance.now() - start;
    this.samples.push(drawMs);
    this.samples = this.samples.slice(-30);
    this.metrics = { drawMs, meanMs: this.samples.reduce((a, b) => a + b, 0) / this.samples.length,
      maxMs: Math.max(...this.samples), drawCount: this.metrics.drawCount + 1, paintedRows,
      timeUs: book?.timeUs ?? null, p99, bandStart, bandEnd: bandStart === null ? null : bandEnd,
      numbers: numbers.length, groupTicks: numbers[0]?.ticks ?? 1, style };
  }
}
