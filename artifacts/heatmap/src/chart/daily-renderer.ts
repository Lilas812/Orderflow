import type { Viewport } from "../domain.ts";
import { US_PER_SECOND } from "../domain.ts";
import { priceTicksToY, timeUsToX } from "./coordinates.ts";
import { DELTA_COLORS } from "./delta.ts";

export interface DailyPoint { timeUs: number; cvd: number; vwap: number }
export interface DailyDrawOptions { vwap: boolean; cvd: boolean; historyRevision: number; partial: boolean; unknown: boolean }

/** User-requested yellow VWAP; CVD reuses the established delta white-lavender. */
export const DAILY_COLORS = { vwap: "#ffd60a", under: "#000000", cvd: DELTA_COLORS.positive,
  zero: "#252431", axis: "#d9d9d9", muted: "#8a8a8a" } as const;
const HEADROOM = 0.12;

function prepare(canvas: HTMLCanvasElement, dpr: number) {
  const { width, height } = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const context = canvas.getContext("2d");
  if (!context) throw Error("Daily Canvas 2D is unavailable");
  context.setTransform(w / Math.max(1, width), 0, 0, h / Math.max(1, height), 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width: Math.max(1, width), height: Math.max(1, height), w, h };
}

/** First index with timeUs >= t. */
function lowerBound(points: readonly DailyPoint[], t: number, end: number): number {
  let lo = 0, hi = end;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid]!.timeUs < t) lo = mid + 1; else hi = mid; }
  return lo;
}

