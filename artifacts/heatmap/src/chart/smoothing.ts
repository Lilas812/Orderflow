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
  metrics = { recomputedColumns: 0, cachedBytes: 0, coreColumns: 0, paintColumns: 0 };
  reset() { this.entries.clear(); this.bytes = 0; this.geometry = ""; this.tradeRevision = -1; }
  frame(columns: readonly HeatColumn[], view: Viewport, width: number, height: number,
    options: SmoothingOptions, scale: { upper: number; lower: number; gamma: number },
    style: "block" | "glow", trades: TradeAggregator | null) {
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
    const bySecond = new Map<number, HeatColumn>();
    // Last version of a second wins. Never feed display interpolation to statistics.
    for (const c of columns) bySecond.set(Math.floor(c.timeUs / 1e6), c);
    const top = view.centerPriceTicks + view.priceSpanTicks / 2;
    const list: Entry[] = [];
    let recomputed = 0, cores = 0, paints = 0;
    for (let x = 0; x < width; x++) {
      const from = edge(x), to = edge(x + 1);
      const refs: HeatColumn[] = [];
      for (let s = Math.floor(from); s < Math.ceil(to); s++) { const c = bySecond.get(s); if (c) refs.push(c); }
      const key = `${from}|${to}`;
      let e = this.entries.get(key);
      if (!e || e.refs.length !== refs.length || e.refs.some((c, i) => c !== refs[i])) {
        if (e) { this.bytes -= e.bytes; this.entries.delete(key); }
        const p = projectQuantities(temporalQuantities(refs, from, to), to - from, top, view.priceSpanTicks, height, options);
        e = { ...p, id: ++this.nextId, refs, from, to, core: new Float32Array(height),
          blur: new Float32Array(height), rgba: new Uint8ClampedArray(height * 4), sig: "", paintSig: "",
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
      this.tradeRevision = trades.revision; this.tradeKey = tradeKey;
    }
    const step = Math.max(1, Math.round(1 / dx)), k = glowK(height / view.priceSpanTicks);
    const kernel = gaussianKernel(k);
    const strength = (y: number) => {
      if (height < view.priceSpanTicks) return 1;
      const p = top - (y + .5) * view.priceSpanTicks / height;
      return rowStrength(Math.min(k - 1, Math.floor((Math.round(p) + .5 - p) * k)), k);
    };
    const position = (n: number) => n > 0 && n > scale.lower
      ? Math.min(1, Math.max(0, (n - scale.lower) / Math.max(1, scale.upper - scale.lower))) ** scale.gamma : 0;
    const state = (x: number, y: number) => !list[x] || !list[x]!.coverage[y] ? 2 : position(list[x]!.values[y]!) > 0 ? 1 : 0;
    for (let x = 0; x < width; x++) {
      const e = list[x]!;
      const neighbours: string[] = [];
      for (let o = -6; o <= 4; o++) {
        const nx = x + o * step;
        neighbours.push(`${list[nx]?.id ?? 0}:${this.eaten.get(nx)?.signature ?? ""}`);
      }
      const sig = `${style}|${scale.upper}|${scale.lower}|${scale.gamma}|${neighbours.join(";")}`;
      if (sig === e.sig) continue;
      for (let y = 0; y < height; y++) {
        const fade = style === "glow" ? fadeFactor(o => state(x + o * step, y),
          o => Boolean(this.eaten.get(x + o * step)?.mask[y])) : 1;
        e.core[y] = position(e.values[y]!) * fade * (style === "glow" ? strength(y) : 1);
      }
      verticalBlur(e.core, kernel, e.blur as Float32Array<ArrayBuffer>);
      e.sig = sig; e.generation++; cores++;
    }
    const image = new Uint8ClampedArray(width * height * 4);
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
        e.paintSig = sig; paints++;
      }
      for (let y = 0; y < height; y++) {
        const src = y * 4, dst = (y * width + x) * 4;
        image[dst] = e.rgba[src]!; image[dst + 1] = e.rgba[src + 1]!;
        image[dst + 2] = e.rgba[src + 2]!; image[dst + 3] = 255;
      }
    }
    this.metrics = { recomputedColumns: recomputed, cachedBytes: this.bytes, coreColumns: cores, paintColumns: paints };
    return image;
  }
}
