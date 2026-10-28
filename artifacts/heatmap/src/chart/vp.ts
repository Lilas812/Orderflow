import type { Viewport } from "../domain.ts";
import { priceTicksToY } from "./coordinates.ts";
import { VpState, valueArea } from "../data/vp.ts";
import type { VpLevel } from "../data/vp.ts";
import { vpBandBounds, vpGuides, drawVpGuides, drawVpLabels } from "./vp-decoration.ts";

export function vpRows(levels: Iterable<VpLevel>, view: Viewport, height: number,
  area: ReturnType<typeof valueArea>) {
  const totals = new Float64Array(height), colors = new Uint8Array(height);
  let pocVolume = 0;
  for (const [price, buy, sell] of levels) {
    if (price === area.poc) pocVolume = buy + sell;
    const top = priceTicksToY(price + 0.5, view, height), bottom = priceTicksToY(price - 0.5, view, height);
    if (bottom <= 0 || top >= height) continue;
    // Shared floored boundaries partition expanded rows without double-counting.
    let first = Math.max(0, Math.floor(top)), last = Math.min(height - 1, Math.floor(bottom) - 1);
    if (height < view.priceSpanTicks) {
      // A subpixel tick contributes to exactly one row, never to two adjacent sums.
      first = last = Math.max(0, Math.min(height - 1, Math.floor(priceTicksToY(price, view, height))));
    }
    const color = price === area.poc ? 2
      : area.low !== null && price >= area.low && price <= area.high! ? 1 : 0;
    for (let y = first; y <= last; y++) { totals[y] += buy + sell; colors[y] = Math.max(colors[y], color); }
  }
  const maximum = totals.reduce((a, b) => Math.max(a, b), 0);
  return { totals, colors, maximum, scaleMaximum: height < view.priceSpanTicks ? maximum : pocVolume };
}

export class VpRenderer {
  private readonly context: CanvasRenderingContext2D;
  private lastAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private samples: number[] = [];
  metrics = { drawMs: 0, meanMs: 0, maxMs: 0, drawCount: 0, prices: 0, poc: null as number | null,
    low: null as number | null, high: null as number | null, total: 0, maximumRow: 0, loading: true,
    sessionStartSec: null as number | null, upToSec: 0 };
  private canvas: HTMLCanvasElement;
  private invalidate: () => void;
  private guidesCanvas?: HTMLCanvasElement;
  private labelsCanvas?: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement, invalidate: () => void,
    guidesCanvas?: HTMLCanvasElement, labelsCanvas?: HTMLCanvasElement) {
    this.canvas = canvas; this.invalidate = invalidate;
    this.guidesCanvas = guidesCanvas; this.labelsCanvas = labelsCanvas;
    const context = canvas.getContext("2d");
    if (!context) throw Error("VP Canvas 2D is unavailable");
    this.context = context;
  }
  draw(state: VpState, view: Viewport) {
    const start = performance.now();
    // Also coalesce viewport-driven reprojections: no more than one VP paint/s.
    const remaining = 1000 - (start - this.lastAt);
    if (remaining > 0) {
      this.timer ??= setTimeout(() => { this.timer = null; this.invalidate(); }, remaining);
      return;
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const rect = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (rect.width < 1 || rect.height < 1) return;
    this.lastAt = start;
    const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    const area = valueArea(state.levels.values()), rows = vpRows(state.levels.values(), view, height, area);
    const band = vpBandBounds(area, view, height);
    if (band) {
      ctx.fillStyle = "#f5a623"; ctx.globalAlpha = .12;
      ctx.fillRect(0, band.first, width, band.end - band.first); ctx.globalAlpha = 1;
    }
    const colors = ["#d9d9d9", "#f5a623", "#ffffff"];
    for (let y = 0; y < height; y++) if (rows.totals[y] > 0) {
      const length = width * rows.totals[y] / rows.scaleMaximum;
      ctx.fillStyle = colors[rows.colors[y]]; ctx.fillRect(width - length, y, length, 1);
    }
    if (this.guidesCanvas) drawVpGuides(this.guidesCanvas, area, view, dpr);
    else {
      // Also support isolated renderer tests without the spanning overlay.
      ctx.lineWidth = dpr; ctx.setLineDash([2 * dpr, 2 * dpr]);
      for (const guide of vpGuides(area, view, height)) {
        ctx.strokeStyle = guide.kind === "POC" ? "#ffffff" : "#f5a623";
        ctx.globalAlpha = guide.kind === "POC" ? 1 : .8;
        ctx.beginPath(); ctx.moveTo(0, guide.y); ctx.lineTo(width, guide.y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    if (this.labelsCanvas) drawVpLabels(this.labelsCanvas, area, view, dpr);
    const drawMs = performance.now() - start;
    this.samples.push(drawMs); this.samples = this.samples.slice(-30);
    this.metrics = { drawMs, meanMs: this.samples.reduce((a, b) => a + b, 0) / this.samples.length,
      maxMs: Math.max(...this.samples), drawCount: this.metrics.drawCount + 1,
      prices: state.levels.size, poc: area.poc, low: area.low, high: area.high, total: area.total,
      maximumRow: rows.maximum, loading: state.loading,
      sessionStartSec: state.sessionStartSec, upToSec: state.upToSec };
  }
}
