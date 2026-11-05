import type { HeatColumn, Viewport } from "../domain.ts";
import { COLOR_LUT, lutIndex } from "./palette.ts";
import { coreAlpha, fadeFactor, gaussianKernel, glowK, rowStrength, verticalBlur } from "./glow.ts";
import type { TradeAggregator } from "../data/trade-aggregate.ts";

export interface SmoothingOptions { time: "mean" | "max"; price: "auto" | "none" }
export const DEFAULT_SMOOTHING: SmoothingOptions = { time: "mean", price: "auto" };
/** Mergeable sufficient statistics: never average averages. */
export interface WeightedQuantity { sum: number; weight: number; max: number }
export function mergeQuantity(a: WeightedQuantity, b: WeightedQuantity): WeightedQuantity {
  return { sum: a.sum + b.sum, weight: a.weight + b.weight, max: Math.max(a.max, b.max) };
}
export function temporalQuantities(columns: readonly HeatColumn[], from: number, to: number): Map<number, WeightedQuantity> {
  const ticks = new Map<number, WeightedQuantity>();
  for (const c of columns) {
    const sec = c.timeUs / 1e6, weight = Math.max(0, Math.min(to, sec + 1) - Math.max(from, sec));
    if (!weight) continue;
    // Only explicitly represented prices are known, including explicit zero.
    // Sparse holes and outside-of-depth prices are NOT inferred zero.
    const values = new Map<number, number>();
    for (const side of [c.bids, c.asks]) for (let i = 0; i < side.prices.length; i++)
      values.set(side.prices[i]!, Math.max(values.get(side.prices[i]!) ?? 0, side.sizes[i]!));
    for (const [p, n] of values) ticks.set(p, mergeQuantity(ticks.get(p) ?? { sum: 0, weight: 0, max: 0 },
      { sum: n * weight, weight, max: n }));
  }
  return ticks;
}
export interface ProfileColumn { readonly id: number; readonly values: Float32Array; readonly coverage: Float32Array }
export interface ProfileFrame {
  list: readonly ProfileColumn[]; start: number; dx: number; aligned: boolean; firstPixel: number; top: number;
  step: number; k: number; kernel: Float32Array; strength: Float64Array; strengthKey: string;
  eaten: ReadonlyMap<number, { mask: Uint8Array; signature: string }>; eatenVersion: number; recomputed: number; cachedBytes: number;
}
export function projectQuantities(ticks: ReadonlyMap<number, WeightedQuantity>, duration: number,
  top: number, span: number, height: number, options: SmoothingOptions) {
  const values = new Float32Array(height), weights = new Float32Array(height);
  for (const [price, q] of ticks) {
    const a = (top - price - .5) / span * height, b = (top - price + .5) / span * height;
    const quantity = options.time === "mean" ? q.sum / q.weight : q.max;
    for (let y = Math.max(0, Math.floor(a)); y < Math.min(height, Math.ceil(b)); y++) {
      const overlap = Math.max(0, Math.min(y + 1, b) - Math.max(y, a)), weight = overlap * q.weight;
      weights[y]! += weight;
      if (options.price === "auto" && height < span) values[y]! += quantity * weight;
      else values[y] = Math.max(values[y]!, quantity);
    }
  }
  for (let y = 0; y < height; y++) {
    if (options.price === "auto" && height < span && weights[y]! > 0) values[y]! /= weights[y]!;
    weights[y] = Math.min(1, weights[y]! / duration);
  }
  return { values, coverage: weights };
}

interface Entry {
  id: number; refs: readonly HeatColumn[]; from: number; to: number;
  values: Float32Array; coverage: Float32Array; core: Float32Array; blur: Float32Array;
  rgba: Uint8ClampedArray; sig: string; paintSig: string; generation: number; bytes: number;
  pixels: Uint32Array; paintVersion: number;
}
/** Only display-derived profiles. Same 2h/48MiB ceiling as existing display tiles.
 * Cache keys contain physical pixel edges and geometry; no RGB resampling. */
