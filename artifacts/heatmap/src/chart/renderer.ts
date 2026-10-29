import type { HeatColumn, Viewport } from "../domain.ts";
import { formatPrice } from "./format.ts";
import { COLOR_LUT, COLOR_LUT_STEPS } from "./palette.ts";
import { heatThresholds, type HeatScaleOptions } from "./scale.ts";
import type { DisplayZone } from "./timezone.ts";
import { TimeTileCache, type TileCacheMetrics } from "./tiles.ts";
import { shiftPixelGridHorizontally, type PixelMaxGrid } from "./aggregate.ts";
import { GlowRaster, type GlowMetrics } from "./glow.ts";
import { priceTicksToY } from "./coordinates.ts";
import type { TradeAggregator } from "../data/trade-aggregate.ts";
import { DEFAULT_SETTINGS } from "../data/settings.ts";

export type HeatStyle = "glow" | "block";

export interface DrawMetrics extends Partial<TileCacheMetrics> {
  drawMs: number;
  aggregationMs: number;
  scaleMs: number;
  p99: number;
  lower?: number;
  lowerAdjusted?: boolean;
  gamma?: number;
  rasterMs?: number;
  rasterRebuilt?: boolean;
  partialRaster?: boolean;
  repaintPixels?: number;
  tileSyncMs?: number;
  colorMs?: number;
  uploadMs?: number;
  axisMs?: number;
  style?: HeatStyle;
  glow?: GlowMetrics;
}

