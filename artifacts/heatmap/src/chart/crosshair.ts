import type { Viewport } from "../domain.ts";
import { xToTimeUs, yToPriceTicks } from "./coordinates.ts";
import { formatPrice } from "./format.ts";
import { formatCrosshairTimeUs, type DisplayZone } from "./timezone.ts";

export interface Rect { x: number; y: number; width: number; height: number }
export interface CursorPoint { x: number; y: number }

/** Values are independent of stored data; rounding affects labels only. */
export function crosshairValues(point: CursorPoint, view: Viewport, width: number, height: number, zone: DisplayZone) {
  const priceTicks = Math.round(yToPriceTicks(point.y, view, height));
  const timeUs = Math.floor(xToTimeUs(point.x, view, width) / 1_000_000) * 1_000_000;
  return { priceTicks, timeUs, price: formatPrice(priceTicks), time: formatCrosshairTimeUs(timeUs, zone) };
}

/** Clamp a label, never its corresponding line or value. */
export function fitCursorLabel(axis: Rect, center: CursorPoint, textWidth: number): Rect {
  const width = Math.min(axis.width, textWidth + 8), height = Math.min(axis.height, 18);
  return {
    x: Math.max(axis.x, Math.min(axis.x + axis.width - width, center.x - width / 2)),
    y: Math.max(axis.y, Math.min(axis.y + axis.height - height, center.y - height / 2)),
    width, height,
  };
}

/**
 * A transparent, pointer-inert layer above all chart layers.
 * Only this canvas is scheduled by mouse movement. No feed/cache/draw-scheduler access.
 */
export class CrosshairOverlay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private point: CursorPoint | null = null;
  private queued: number | null = null;
  private readonly abort = new AbortController();
  private readonly observer: ResizeObserver;
  private drawn: ReturnType<typeof crosshairValues> & {
    x: number; y: number; horizontal: Rect; vertical: Rect; priceLabel: Rect; timeLabel: Rect;
  } | null = null;
  private drawCount = 0;
  private moveCount = 0;
  private lastKey: string | null = null;
  private readonly board: HTMLElement;
  private readonly heat: HTMLCanvasElement;
  private readonly priceAxis: HTMLElement;
  private readonly timeAxis: HTMLElement;
  private readonly view: () => Viewport;
  private readonly zone: () => DisplayZone;
  private readonly enabled: () => boolean;

  constructor(
    board: HTMLElement, heat: HTMLCanvasElement, priceAxis: HTMLElement, timeAxis: HTMLElement,
    view: () => Viewport, zone: () => DisplayZone, enabled: () => boolean,
  ) {
    this.board = board; this.heat = heat; this.priceAxis = priceAxis; this.timeAxis = timeAxis;
    this.view = view; this.zone = zone; this.enabled = enabled;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "crosshair-overlay";
    this.canvas.id = "crosshair";
    this.canvas.setAttribute("aria-hidden", "true");
    this.ctx = this.canvas.getContext("2d")!;
    board.append(this.canvas);
    const signal = this.abort.signal;
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") { this.hide(); return; }
      this.moveCount++;
      this.point = { x: event.clientX, y: event.clientY };
      this.request();
    };
    heat.addEventListener("pointerenter", move, { signal });
    heat.addEventListener("pointermove", move, { signal });
    heat.addEventListener("pointerleave", () => this.hide(), { signal });
    heat.addEventListener("pointercancel", () => this.hide(), { signal });
    heat.addEventListener("pointerdown", event => {
      if (event.pointerType !== "mouse") this.hide();
    }, { signal });
    window.addEventListener("blur", () => this.hide(), { signal });
    window.addEventListener("pagehide", () => this.hide(), { signal });
    window.addEventListener("scroll", () => this.request(), { signal, capture: true, passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.hide();
    }, { signal });
    document.addEventListener("click", event => {
      const link = (event.target as Element | null)?.closest?.("a");
      if (link && new URL(link.href).searchParams.get("view") === "longvp") this.hide();
    }, { signal, capture: true });
    this.observer = new ResizeObserver(() => this.request());
    this.observer.observe(board);
    this.observer.observe(heat);
  }

  snapshot() { return { visible: this.drawn !== null, drawCount: this.drawCount, moveCount: this.moveCount, ...this.drawn }; }

  request(): void {
    if (!this.point || this.queued !== null) return;
    this.queued = requestAnimationFrame(() => {
      this.queued = null;
      this.draw();
    });
  }

  hide(): void {
    this.point = null;
    if (this.queued !== null) cancelAnimationFrame(this.queued);
    this.queued = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawn = null;
    this.lastKey = null;
  }

  destroy(): void { this.hide(); this.abort.abort(); this.observer.disconnect(); this.canvas.remove(); }

  private draw(): void {
    const point = this.point;
    if (!point || document.hidden || !this.enabled()) { this.hide(); return; }
    const b = this.board.getBoundingClientRect(), h = this.heat.getBoundingClientRect();
    const x = point.x - h.x, y = point.y - h.y;
    if (x < 0 || y < 0 || x >= h.width || y >= h.height || h.width <= 0 || h.height <= 0) {
      this.hide(); return;
    }
    const ratio = window.devicePixelRatio || 1;
    const p = this.priceAxis.getBoundingClientRect(), t = this.timeAxis.getBoundingClientRect();
    const view = this.view(), zone = this.zone();
    const key = JSON.stringify([point.x, point.y, ratio, b.x, b.y, b.width, b.height,
      h.x, h.y, h.width, h.height, p.x, p.y, p.width, p.height, t.x, t.y, t.width, t.height,
      view.startUs, view.durationSec, view.centerPriceTicks, view.priceSpanTicks, zone]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const width = Math.max(1, Math.round(b.width * ratio)), height = Math.max(1, Math.round(b.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
    }
    const ctx = this.ctx;
    ctx.setTransform(width / b.width, 0, 0, height / b.height, 0, 0);
    ctx.clearRect(0, 0, b.width, b.height);
    const local = (r: DOMRect): Rect => ({ x: r.x - b.x, y: r.y - b.y, width: r.width, height: r.height });
    const heat = local(h), price = local(p), time = local(t);
    const cx = heat.x + x, cy = heat.y + y;
    const values = crosshairValues({ x, y }, view, h.width, h.height, zone);
    ctx.strokeStyle = "rgba(235,232,245,0.65)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(heat.x, cy); ctx.lineTo(heat.x + heat.width, cy);
    ctx.moveTo(cx, heat.y); ctx.lineTo(cx, time.y);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.font = "11px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const priceLabel = fitCursorLabel(price, { x: price.x + price.width / 2, y: cy }, ctx.measureText(values.price).width);
    const timeLabel = fitCursorLabel(time, { x: cx, y: time.y + time.height / 2 }, ctx.measureText(values.time).width);
    for (const [rect, text] of [[priceLabel, values.price], [timeLabel, values.time]] as const) {
      ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip();
      ctx.fillStyle = "#333333"; ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.fillStyle = "#ffffff";
      if (rect.width > 8) ctx.fillText(text, rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width - 8);
      ctx.restore();
    }
    this.drawn = { ...values, x, y,
      horizontal: { x: heat.x, y: cy, width: heat.width, height: 1 },
      vertical: { x: cx, y: heat.y, width: 1, height: time.y - heat.y }, priceLabel, timeLabel };
    this.drawCount++;
  }
}
