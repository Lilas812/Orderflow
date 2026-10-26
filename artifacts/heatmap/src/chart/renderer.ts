import type { HeatColumn, Viewport } from "../domain.ts";
import { formatPrice } from "./format.ts";
import { viewportPositiveP99 } from "./scale.ts";
import type { DisplayZone } from "./timezone.ts";
import { TimeTileCache, type TileCacheMetrics } from "./tiles.ts";
import { shiftPixelGridHorizontally, type PixelMaxGrid } from "./aggregate.ts";

export interface DrawMetrics extends Partial<TileCacheMetrics> {
  drawMs: number;
  aggregationMs: number;
  scaleMs: number;
  p99: number;
  rasterMs?: number;
  rasterRebuilt?: boolean;
  partialRaster?: boolean;
  repaintPixels?: number;
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

  draw(columns: readonly HeatColumn[], view: Viewport, _revision: number, _zone: DisplayZone, hasPriceData = true): void {
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

    this.tileCache.setColumns(columns);
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
    let scaleChanged = false;
    if (hasPriceData && columns.length > 0 && (this.threshold === null || now - this.lastScaleAt >= 1_000)) {
      if (this.scaleTimer !== null) window.clearTimeout(this.scaleTimer);
      this.scaleTimer = null;
      const scaleStart = performance.now();
      const nextThreshold = viewportPositiveP99(columns, view);
      scaleChanged = nextThreshold !== this.threshold;
      this.threshold = nextThreshold;
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
        this.context.putImageData(new ImageData(colorize(values, this.threshold ?? 1), stripWidth, height), a, 0);
      }
      rasterMs = performance.now() - rasterStart;
    } else if (rasterRebuilt || scaleChanged || !this.imageData) {
      const rasterStart = performance.now();
      const rgba = colorize(this.pixelGrid!.values, this.threshold ?? 1);
      this.imageData = new ImageData(rgba, width, height);
      this.context.putImageData(this.imageData, 0, 0);
      rasterMs = performance.now() - rasterStart;
    }

    this.lastViewport = { ...view };
    if (hasPriceData) drawPriceAxis(this.axis, view);
    else clearPriceAxis(this.axis);
    const cacheMetrics = this.tileCache.metrics;
    this.metricsValue = {
      ...cacheMetrics,
      drawMs: performance.now() - drawStart,
      aggregationMs,
      scaleMs,
      rasterMs,
      p99: this.threshold ?? 1,
      rasterRebuilt,
      partialRaster: !!strips && !scaleChanged,
      repaintPixels: strips && !scaleChanged ? strips.reduce((n, [a, b]) => n + (b - a) * height, 0) : rasterRebuilt || scaleChanged ? width * height : 0,
    };
  }
}

const COLOR_LUT_STEPS = 1_024;
const COLOR_LUT = buildColorLut();

function buildColorLut(): Uint8Array {
  const output = new Uint8Array(COLOR_LUT_STEPS * 3);
  const stops = [
    { at: 0, rgb: [11, 26, 74] },
    { at: 0.2, rgb: [59, 42, 143] },
    { at: 0.4, rgb: [138, 60, 255] },
    { at: 0.6, rgb: [233, 227, 255] },
    { at: 0.8, rgb: [255, 154, 60] },
    { at: 1, rgb: [255, 59, 48] },
  ];
  for (let index = 0; index < COLOR_LUT_STEPS; index += 1) {
    const position = index / (COLOR_LUT_STEPS - 1);
    let stop = 0;
    while (stop < stops.length - 2 && position > stops[stop + 1]!.at) stop += 1;
    const a = stops[stop]!;
    const b = stops[stop + 1]!;
    const amount = (position - a.at) / (b.at - a.at);
    const offset = index * 3;
    output[offset] = Math.round(a.rgb[0]! + (b.rgb[0]! - a.rgb[0]!) * amount);
    output[offset + 1] = Math.round(a.rgb[1]! + (b.rgb[1]! - a.rgb[1]!) * amount);
    output[offset + 2] = Math.round(a.rgb[2]! + (b.rgb[2]! - a.rgb[2]!) * amount);
  }
  return output;
}

function colorize(values: Uint32Array, threshold: number): Uint8ClampedArray<ArrayBuffer> {
  const output = new Uint8ClampedArray(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    const size = values[index]!;
    const offset = index * 4;
    if (size < 1) {
      output[offset + 3] = 255;
      continue;
    }
    const lutIndex = Math.min(COLOR_LUT_STEPS - 1, Math.round((size / Math.max(1, threshold)) * (COLOR_LUT_STEPS - 1)));
    const lutOffset = lutIndex * 3;
    output[offset] = COLOR_LUT[lutOffset]!;
    output[offset + 1] = COLOR_LUT[lutOffset + 1]!;
    output[offset + 2] = COLOR_LUT[lutOffset + 2]!;
    output[offset + 3] = 255;
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
