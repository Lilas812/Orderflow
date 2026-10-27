import type { Viewport } from "../domain.ts";
import type { TradeAggregator } from "../data/trade-aggregate.ts";
import { priceTicksToY } from "./coordinates.ts";
import { formatPrice } from "./format.ts";
import { BUBBLE_COLORS, tradeGeometry } from "./trade-geometry.ts";

function prepare(canvas: HTMLCanvasElement, dpr: number) {
  const { width, height } = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const context = canvas.getContext("2d")!;
  context.setTransform(w / Math.max(1, width), 0, 0, h / Math.max(1, height), 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}
export class TradeOverlayRenderer {
  private readonly heat: HTMLCanvasElement;
  private readonly axis: HTMLCanvasElement;
  private geometry: ReturnType<typeof tradeGeometry> = { bubbles: [], priceBins: [], downsampled: false };
  metrics = { bubbleCount: 0, geometryMs: 0, lineMs: 0, bubbleMs: 0, overlayMs: 0, downsampled: false, priceBinCount: 0,
    aggregationRevision: 0 };
  constructor(heat: HTMLCanvasElement, axis: HTMLCanvasElement) {
    this.heat = heat; this.axis = axis;
  }
  snapshot() {
    return { bubbles: this.geometry.bubbles.map(b => ({ ...b })),
      priceBins: this.geometry.priceBins.map(p => ({ ...p })), downsampled: this.geometry.downsampled };
  }
  draw(aggregation: TradeAggregator, view: Viewport, minimum: number, currentPrice: number | null, cutoffUs = Infinity,
    bubbleScale = 1): void {
    const start = performance.now(), dpr = window.devicePixelRatio || 1;
    const { context: ctx, width, height } = prepare(this.heat, dpr);
    const axis = prepare(this.axis, dpr);
    const geometryStart = performance.now();
    const geometry = tradeGeometry(aggregation, view, width, height, dpr, minimum, cutoffUs, bubbleScale);
    this.geometry = geometry;
    const geometryMs = performance.now() - geometryStart, lineStart = performance.now();
    ctx.strokeStyle = "#b9a7ff"; ctx.lineWidth = 1.5; ctx.beginPath();
    let previous: { x: number; last: number } | null = null;
    for (const bin of geometry.priceBins) {
      const y = priceTicksToY(bin.last, view, height);
      if (previous) {
        ctx.moveTo(previous.x, priceTicksToY(previous.last, view, height)); ctx.lineTo(bin.x, y);
      }
      if (geometry.downsampled) {
        ctx.moveTo(bin.x, priceTicksToY(bin.min, view, height)); ctx.lineTo(bin.x, priceTicksToY(bin.max, view, height));
      }
      previous = bin;
    }
    ctx.stroke();
    const lineMs = performance.now() - lineStart, bubbleStart = performance.now();
    for (const b of geometry.bubbles) {
      ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fillStyle = BUBBLE_COLORS[b.side].fill; ctx.globalAlpha = 0.8; ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = BUBBLE_COLORS[b.side].edge; ctx.lineWidth = 1; ctx.stroke();
    }
    const bubbleMs = performance.now() - bubbleStart;
    if (currentPrice !== null) {
      const y = priceTicksToY(currentPrice, view, height);
      for (const layer of [{ context: ctx, width, height }]) {
        const lineY = priceTicksToY(currentPrice, view, layer.height);
        layer.context.strokeStyle = "#ffffff"; layer.context.lineWidth = 1;
        layer.context.setLineDash([4, 4]); layer.context.beginPath();
        layer.context.moveTo(0, lineY); layer.context.lineTo(layer.width, lineY); layer.context.stroke();
        layer.context.setLineDash([]);
      }
      if (y >= 0 && y <= height) {
        const labelY = Math.max(9, Math.min(axis.height - 9, priceTicksToY(currentPrice, view, axis.height)));
        axis.context.fillStyle = "#ffffff"; axis.context.fillRect(0, labelY - 9, axis.width, 18);
        axis.context.fillStyle = "#000000"; axis.context.font = "11px ui-monospace, monospace";
        axis.context.textAlign = "center"; axis.context.textBaseline = "middle";
        axis.context.fillText(formatPrice(currentPrice), axis.width / 2, labelY, Math.max(1, axis.width - 2));
      }
    }
    this.metrics = { bubbleCount: geometry.bubbles.length, geometryMs, lineMs, bubbleMs,
      overlayMs: performance.now() - start, downsampled: geometry.downsampled, priceBinCount: geometry.priceBins.length,
      aggregationRevision: aggregation.revision };
  }
}
