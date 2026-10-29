import { fitCursorLabel, type CursorPoint, type Rect } from "../chart/crosshair.ts";
import { formatCrosshairTimeUs } from "../chart/timezone.ts";
import type { LvView } from "./view-math.ts";
import { formatInstrumentPrice } from "../instrument.ts";

export interface CvdScale { low: number; high: number; top: number; height: number }
export interface CursorScene {
  view: LvView; plotW: number; priceH: number; cvdTop: number; cvdH: number; timeTop: number;
  width: number; height: number; cvd: CvdScale; timeZone: "Asia/Tokyo" | "America/Chicago";
}
/** Same visible CVD range/padding as the base chart; computed only on base redraw. */
export function cvdScale(points: readonly { v: number }[], top: number, height: number): CvdScale {
  let low = 0, high = 0;
  for (const p of points) { low = Math.min(low, p.v); high = Math.max(high, p.v); }
  if (low === high) high = low + 1;
  const pad = (high - low) * .08;
  return { low: low - pad, high: high + pad, top: top + 4, height: height - 8 };
}
export const cvdY = (value: number, s: CvdScale) => s.top + (s.high - value) / (s.high - s.low) * s.height;

export function longVpCursor(point: CursorPoint, s: CursorScene) {
  const { x, y } = point;
  if (x < 0 || x >= s.plotW || y < 0 || y >= s.timeTop
    || (s.cvdH > 0 && Math.abs(y - s.cvdTop) <= 6)) return null;
  const band = y < s.priceH ? "price" : "cvd";
  if (band === "cvd" && (s.cvdH <= 0 || s.cvd.height <= 0)) return null;
  // Long VP uses seconds and already adjusted ticks, not the heatmap's microsecond viewport.
  const sec = Math.floor(s.view.startSec + x / s.plotW * (s.view.endSec - s.view.startSec));
  const raw = band === "price"
    ? s.view.priceHigh - y / s.priceH * (s.view.priceHigh - s.view.priceLow)
    : s.cvd.high - (y - s.cvd.top) / s.cvd.height * (s.cvd.high - s.cvd.low);
  const value = Math.round(raw);
  return { band, x, y, sec, value, label: band === "price" ? formatInstrumentPrice(value) : String(value),
    time: formatCrosshairTimeUs(sec * 1e6, s.timeZone === "America/Chicago" ? "ct" : "jst") };
}

export class LongVpCrosshair {
  private readonly overlay: HTMLCanvasElement;
  private readonly source: HTMLCanvasElement;
  private readonly scene: () => CursorScene;
  private point: CursorPoint | null = null;
  private frame: number | null = null;
  private key = "";
  private state: ReturnType<typeof longVpCursor> = null;
  private draws = 0;
  private readonly abort = new AbortController();
  constructor(source: HTMLCanvasElement, scene: () => CursorScene) {
    this.source = source; this.scene = scene;
    this.overlay = document.createElement("canvas"); this.overlay.id = "lv-crosshair";
    this.overlay.className = "crosshair-overlay"; this.overlay.setAttribute("aria-hidden", "true");
    source.parentElement!.append(this.overlay);
    const signal = this.abort.signal;
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") { this.hide(); return; }
      this.point = { x: e.clientX, y: e.clientY }; this.request();
    };
    source.addEventListener("pointerenter", move, { signal });
    source.addEventListener("pointermove", move, { signal });
    source.addEventListener("pointerleave", () => this.hide(), { signal });
    source.addEventListener("pointercancel", () => this.hide(), { signal });
    source.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse") this.hide(); }, { signal });
    window.addEventListener("blur", () => this.hide(), { signal });
    window.addEventListener("scroll", () => this.request(), { signal, capture: true, passive: true });
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.hide(); }, { signal });
    document.addEventListener("click", e => {
      if ((e.target as Element | null)?.closest?.('[data-testid="link-view-heatmap"]')) this.hide();
    }, { signal, capture: true });
  }
  snapshot() { return { visible: this.state !== null, drawCount: this.draws, ...this.state }; }
  request() {
    if (!this.point || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
  }
  hide() {
    this.point = null; this.state = null; this.key = "";
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    const ctx = this.overlay.getContext("2d")!;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.overlay.width, this.overlay.height); ctx.restore();
  }
  destroy() { this.hide(); this.abort.abort(); this.overlay.remove(); }
  private draw() {
    if (!this.point || document.hidden || document.querySelector("dialog[open]")) { this.hide(); return; }
    const r = this.source.getBoundingClientRect(), s = this.scene(), dpr = window.devicePixelRatio || 1;
    const point = { x: this.point.x - r.x, y: this.point.y - r.y };
    const value = longVpCursor(point, s);
    if (!value) { this.hide(); return; }
    const key = JSON.stringify([s, point, dpr, r.x, r.y, r.width, r.height]);
    if (key === this.key) return;
    this.key = key;
    this.overlay.style.left = `${this.source.offsetLeft}px`; this.overlay.style.top = `${this.source.offsetTop}px`;
    this.overlay.style.width = `${r.width}px`; this.overlay.style.height = `${r.height}px`;
    this.overlay.width = Math.round(r.width * dpr); this.overlay.height = Math.round(r.height * dpr);
    const ctx = this.overlay.getContext("2d")!;
    ctx.setTransform(this.overlay.width / r.width, 0, 0, this.overlay.height / r.height, 0, 0);
    ctx.strokeStyle = "rgba(235,232,245,0.65)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(0, point.y); ctx.lineTo(s.plotW, point.y);
    ctx.moveTo(point.x, 0); ctx.lineTo(point.x, s.timeTop); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = "11px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const axis: Rect = { x: s.plotW, y: value.band === "price" ? 0 : s.cvdTop,
      width: s.width - s.plotW, height: value.band === "price" ? s.priceH : s.cvdH };
    for (const [region, center, text] of [
      [axis, { x: axis.x + axis.width / 2, y: point.y }, value.label],
      [{ x: 0, y: s.timeTop, width: s.plotW, height: s.height - s.timeTop },
        { x: point.x, y: (s.timeTop + s.height) / 2 }, value.time],
    ] as const) {
      const rect = fitCursorLabel(region, center, ctx.measureText(text).width);
      ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip();
      ctx.fillStyle = "#333333"; ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.fillStyle = "#fff"; if (rect.width > 8) ctx.fillText(text, rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width - 8);
      ctx.restore();
    }
    this.state = value; this.draws++;
  }
}