export function formatQuantity(v: number): string {
  const a = Math.abs(v), s = v < 0 ? "−" : v > 0 ? "+" : "";
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${s}${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `${s}${Math.round(a)}`;
}

interface Cache { key: string; canvas: HTMLCanvasElement | null; tailFrom: number }

export class DailyIndicatorRenderer {
  private readonly vwapCanvas: HTMLCanvasElement;
  private readonly cvdCanvas: HTMLCanvasElement;
  private readonly cvdAxis: HTMLCanvasElement;
  private vwapCache: Cache = { key: "", canvas: null, tailFrom: -1 };
  private cvdCache: Cache = { key: "", canvas: null, tailFrom: -1 };
  private envelope = { min: 0, max: 0, key: "" };
  metrics = { drawMs: 0, drawCount: 0, historyBuilds: 0, tailDraws: 0, pointCount: 0, cvdMin: 0, cvdMax: 0 };

  constructor(vwapCanvas: HTMLCanvasElement, cvdCanvas: HTMLCanvasElement, cvdAxis: HTMLCanvasElement) {
    this.vwapCanvas = vwapCanvas; this.cvdCanvas = cvdCanvas; this.cvdAxis = cvdAxis;
  }

  draw(points: readonly DailyPoint[], view: Viewport, options: DailyDrawOptions): void {
    const started = performance.now(), dpr = window.devicePixelRatio || 1;
    const n = points.length, stable = Math.max(0, n - 2);
    const startUs = view.startUs, endUs = view.startUs + view.durationSec * US_PER_SECOND;
    // Visible stable slice with one neighbour each side (binary search, no full-day scan).
    const lo = Math.max(0, lowerBound(points, startUs, stable) - 1);
    const hi = Math.min(stable, lowerBound(points, endUs, stable) + 1); // exclusive
    const geo = `${view.startUs}|${view.durationSec}|${dpr}|${options.historyRevision}|${stable}`;
    const vwap = prepare(this.vwapCanvas, dpr);
    if (options.vwap && n > 0) this.drawVwap(points, view, vwap, lo, hi, stable, geo);
    const cvd = prepare(this.cvdCanvas, dpr), axis = prepare(this.cvdAxis, dpr);
    if (options.cvd && n > 0) this.drawCvd(points, cvd, axis, lo, hi, stable, geo, view, options);
    this.metrics = { ...this.metrics, drawMs: performance.now() - started, drawCount: this.metrics.drawCount + 1,
      pointCount: n };
  }

  private offscreen(cache: Cache, w: number, h: number): HTMLCanvasElement {
    const c = cache.canvas ?? document.createElement("canvas");
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    cache.canvas = c; return c;
  }

  private stroke(ctx: CanvasRenderingContext2D, color: string, width: number) {
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = DAILY_COLORS.under; ctx.lineWidth = width + 2; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    ctx.lineJoin = "miter"; ctx.lineCap = "butt";
  }

  private trace(ctx: CanvasRenderingContext2D, points: readonly DailyPoint[], from: number, to: number,
    x: (p: DailyPoint) => number, y: (p: DailyPoint) => number): boolean {
    let started = false, lastX = NaN;
    for (let i = from; i < to; i++) {
      const p = points[i]!, px = x(p), py = y(p);
      if (!Number.isFinite(px) || !Number.isFinite(py)) { started = false; continue; }
      if (!started) { ctx.moveTo(px, py); started = true; }
      else if (Math.abs(px - lastX) >= 0.25 || i === to - 1) ctx.lineTo(px, py);
      else continue;
      lastX = px;
    }
    return started;
  }

  private composite(target: { context: CanvasRenderingContext2D; width: number; height: number; w: number; h: number },
    cache: Cache, key: string, build: (ctx: CanvasRenderingContext2D) => void) {
    if (cache.key !== key || !cache.canvas) {
      const off = this.offscreen(cache, target.w, target.h), c = off.getContext("2d")!;
      c.setTransform(target.w / target.width, 0, 0, target.h / target.height, 0, 0);
      c.clearRect(0, 0, target.width, target.height);
      c.save(); c.beginPath(); c.rect(0, 0, target.width, target.height); c.clip();
      build(c); c.restore();
      cache.key = key; this.metrics.historyBuilds++;
    }
    target.context.drawImage(cache.canvas!, 0, 0, target.width, target.height);
  }

  private drawVwap(points: readonly DailyPoint[], view: Viewport,
    t: ReturnType<typeof prepare>, lo: number, hi: number, stable: number, geo: string) {
    const key = `${geo}|${t.w}x${t.h}|${view.centerPriceTicks}|${view.priceSpanTicks}`;
    const x = (p: DailyPoint) => timeUsToX(p.timeUs, view, t.width);
    const y = (p: DailyPoint) => priceTicksToY(p.vwap, view, t.height);
    this.composite(t, this.vwapCache, key, c => {
      c.beginPath(); if (this.trace(c, points, lo, hi, x, y)) this.stroke(c, DAILY_COLORS.vwap, 1.5);
    });
    this.drawTail(t.context, t.width, t.height, points, stable, x, y, DAILY_COLORS.vwap);
  }

  private drawTail(ctx: CanvasRenderingContext2D, width: number, height: number, points: readonly DailyPoint[],
    stable: number, x: (p: DailyPoint) => number, y: (p: DailyPoint) => number, color: string) {
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
    ctx.beginPath();
    if (this.trace(ctx, points, Math.max(0, stable - 1), points.length, x, y)) this.stroke(ctx, color, 1.5);
    ctx.restore(); this.metrics.tailDraws++;
  }

  private drawCvd(points: readonly DailyPoint[], t: ReturnType<typeof prepare>, axis: ReturnType<typeof prepare>,
    lo: number, hi: number, stable: number, geo: string, view: Viewport, options: DailyDrawOptions) {
    const n = points.length;
    let tMin = Infinity, tMax = -Infinity;
    for (let i = Math.max(0, stable - 1); i < n; i++) {
      const v = points[i]!.cvd; if (Number.isFinite(v)) { tMin = Math.min(tMin, v); tMax = Math.max(tMax, v); }
    }
    const env = this.envelope;
    if (env.key !== geo || tMin < env.min || tMax > env.max) {
      let min = 0, max = 0; // zero always in range for the baseline
      for (let i = lo; i < hi; i++) { const v = points[i]!.cvd; if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; } }
      if (tMin < min) min = tMin; if (tMax > max) max = tMax;
      let span = max - min; if (!(span > 0)) span = 1;
      env.min = min < 0 ? min - span * HEADROOM : 0; env.max = max > 0 ? max + span * HEADROOM : 0;
      if (env.max - env.min <= 0) { env.max = 1; env.min = -1; }
      env.key = geo;
    }
    const { min, max } = env, pad = 3, usable = Math.max(1, t.height - pad * 2);
    const yOf = (v: number) => pad + (max - v) / (max - min) * usable;
    const x = (p: DailyPoint) => timeUsToX(p.timeUs, view, t.width);
    const y = (p: DailyPoint) => yOf(p.cvd);
    const zeroY = yOf(0);
    this.composite(t, this.cvdCache, `${geo}|${t.w}x${t.h}|${min}|${max}`, c => {
      c.strokeStyle = DAILY_COLORS.zero; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, zeroY); c.lineTo(t.width, zeroY); c.stroke();
      c.beginPath(); if (this.trace(c, points, lo, hi, x, y)) this.stroke(c, DAILY_COLORS.cvd, 1.25);
    });
    this.drawTail(t.context, t.width, t.height, points, stable, x, y, DAILY_COLORS.cvd);
    // Quantity axis (contracts, not price ticks).
    const a = axis.context, ah = axis.height, lw = Math.max(1, axis.width - 2);
    const ay = (v: number) => pad + (max - v) / (max - min) * Math.max(1, ah - pad * 2);
    a.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"; a.fillStyle = DAILY_COLORS.axis;
    a.textAlign = "center";
    a.textBaseline = "top"; a.fillText(formatQuantity(max), axis.width / 2, 2, lw);
    a.textBaseline = "bottom"; a.fillText(formatQuantity(min), axis.width / 2, ah - 2, lw);
    const zy = ay(0);
    if (zy > 16 && zy < ah - 16) { a.textAlign = "left"; a.textBaseline = "middle"; a.fillText("0", 2, zy, lw); }
    const last = points[n - 1]!.cvd;
    if (Number.isFinite(last)) {
      const ly = Math.max(9, Math.min(ah - 9, ay(last)));
      a.fillStyle = DAILY_COLORS.cvd; a.fillRect(0, ly - 9, axis.width, 18);
      a.fillStyle = "#0b0a12"; a.font = "11px ui-monospace, monospace"; a.textAlign = "center"; a.textBaseline = "middle";
      a.fillText(formatQuantity(last), axis.width / 2, ly, lw);
    }
    if (options.partial || options.unknown) {
      t.context.font = "11px ui-monospace, monospace"; t.context.fillStyle = DAILY_COLORS.muted;
      t.context.textAlign = "left"; t.context.textBaseline = "top";
      t.context.fillText(options.unknown ? "CVD ?" : "CVD partial", 4, 3);
    }
    this.metrics.cvdMin = min; this.metrics.cvdMax = max;
  }
}