export class HeatmapRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly invalidateScaleDraw: () => void;
  private readonly canvas: HTMLCanvasElement;
  private readonly axis: HTMLCanvasElement;
  private readonly tileCache = new TimeTileCache();
  private imageData: ImageData | null = null;
  private pixelGrid: PixelMaxGrid | null = null;
  private lastRasterKey = "";
  private lastViewport: Viewport | null = null;
  private scratch: HTMLCanvasElement | null = null;
  private lastScaleAt = 0;
  private threshold: number | null = null;
  private options: HeatScaleOptions = { heatTopPct: DEFAULT_SETTINGS.heatTopPct, heatUpperMode: DEFAULT_SETTINGS.heatUpperMode,
    heatUpperSize: DEFAULT_SETTINGS.heatUpperSize, heatLowerMode: DEFAULT_SETTINGS.heatLowerMode,
    heatLowerPct: DEFAULT_SETTINGS.heatLowerPct, heatLowerSize: DEFAULT_SETTINGS.heatLowerSize, heatGamma: DEFAULT_SETTINGS.heatGamma };
  private style: HeatStyle = DEFAULT_SETTINGS.heatStyle;
  private readonly glow = new GlowRaster();
  private glowCanvas: HTMLCanvasElement | null = null;
  private trades: TradeAggregator | null = null;
  private lower = 0;
  private lowerAdjusted = false;
  private colorDirty = false;
  private scaleTimer: number | null = null;
  private physicalWidth = 0;
  private physicalHeight = 0;
  private metricsValue: DrawMetrics = {
    drawMs: 0,
    aggregationMs: 0,
    scaleMs: 0,
    rasterMs: 0,
    p99: 1,
    rasterRebuilt: false,
    profileHits: 0,
    profileMisses: 0,
    recomputedColumns: 0,
    rawLevelScans: 0,
    tileInvalidations: 0,
    cachedProfileBytes: 0,
    tileCount: 0,
  };

  constructor(canvas: HTMLCanvasElement, axis: HTMLCanvasElement, invalidateScaleDraw: () => void = () => {}) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.canvas = canvas;
    this.axis = axis;
    this.context = context;
    this.invalidateScaleDraw = invalidateScaleDraw;
  }

  get metrics(): DrawMetrics { return { ...this.metricsValue }; }
  setTopPercent(value: number): void { this.setScaleOptions({ ...this.options, heatTopPct: value }); }
  setScaleOptions(options: HeatScaleOptions): void {
    this.colorDirty ||= (Object.keys(this.options) as (keyof HeatScaleOptions)[]).some(k => this.options[k] !== options[k]);
    this.options = { heatTopPct: options.heatTopPct, heatUpperMode: options.heatUpperMode, heatUpperSize: options.heatUpperSize,
      heatLowerMode: options.heatLowerMode, heatLowerPct: options.heatLowerPct,
      heatLowerSize: options.heatLowerSize, heatGamma: options.heatGamma };
  }

  get heatStyle(): HeatStyle { return this.style; }
  setStyle(style: HeatStyle): void {
    if (style === this.style) return;
    this.style = style;
    // Switching drawing styles always repaints the whole layer from scratch.
    this.lastRasterKey = ""; this.imageData = null; this.pixelGrid = null; this.lastViewport = null;
    this.glow.reset();
  }
  /** Trade aggregation (SPEC 7.1) used by the glow "eaten" cut. */
  setTrades(trades: TradeAggregator | null): void { this.trades = trades; }

  draw(columns: readonly HeatColumn[], view: Viewport, _revision: number, _zone: DisplayZone, hasPriceData = true, redrawAxis = true): void {
    const drawStart = performance.now();
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    const resized = width !== this.physicalWidth || height !== this.physicalHeight;
    if (resized) {
      this.physicalWidth = width;
      this.physicalHeight = height;
      this.canvas.width = width;
      this.canvas.height = height;
      this.pixelGrid = null;
      this.imageData = null;
      this.lastRasterKey = "";
      this.context.imageSmoothingEnabled = false;
    }

    const syncStart = performance.now();
    this.tileCache.setColumns(columns);
    const tileSyncMs = performance.now() - syncStart;
    if (this.style === "glow") {
      this.drawGlow(columns, view, width, height, hasPriceData, redrawAxis, drawStart, tileSyncMs);
      return;
    }
    const revision = this.tileCache.dataVersion;
    const rasterKey = [
      revision,
      width,
      height,
      view.startUs,
      view.durationSec,
      view.centerPriceTicks,
      view.priceSpanTicks,
    ].join("|");
    const rasterRebuilt = resized || !this.pixelGrid || rasterKey !== this.lastRasterKey;
    const aggregationStart = performance.now();
    let strips: [number, number][] | null = null;
    let shift = 0;
    if (rasterRebuilt) {
      const previous = this.lastViewport;
      const floatShift = previous ? -(view.startUs - previous.startUs) / (view.durationSec * 1_000_000) * width : NaN;
      const integral = Math.round(floatShift);
      if (!resized && this.pixelGrid && previous && previous.durationSec === view.durationSec
        && previous.centerPriceTicks === view.centerPriceTicks && previous.priceSpanTicks === view.priceSpanTicks
        && Math.abs(floatShift - integral) < 0.0001 && Math.abs(integral) < width) {
        shift = integral;
        if (shift) this.pixelGrid = shiftPixelGridHorizontally(this.pixelGrid, shift);
        strips = this.tileCache.dirtyTimeRanges.map(range => [
          Math.max(0, Math.floor((range.fromSec * 1_000_000 - view.startUs) / (view.durationSec * 1_000_000) * width)),
          Math.min(width, Math.ceil((range.toSec * 1_000_000 - view.startUs) / (view.durationSec * 1_000_000) * width)),
        ] as [number, number]).filter(([a, b]) => a < b);
        if (shift > 0) strips.push([0, shift]);
        if (shift < 0) strips.push([width + shift, width]);
        strips.sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        for (const strip of strips) {
          const last = merged.at(-1);
          if (last && strip[0] <= last[1]) last[1] = Math.max(last[1], strip[1]);
          else merged.push([...strip]);
        }
        strips = merged;
        for (const [a, b] of strips) this.tileCache.aggregateStrip(this.pixelGrid, view, a, b);
      } else {
        this.pixelGrid = this.tileCache.aggregate(view, width, height);
      }
      this.lastRasterKey = rasterKey;
    }
    const aggregationMs = performance.now() - aggregationStart;

    const now = performance.now();
    let scaleMs = 0;
    let scaleChanged = this.colorDirty;
    if ((hasPriceData && columns.length > 0
      && (this.threshold !== null || this.pixelGrid!.values.some(size => size >= 1)) || this.options.heatUpperMode === "size")
      && (this.threshold === null || now - this.lastScaleAt >= 1_000)) {
      if (this.scaleTimer !== null) window.clearTimeout(this.scaleTimer);
      this.scaleTimer = null;
      const scaleStart = performance.now();
      const next = heatThresholds(columns, view, this.options);
      scaleChanged ||= next.upper !== this.threshold || next.lower !== this.lower;
      this.threshold = next.upper;
      this.lower = next.lower;
      this.lowerAdjusted = next.lowerAdjusted;
      this.lastScaleAt = now;
      scaleMs = performance.now() - scaleStart;
    } else if (this.threshold !== null && this.scaleTimer === null) {
      const waitMs = Math.max(1, 1_000 - (now - this.lastScaleAt));
      this.scaleTimer = window.setTimeout(() => {
        this.scaleTimer = null;
        this.invalidateScaleDraw();
      }, waitMs);
    }

    let rasterMs = 0;
    let colorMs = 0, uploadMs = 0;
    if (strips && !scaleChanged && this.imageData) {
      const rasterStart = performance.now();
      if (shift) {
        this.scratch ??= document.createElement("canvas");
        this.scratch.width = width;
        this.scratch.height = height;
        this.scratch.getContext("2d")!.drawImage(this.canvas, 0, 0);
        this.context.fillStyle = "#000000";
        this.context.fillRect(0, 0, width, height);
        this.context.drawImage(this.scratch, shift, 0);
      }
      for (const [a, b] of strips) {
        const stripWidth = b - a;
        const values = new Uint32Array(stripWidth * height);
        for (let y = 0; y < height; y++) values.set(this.pixelGrid!.values.subarray(y * width + a, y * width + b), y * stripWidth);
        const colorStart = performance.now();
        const image = new ImageData(colorize(values, this.threshold ?? 1, undefined, this.lower, this.options.heatGamma), stripWidth, height);
        colorMs += performance.now() - colorStart;
        const uploadStart = performance.now();
        this.context.putImageData(image, a, 0);
        uploadMs += performance.now() - uploadStart;
      }
      rasterMs = performance.now() - rasterStart;
    } else if (rasterRebuilt || scaleChanged || !this.imageData) {
      const rasterStart = performance.now();
      const reusable = this.imageData?.width === width && this.imageData.height === height ? this.imageData : null;
      const rgba = colorize(this.pixelGrid!.values, this.threshold ?? 1, reusable?.data, this.lower, this.options.heatGamma);
      this.imageData = reusable ?? new ImageData(rgba, width, height);
      colorMs = performance.now() - rasterStart;
      const uploadStart = performance.now();
      this.context.putImageData(this.imageData, 0, 0);
      uploadMs = performance.now() - uploadStart;
      rasterMs = performance.now() - rasterStart;
    }

    this.lastViewport = { ...view };
    this.colorDirty = false;
    const axisStart = performance.now();
    if (redrawAxis) {
      if (hasPriceData) drawPriceAxis(this.axis, view);
      else clearPriceAxis(this.axis);
    }
    const axisMs = performance.now() - axisStart;
    const cacheMetrics = this.tileCache.metrics;
    this.metricsValue = {
      ...cacheMetrics,
      drawMs: performance.now() - drawStart,
      aggregationMs,
      scaleMs,
      rasterMs,
      tileSyncMs, colorMs, uploadMs, axisMs,
      p99: this.threshold ?? 1,
      lower: this.lower, lowerAdjusted: this.lowerAdjusted, gamma: this.options.heatGamma,
      style: "block",
      rasterRebuilt,
      partialRaster: !!strips && !scaleChanged,
      repaintPixels: strips && !scaleChanged ? strips.reduce((n, [a, b]) => n + (b - a) * height, 0) : rasterRebuilt || scaleChanged ? width * height : 0,
    };
  }

  /** Threshold refresh shared by both styles (SPEC 7: at most once per second). */
  private refreshScale(columns: readonly HeatColumn[], view: Viewport, hasPriceData: boolean, hasPositive: boolean) {
    const now = performance.now();
    let scaleMs = 0;
    let scaleChanged = this.colorDirty;
    if ((hasPriceData && columns.length > 0 && (this.threshold !== null || hasPositive) || this.options.heatUpperMode === "size")
      && (this.threshold === null || now - this.lastScaleAt >= 1_000)) {
      if (this.scaleTimer !== null) window.clearTimeout(this.scaleTimer);
      this.scaleTimer = null;
      const scaleStart = performance.now();
      const next = heatThresholds(columns, view, this.options);
      scaleChanged ||= next.upper !== this.threshold || next.lower !== this.lower;
      this.threshold = next.upper;
      this.lower = next.lower;
      this.lowerAdjusted = next.lowerAdjusted;
      this.lastScaleAt = now;
      scaleMs = performance.now() - scaleStart;
    } else if (this.threshold !== null && this.scaleTimer === null) {
      const waitMs = Math.max(1, 1_000 - (now - this.lastScaleAt));
      this.scaleTimer = window.setTimeout(() => {
        this.scaleTimer = null;
        this.invalidateScaleDraw();
      }, waitMs);
    }
    return { scaleMs, scaleChanged };
  }

  /** SPEC 7 glow: cached per drawn column, composited in software, scaled with smoothing. No ctx.filter. */
  private drawGlow(columns: readonly HeatColumn[], view: Viewport, width: number, height: number,
    hasPriceData: boolean, redrawAxis: boolean, drawStart: number, tileSyncMs: number): void {
    const { scaleMs } = this.refreshScale(columns, view, hasPriceData, columns.length > 0);
    const rasterStart = performance.now();
    const ctx = this.context;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);
    let glowMetrics: GlowMetrics | undefined;
    let uploadMs = 0;
    if (hasPriceData && columns.length > 0 && this.threshold !== null) {
      const frame = this.glow.frame(second => this.tileCache.displayColumn(second), view, width, height,
        { upper: this.threshold, lower: this.lower, gamma: this.options.heatGamma }, this.trades);
      glowMetrics = { ...this.glow.metrics };
      const uploadStart = performance.now();
      this.glowCanvas ??= document.createElement("canvas");
      if (this.glowCanvas.width !== frame.width) this.glowCanvas.width = frame.width;
      if (this.glowCanvas.height !== frame.height) this.glowCanvas.height = frame.height;
      this.glowCanvas.getContext("2d")!.putImageData(
        new ImageData(frame.image as Uint8ClampedArray<ArrayBuffer>, frame.width, frame.height), 0, 0);
      const pxPerSec = width / view.durationSec;
      const x = (frame.firstBucket * frame.bucketSec - view.startUs / 1_000_000) * pxPerSec;
      const y = priceTicksToY(frame.topPrice + 0.5, view, height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.glowCanvas, 0, 0, frame.width, frame.height,
        x, y, frame.width * frame.bucketSec * pxPerSec, frame.priceCount * height / view.priceSpanTicks);
      ctx.imageSmoothingEnabled = false;
      uploadMs = performance.now() - uploadStart;
    }
    const rasterMs = performance.now() - rasterStart;
    this.lastViewport = { ...view };
    this.colorDirty = false;
    const axisStart = performance.now();
    if (redrawAxis) {
      if (hasPriceData) drawPriceAxis(this.axis, view);
      else clearPriceAxis(this.axis);
    }
    const axisMs = performance.now() - axisStart;
    this.metricsValue = {
      ...this.tileCache.metrics,
      drawMs: performance.now() - drawStart, aggregationMs: 0, scaleMs, rasterMs, tileSyncMs,
      colorMs: glowMetrics?.glowMs ?? 0, uploadMs, axisMs,
      p99: this.threshold ?? 1, lower: this.lower, lowerAdjusted: this.lowerAdjusted, gamma: this.options.heatGamma,
      rasterRebuilt: !!glowMetrics?.fullFlush, partialRaster: !!glowMetrics && !glowMetrics.fullFlush,
      repaintPixels: glowMetrics ? glowMetrics.composeRecomputed * glowMetrics.rows : 0,
      style: "glow", glow: glowMetrics,
    };
  }
}

