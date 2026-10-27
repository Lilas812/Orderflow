import type { Viewport } from "../domain.ts";
import type { TradeAggregator } from "../data/trade-aggregate.ts";
import { deltaGeometry } from "./delta-geometry.ts";
import type { DeltaBar } from "./delta-geometry.ts";

function prepare(canvas: HTMLCanvasElement) {
  const { width, height } = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const context = canvas.getContext("2d");
  if (!context) throw Error("Delta Canvas 2D is unavailable");
  context.setTransform(w / Math.max(1, width), 0, 0, h / Math.max(1, height), 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

/** Owns only the lower histogram and its scale, never another chart's canvas. */
export class DeltaRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly axis: HTMLCanvasElement;
  private samples: number[] = [];
  private bars: DeltaBar[] = [];
  metrics = { seconds: 1, visibleCount: 0, maximum: 0, omittedCount: 0,
    drawMs: 0, meanMs: 0, maxMs: 0, drawCount: 0, aggregationRevision: 0 };
  constructor(canvas: HTMLCanvasElement, axis: HTMLCanvasElement) {
    this.canvas = canvas; this.axis = axis;
  }
  snapshot(): DeltaBar[] { return this.bars.map(bar => ({ ...bar })); }
  draw(aggregation: TradeAggregator, view: Viewport, cutoffUs: number, streamFromUs: number): void {
    const started = performance.now();
    const { context: ctx, width, height } = prepare(this.canvas), axis = prepare(this.axis);
    const geometry = deltaGeometry(aggregation, view, width, height, cutoffUs, streamFromUs);
    this.bars = geometry.bars;
    for (const bar of geometry.bars) {
      if (bar.delta === 0) continue;
      ctx.fillStyle = bar.delta > 0 ? "#ffffff" : "#a64dff";
      ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
    }
    ctx.strokeStyle = "#252431"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, geometry.zeroY); ctx.lineTo(width, geometry.zeroY); ctx.stroke();
    const a = axis.context;
    a.fillStyle = "#d9d9d9"; a.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    a.textAlign = "center"; a.textBaseline = "top";
    const labelWidth = Math.max(1, axis.width - 2);
    a.fillText(`+${geometry.maximum}`, axis.width / 2, 2, labelWidth);
    a.textAlign = "left";
    a.textBaseline = "middle"; a.fillText("0", 2, axis.height / 2, labelWidth);
    a.textAlign = "center";
    a.textBaseline = "bottom"; a.fillText(`−${geometry.maximum}`, axis.width / 2, axis.height - 2, labelWidth);
    const zeroWidth = a.measureText("0").width;
    a.font = "11px ui-monospace, monospace"; a.fillStyle = "#8a8a8a";
    a.textAlign = "right"; a.textBaseline = "middle";
    a.fillText(`${geometry.seconds}s`, axis.width - 2, axis.height / 2, Math.max(1, labelWidth - zeroWidth - 2));
    const drawMs = performance.now() - started;
    this.samples.push(drawMs); this.samples = this.samples.slice(-30);
    this.metrics = { seconds: geometry.seconds, visibleCount: geometry.bars.length, maximum: geometry.maximum,
      omittedCount: geometry.omittedCount, drawMs,
      meanMs: this.samples.reduce((a, b) => a + b, 0) / this.samples.length,
      maxMs: Math.max(...this.samples), drawCount: this.metrics.drawCount + 1, aggregationRevision: aggregation.revision };
  }
}