export class SmoothingRaster {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private nextId = 0;
  private geometry = "";
  private tradeRevision = -1;
  private tradeKey = "";
  private eaten = new Map<number, { mask: Uint8Array; signature: string }>();
  private list: Entry[] = [];
  private refs: HeatColumn[] = [];
  private bySecond = new Map<number, HeatColumn>();
  private image = new Uint8ClampedArray(0);
  private words = new Uint32Array(0);
  private lastIds = new Int32Array(0);
  private lastPaint = new Int32Array(0);
  private lastPixel = NaN;
  private lastStart = NaN;
  private lastDx = NaN;
  private imageHeight = 0;
  private imageValid = false;
  private kernelK = 0;
  private kernel: Float32Array = new Float32Array(0);
  /** Half-open dirty strips in the retained image; shift is positive to the left. */
  readonly dirtyRanges: [number, number][] = [];
  shiftPixels = 0;
  fullRepaint = true;
  metrics = { recomputedColumns: 0, cachedBytes: 0, coreColumns: 0, paintColumns: 0 };
  reset() { this.entries.clear(); this.bytes = 0; this.geometry = ""; this.tradeRevision = -1; this.imageValid = false; }
  /** Forces the next CPU frame() to repaint fully (its retained image may be stale after GPU frames). */
  invalidateImage() { this.imageValid = false; }
  private eatenVersion = 0;
  private strengthKey = "";
  private strengthRows = new Float64Array(0);
  /**
   * Shared profile stage: cached per physical column quantity/coverage (exact existing sufficient
   * statistics), eaten masks and glow geometry. Used by both frame() (Canvas) and the WebGL renderer.
   */
  profiles(columns: readonly HeatColumn[], view: Viewport, width: number, height: number,
    options: SmoothingOptions, style: "block" | "glow", trades: TradeAggregator | null): ProfileFrame {
    const start = view.startUs / 1e6, dx = view.durationSec / width;
    // followStartUs rounds the epoch-aligned pixel grid to integer microseconds.
    // Round each edge from its absolute grid index, not from the rounded first
    // edge + x*dx: otherwise one-pixel follow changes every interval's phase.
    // Non-aligned pans retain their exact original overlap calculation.
    const pixelUs = view.durationSec * 1e6 / width;
    const firstPixel = Math.round(view.startUs / pixelUs);
    const aligned = Math.round(firstPixel * pixelUs) === view.startUs;
    const edge = (x: number) => aligned
      ? Math.round((firstPixel + x) * pixelUs) / 1e6 : start + x * dx;
    const geometry = `${height}|${view.centerPriceTicks}|${view.priceSpanTicks}|${options.time}|${options.price}`;
    if (geometry !== this.geometry) { this.reset(); this.geometry = geometry; }
    const bySecond = this.bySecond; bySecond.clear();
    // Last version of a second wins. Never feed display interpolation to statistics.
    for (const c of columns) bySecond.set(Math.floor(c.timeUs / 1e6), c);
    const top = view.centerPriceTicks + view.priceSpanTicks / 2;
    const list = this.list; list.length = 0;
    let recomputed = 0;
    for (let x = 0; x < width; x++) {
      const from = edge(x), to = edge(x + 1);
      const refs = this.refs; refs.length = 0;
      for (let s = Math.floor(from); s < Math.ceil(to); s++) { const c = bySecond.get(s); if (c) refs.push(c); }
      const key = `${from}|${to}`;
      let e = this.entries.get(key);
      if (!e || e.refs.length !== refs.length || e.refs.some((c, i) => c !== refs[i])) {
        if (e) { this.bytes -= e.bytes; this.entries.delete(key); }
        const p = projectQuantities(temporalQuantities(refs, from, to), to - from, top, view.priceSpanTicks, height, options);
        const rgba = new Uint8ClampedArray(height * 4);
        e = { ...p, id: ++this.nextId, refs: refs.slice(), from, to, core: new Float32Array(height),
          blur: new Float32Array(height), rgba, pixels: new Uint32Array(rgba.buffer), paintVersion: 0, sig: "", paintSig: "",
          generation: 0, bytes: height * 20 + refs.length * 8 };
        this.bytes += e.bytes; recomputed++;
      } else this.entries.delete(key);
      this.entries.set(key, e); list.push(e);
      while (this.bytes > 48 * 1024 * 1024 && this.entries.size) {
        const k = this.entries.keys().next().value!; this.bytes -= this.entries.get(k)!.bytes; this.entries.delete(k);
      }
    }
    for (const [key, e] of this.entries) if (e.to < start - 7200 || e.from > start + view.durationSec + 7200) {
      this.entries.delete(key); this.bytes -= e.bytes;
    }
    // Eaten cuts use existing trade aggregation, never change underlying quantities.
    const tradeKey = `${start}|${dx}|${width}`;
    if (style === "glow" && trades && (this.tradeRevision !== trades.revision || this.tradeKey !== tradeKey)) {
      this.eaten.clear();
      for (const c of trades.cells(view.startUs, view.startUs + view.durationSec * 1e6)) {
        const x = Math.floor((c.secondUs / 1e6 - start) / dx);
        if (x < 0 || x >= width) continue;
        const first = Math.max(0, Math.floor((top - c.price - .5) / view.priceSpanTicks * height));
        const end = Math.min(height, Math.ceil((top - c.price + .5) / view.priceSpanTicks * height));
        if (first >= end) continue;
        let entry = this.eaten.get(x);
        if (!entry) this.eaten.set(x, entry = { mask: new Uint8Array(height), signature: "" });
        entry.mask.fill(1, first, end);
      }
      for (const e of this.eaten.values()) {
        const rows: number[] = []; for (let y = 0; y < height; y++) if (e.mask[y]) rows.push(y);
        e.signature = rows.join(",");
      }
      this.tradeRevision = trades.revision; this.tradeKey = tradeKey; this.eatenVersion++;
    }
    const step = Math.max(1, Math.round(1 / dx)), k = glowK(height / view.priceSpanTicks);
    if (this.kernelK !== k) { this.kernel = gaussianKernel(k); this.kernelK = k; }
    const strengthKey = `${height}|${top}|${view.priceSpanTicks}|${k}`;
    if (strengthKey !== this.strengthKey) {
      this.strengthKey = strengthKey;
      this.strengthRows = new Float64Array(height);
      for (let y = 0; y < height; y++) {
        if (height < view.priceSpanTicks) { this.strengthRows[y] = 1; continue; }
        const p = top - (y + .5) * view.priceSpanTicks / height;
        this.strengthRows[y] = rowStrength(Math.min(k - 1, Math.floor((Math.round(p) + .5 - p) * k)), k);
      }
    }
    return { list, start, dx, aligned, firstPixel, top, step, k, kernel: this.kernel, strength: this.strengthRows,
      strengthKey, eaten: this.eaten, eatenVersion: this.eatenVersion, recomputed, cachedBytes: this.bytes };
  }
  frame(columns: readonly HeatColumn[], view: Viewport, width: number, height: number,
    options: SmoothingOptions, scale: { upper: number; lower: number; gamma: number },
    style: "block" | "glow", trades: TradeAggregator | null) {
    const prepared = this.profiles(columns, view, width, height, options, style, trades);
    const { dx, aligned, firstPixel, step, kernel, recomputed } = prepared;
    const list = this.list;
    let cores = 0, paints = 0;
    const strengthRows = prepared.strength;
    const strength = (y: number) => strengthRows[y]!;
    const position = (n: number) => n > 0 && n > scale.lower
      ? Math.min(1, Math.max(0, (n - scale.lower) / Math.max(1, scale.upper - scale.lower))) ** scale.gamma : 0;
    const state = (x: number, y: number) => !list[x] || !list[x]!.coverage[y] ? 2 : position(list[x]!.values[y]!) > 0 ? 1 : 0;
    for (let x = 0; x < width; x++) {
      const e = list[x]!;
      let neighbours = "";
      for (let o = -6; o <= 4; o++) {
        const nx = x + o * step;
        neighbours += `${list[nx]?.id ?? 0}:${this.eaten.get(nx)?.signature ?? ""};`;
      }
      const sig = `${style}|${scale.upper}|${scale.lower}|${scale.gamma}|${neighbours}`;
      if (sig === e.sig) continue;
      for (let y = 0; y < height; y++) {
        const fade = style === "glow" ? fadeFactor(o => state(x + o * step, y),
          o => Boolean(this.eaten.get(x + o * step)?.mask[y])) : 1;
        e.core[y] = position(e.values[y]!) * fade * (style === "glow" ? strength(y) : 1);
      }
      verticalBlur(e.core, kernel, e.blur as Float32Array<ArrayBuffer>);
      e.sig = sig; e.generation++; cores++;
    }
    if (this.lastIds.length !== width || this.imageHeight !== height) {
      this.image = new Uint8ClampedArray(width * height * 4);
      this.words = new Uint32Array(this.image.buffer);
      this.lastIds = new Int32Array(width); this.lastPaint = new Int32Array(width);
      this.imageHeight = height; this.imageValid = false;
    }
    const shift = aligned && Number.isFinite(this.lastPixel) && dx === this.lastDx
      ? firstPixel - this.lastPixel : view.startUs === this.lastStart && dx === this.lastDx ? 0 : NaN;
    this.fullRepaint = !this.imageValid || !Number.isInteger(shift) || Math.abs(shift) >= width;
    this.shiftPixels = this.fullRepaint ? 0 : shift;
    this.dirtyRanges.length = 0;
    // Typed row memmove, not a strided JS copy of every RGBA channel.
    if (!this.fullRepaint && shift) for (let y = 0; y < height; y++) {
      const row = y * width;
      if (shift > 0) this.words.copyWithin(row, row + shift, row + width);
      else this.words.copyWithin(row - shift, row, row + width + shift);
    }
    for (let x = 0; x < width; x++) {
      const e = list[x]!, left = list[x - 1], right = list[x + 1];
      const sig = `${e.generation}|${left?.generation ?? 0}:${left?.id ?? 0}|${right?.generation ?? 0}:${right?.id ?? 0}`;
      if (sig !== e.paintSig) {
        for (let y = 0; y < height; y++) {
          const c = e.core[y]!, ci = lutIndex(c) * 3, coverage = e.coverage[y]!;
          const h = ((left?.blur[y] ?? 0) + 2 * e.blur[y]! + (right?.blur[y] ?? 0)) / 4;
          const gi = lutIndex(Math.min(1, h * 1.8)) * 3, a = c > 0 ? coreAlpha(strength(y)) : 0;
          for (let channel = 0; channel < 3; channel++) e.rgba[y * 4 + channel] = coverage * (style === "block"
            ? (c > 0 ? COLOR_LUT[ci + channel]! : 0)
            : COLOR_LUT[gi + channel]! * .9 * (1 - a) + COLOR_LUT[ci + channel]! * a);
          e.rgba[y * 4 + 3] = 255;
        }
        e.paintSig = sig; e.paintVersion++; paints++;
      }
      const previousX = x + this.shiftPixels;
      if (this.fullRepaint || previousX < 0 || previousX >= width
        || this.lastIds[previousX] !== e.id || this.lastPaint[previousX] !== e.paintVersion) {
        const last = this.dirtyRanges.at(-1);
        if (last?.[1] === x) last[1] = x + 1;
        else this.dirtyRanges.push([x, x + 1]);
      }
    }
    for (const [from, to] of this.dirtyRanges) for (let y = 0; y < height; y++)
      for (let x = from; x < to; x++) this.words[y * width + x] = list[x]!.pixels[y]!;
    for (let x = 0; x < width; x++) {
      this.lastIds[x] = list[x]!.id; this.lastPaint[x] = list[x]!.paintVersion;
    }
    this.imageValid = true; this.lastStart = view.startUs; this.lastDx = dx;
    this.lastPixel = aligned ? firstPixel : NaN;
    this.metrics = { recomputedColumns: recomputed, cachedBytes: this.bytes, coreColumns: cores, paintColumns: paints };
    return this.image;
  }
}
