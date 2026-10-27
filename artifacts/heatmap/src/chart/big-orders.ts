import type { Viewport } from "../domain.ts";
import type { BigOrder, BigOrderSnapshot } from "../data/big-orders.ts";
import { priceTicksToY } from "./coordinates.ts";

export function bigOrderOpacity(durationSec: number): number {
  return 0.35 + 0.65 * Math.max(0, Math.min(1, (durationSec - 5) / 295));
}

export function visibleBigOrders(snapshot: BigOrderSnapshot, view: Viewport, minSec: number): BigOrder[] {
  const low = view.centerPriceTicks - view.priceSpanTicks / 2;
  const high = view.centerPriceTicks + view.priceSpanTicks / 2;
  return snapshot.orders.filter(order => order.outsideSinceUs === null && order.durationSec >= minSec
    && order.price + 0.5 > low && order.price - 0.5 < high);
}

/** Physical rows use exactly the same price±0.5 extent as the heatmap/book. */
export function bigOrderRows(orders: readonly BigOrder[], view: Viewport, height: number): (BigOrder | undefined)[] {
  const rows = new Array<BigOrder | undefined>(height);
  for (const order of orders) {
    const first = Math.max(0, Math.floor(priceTicksToY(order.price + 0.5, view, height)));
    const last = Math.min(height - 1, Math.ceil(priceTicksToY(order.price - 0.5, view, height)) - 1);
    for (let y = first; y <= last; y++) {
      if (!rows[y] || order.size > rows[y]!.size) rows[y] = order;
    }
  }
  return rows;
}

export class BigOrderRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private samples: number[] = [];
  metrics = { drawMs: 0, meanMs: 0, maxMs: 0, drawCount: 0, visibleCount: 0,
    paintedRows: 0, maximumSize: 0, longestSec: 0, timeUs: null as number | null };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Large order Canvas 2D is unavailable");
    this.context = context;
  }

  draw(snapshot: BigOrderSnapshot, view: Viewport, minSec: number): void {
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
    const orders = visibleBigOrders(snapshot, view, minSec);
    const maximumSize = orders.reduce((max, order) => Math.max(max, order.size), 0);
    const rows = bigOrderRows(orders, view, height);
    let paintedRows = 0;
    ctx.fillStyle = "#e040fb";
    for (let y = 0; y < rows.length; y++) {
      const order = rows[y];
      if (!order) continue;
      const length = width * order.size / maximumSize;
      ctx.globalAlpha = bigOrderOpacity(order.durationSec);
      ctx.fillRect(width - length, y, length, 1);
      paintedRows++;
    }
    ctx.globalAlpha = 1;
    const drawMs = performance.now() - start;
    this.samples.push(drawMs); this.samples = this.samples.slice(-30);
    this.metrics = { drawMs, meanMs: this.samples.reduce((a, b) => a + b, 0) / this.samples.length,
      maxMs: Math.max(...this.samples), drawCount: this.metrics.drawCount + 1,
      visibleCount: orders.length, paintedRows, maximumSize,
      longestSec: orders.reduce((max, order) => Math.max(max, order.durationSec), 0), timeUs: snapshot.timeUs };
  }
}