const PACKED_COLOR_LUT = new Uint32Array(COLOR_LUT_STEPS);
const packedBytes = new Uint8ClampedArray(PACKED_COLOR_LUT.buffer);
for (let index = 0; index < COLOR_LUT_STEPS; index++) {
  packedBytes[index * 4] = COLOR_LUT[index * 3]!;
  packedBytes[index * 4 + 1] = COLOR_LUT[index * 3 + 1]!;
  packedBytes[index * 4 + 2] = COLOR_LUT[index * 3 + 2]!;
  packedBytes[index * 4 + 3] = 255;
}
// Construct through bytes so packed writes preserve RGBA on either endianness.
const PACKED_BLACK = new Uint32Array(Uint8Array.of(0, 0, 0, 255).buffer)[0]!;

export function colorize(values: Uint32Array, threshold: number,
  reusable?: Uint8ClampedArray<ArrayBuffer>, lower = 0, gamma = 1): Uint8ClampedArray<ArrayBuffer> {
  const output = reusable?.length === values.length * 4 && reusable.byteOffset % 4 === 0
    ? reusable : new Uint8ClampedArray(values.length * 4);
  const pixels = new Uint32Array(output.buffer, output.byteOffset, values.length);
  if (Number.isNaN(threshold)) { pixels.fill(PACKED_BLACK); return output; }
  const normalizer = Math.max(1, threshold - lower);
  for (let index = 0; index < values.length; index += 1) {
    const size = values[index]!;
    if (size < 1 || size <= lower) {
      pixels[index] = PACKED_BLACK;
      continue;
    }
    const t = Math.min(1, Math.max(0, (size - lower) / normalizer));
    const lutIndex = Math.round((gamma === 1 ? t : t ** gamma) * (COLOR_LUT_STEPS - 1));
    pixels[index] = PACKED_COLOR_LUT[lutIndex]!;
  }
  return output;
}

