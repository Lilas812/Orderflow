import type { HeatColumn, Viewport } from "../domain.ts";
import { backgroundDpr, priceTicksToY, timeUsToX } from "./coordinates.ts";
import { colorize } from "./renderer.ts";
import { glowBookColumn, glowK, glowRadius, wideLines, type BookGlowBuffers } from "./glow.ts";
import type { GpuBandRequest } from "./gpu-heatmap.ts";
import { BOOK_NUMBER_RIGHT_INSET, bookBandEnd, bookNumberFont, bookNumberRows, type BookNumberRow } from "./book-numbers.ts";

/** Confirmed column's right edge, not the timestamp of the provisional book. */
export function bookBandStart(rightEdgeUs: number | null, view: Viewport, width: number): number | null {
  if (rightEdgeUs === null) return null;
  const x = Math.max(0, Math.ceil(timeUsToX(rightEdgeUs, view, width)));
  return x < width ? x : null;
}

/** One value per physical row, with the same tick-cell coverage as the heatmap. */
export function currentBookRows(book: HeatColumn | null, view: Viewport, height: number, sellRows?: Uint8Array,
  reuse?: Uint32Array): Uint32Array {
  const rows = reuse?.length === height ? reuse : new Uint32Array(height); rows.fill(0);
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
  private band: HTMLCanvasElement | null = null;
  private rows: Uint32Array = new Uint32Array(0);
  private colors = new Uint8ClampedArray(0);
  private columnImage: ImageData | null = null;
  private glowBuffers: BookGlowBuffers = {};
  private samples: number[] = [];
  metrics = { drawMs: 0, meanMs: 0, maxMs: 0, drawCount: 0, paintedRows: 0, timeUs: null as number | null, p99: 1,
    bandStart: null as number | null, bandEnd: null as number | null, numbers: 0, groupTicks: 1,
    style: "glow" as "glow" | "block", backgroundDpr: 1 };
  lastNumbers: BookNumberRow[] = [];
  /** WebGL band sink (HeatmapRenderer.bandSink). Returns true when the GPU layer painted the band. */
  bandSink: ((band: GpuBandRequest | null) => boolean) | null = null;
  private gpuSizes = new Float32Array(0);
  private gpuLineBuffers: BookGlowBuffers = {};
  gpuBand = false;

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
    const bandDpr = backgroundDpr(dpr);
    const bandWidth = Math.max(1, Math.round(rect.width * bandDpr));
    const bandHeight = Math.max(1, Math.round(rect.height * bandDpr));
    let bandContext = ctx;
    if (bandDpr !== dpr) {
      this.band ??= document.createElement("canvas");
      if (this.band.width !== bandWidth || this.band.height !== bandHeight) {
        this.band.width = bandWidth; this.band.height = bandHeight;
      }
      bandContext = this.band.getContext("2d")!;
      bandContext.clearRect(0, 0, bandWidth, bandHeight);
    }
    const scale = { upper: p99, lower, gamma };
    const numbers = bookNumberRows(book, view, rect.height, scale);
    // Measure each drawn number with its own (bold or regular) font: the band stops 5px before the widest.
    let widest = 0;
    for (const row of numbers) {
      ctx.font = bookNumberFont(row.bold);
      widest = Math.max(widest, ctx.measureText(String(row.total)).width); // CSS px: font is 10 CSS px
    }
    const bandStart = book && numbers.length ? bookBandStart(rightEdgeUs, view, width) : null;
    const bandEnd = Math.round(bookBandEnd(rect.width, widest) * dpr);
    const paintStart = book && numbers.length ? bookBandStart(rightEdgeUs, view, bandWidth) : null;
    const paintEnd = Math.round(bookBandEnd(rect.width, widest) * bandDpr);
    let paintedRows = 0;
    const hasBand = paintStart !== null && paintEnd > paintStart;
    const gpuBand = this.bandSink ? this.bandSink(hasBand
      ? this.gpuRequest(book, view, bandWidth, bandHeight, paintStart!, paintEnd, style, scale) : null) : false;
    this.gpuBand = gpuBand;
    if (gpuBand && hasBand) paintedRows = bandHeight;
    if (!gpuBand && hasBand && paintStart !== null) {
      bandContext.globalAlpha = 1;
      bandContext.fillStyle = "#000000";
      bandContext.fillRect(paintStart, 0, paintEnd - paintStart, bandHeight);
      if (style === "block") {
        this.rows = currentBookRows(book, view, bandHeight, undefined, this.rows);
        if (this.colors.length !== bandHeight * 4) this.colors = new Uint8ClampedArray(bandHeight * 4);
        const rows = this.rows, colors = colorize(rows, p99, this.colors, lower, gamma);
        for (let y = 0; y < bandHeight; y++) {
          if (rows[y]! < 1 || rows[y]! <= lower) continue;
          const i = y * 4;
          bandContext.fillStyle = `rgb(${colors[i]},${colors[i + 1]},${colors[i + 2]})`;
          bandContext.fillRect(paintStart, y, paintEnd - paintStart, 1);
          paintedRows++;
        }
      } else {
        const column = glowBookColumn(book, view, bandHeight, scale, this.glowBuffers);
        this.scratch ??= document.createElement("canvas");
        if (this.scratch.width !== 1 || this.scratch.height !== column.rgba.length / 4) {
          this.scratch.width = 1; this.scratch.height = column.rgba.length / 4;
        }
        const sctx = this.scratch.getContext("2d")!;
        if (this.columnImage?.height !== column.rgba.length / 4)
          this.columnImage = new ImageData(1, column.rgba.length / 4);
        this.columnImage.data.set(column.rgba);
        sctx.putImageData(this.columnImage, 0, 0);
        // Zoomed in: K sub-rows per price stretched over the price rows; zoom-out lines: one row per pixel (1:1).
        bandContext.imageSmoothingEnabled = true;
        bandContext.drawImage(this.scratch, 0, 0, 1, column.rgba.length / 4, paintStart, column.yTop, paintEnd - paintStart,
          column.destHeight);
        paintedRows = bandHeight;
      }
    }
    if (bandContext !== ctx && !gpuBand) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.band!, 0, 0, bandWidth, bandHeight, 0, 0, width, height);
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
      numbers: numbers.length, groupTicks: numbers[0]?.ticks ?? 1, style, backgroundDpr: bandDpr };
  }

  /** Latest book only: rows = one size per physical row (block), sizes = max size per price (glow). */
  private gpuRequest(book: HeatColumn | null, view: Viewport, width: number, height: number, paintStart: number,
    paintEnd: number, style: "glow" | "block", scale: { upper: number; lower: number; gamma: number }): GpuBandRequest {
    // Both derived vectors of the ONE latest book are always provided; style only selects the shader path.
    this.rows = currentBookRows(book, view, height, undefined, this.rows);
    // Same geometry as glowBookColumn.
    const k = glowK(height / view.priceSpanTicks);
    const margin = Math.ceil(glowRadius(k) / k) + 1;
    const top = view.centerPriceTicks + view.priceSpanTicks / 2, bottom = top - view.priceSpanTicks;
    const topPrice = Math.ceil(top + 0.5) - 1 + margin;
    const priceCount = Math.max(1, topPrice - (Math.floor(bottom - 0.5) + 1 - margin) + 1);
    if (this.gpuSizes.length !== priceCount) this.gpuSizes = new Float32Array(priceCount);
    const sizes = this.gpuSizes; sizes.fill(0);
    if (book) for (const side of [book.bids, book.asks]) for (let i = 0; i < side.prices.length; i++) {
      const row = topPrice - side.prices[i]!;
      if (row >= 0 && row < priceCount) sizes[row] = Math.max(sizes[row]!, side.sizes[i]!);
    }
    if (style === "glow" && wideLines(height / view.priceSpanTicks)) {
      // Zoom-out lines: the band column is built on the CPU (same as Canvas) and shown 1:1 by the GPU composite.
      const column = glowBookColumn(book, view, height, scale, this.gpuLineBuffers);
      return { style, width, height, paintStart, paintEnd, scale, rows: this.rows, sizes, k: column.k,
        yTop: column.yTop, destHeight: column.destHeight, line: column.rgba };
    }
    return { style, width, height, paintStart, paintEnd, scale, rows: this.rows, sizes, k,
      yTop: priceTicksToY(topPrice + 0.5, view, height), destHeight: priceCount * height / view.priceSpanTicks };
  }
}