function drawPriceAxis(canvas: HTMLCanvasElement, view: Viewport): void {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  const tickStride = niceTickStride(view.priceSpanTicks, height / dpr);
  const top = view.centerPriceTicks + view.priceSpanTicks / 2;
  const bottom = view.centerPriceTicks - view.priceSpanTicks / 2;
  const first = Math.ceil(bottom / tickStride) * tickStride;
  ctx.font = `${9 * dpr}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let price = first; price <= top; price += tickStride) {
    const y = ((top - price) / view.priceSpanTicks) * height;
    ctx.fillStyle = "#777485";
    ctx.fillRect(0, Math.round(y), Math.min(5 * dpr, width), Math.max(1, dpr));
    ctx.fillStyle = "#a09cab";
    ctx.fillText(formatPrice(price), width / 2, Math.round(y));
  }
  ctx.fillStyle = "#403d4c";
  ctx.fillRect(width - Math.max(1, dpr), 0, Math.max(1, dpr), height);
}

function clearPriceAxis(canvas: HTMLCanvasElement): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, width, height);
}

function niceTickStride(spanTicks: number, heightCss: number): number {
  const minPixelDistance = 34;
  const targetCount = Math.max(2, heightCss / minPixelDistance);
  const rough = spanTicks / targetCount;
  return [1, 2, 4, 8, 16, 32, 64, 128, 256].find((step) => step >= rough) ?? 256;
}
