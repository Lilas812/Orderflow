import type { HeatColumn, Viewport } from "../domain.ts";
import { US_PER_SECOND } from "../domain.ts";
import type { TradeAggregator } from "../data/trade-aggregate.ts";
import { COLOR_LUT, colorPosition, lutIndex } from "./palette.ts";

/* ---------- SPEC 7 "glow" primitives (pure) ---------- */

/** K = rows per price: physical row height rounded, clamped to 2..10. */
export function glowK(pixelsPerTick: number): number {
  const k = Math.round(pixelsPerTick);
  return Math.max(2, Math.min(10, Number.isFinite(k) ? k : 2));
}

/** Strength of sub-row i (0..K-1). */
export function rowStrength(i: number, k: number): number {
  const d = Math.abs(i - (k - 1) / 2) / (k / 2);
  if (d < 0.35) return 1;
  return Math.max(0, 1 - (d - 0.35) / 0.65) ** 1.5;
}

export function coreAlpha(strength: number): number { return Math.min(1, strength * 1.4); }
export function glowSigma(k: number): number { return Math.max(1.2, 0.75 * k); }
export function glowRadius(k: number): number { return Math.ceil(2.5 * glowSigma(k)); }
export const GLOW_GAIN = 1.8;
export const GLOW_OPACITY = 0.9;
export const APPEAR_COLUMNS = 6;
export const CANCEL_COLUMNS = 4;

/** Normalised Gaussian kernel of length 2r+1. */
export function gaussianKernel(k: number): Float32Array {
  const sigma = glowSigma(k), r = glowRadius(k);
  const out = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); out[i + r] = v; sum += v; }
  for (let i = 0; i < out.length; i++) out[i]! /= sum;
  return out;
}

export function verticalBlur(values: Float32Array, kernel: Float32Array, out = new Float32Array(values.length)): Float32Array {
  const r = (kernel.length - 1) >> 1, n = values.length;
  out.fill(0);
  for (let y = 0; y < n; y++) {
    const v = values[y]!;
    if (v === 0) continue;
    const from = Math.max(0, y - r), to = Math.min(n - 1, y + r);
    for (let t = from; t <= to; t++) out[t]! += v * kernel[t - y + r]!;
  }
  return out;
}

/** Painted state per price: 0 not painted, 1 painted, 2 unknown (no column / outside the 400 levels). */
export const NOT_PAINTED = 0, PAINTED = 1, UNKNOWN = 2;

/**
 * Edge fade for one price in drawn column j. `state(o)` returns the painted state at column j+o,
 * `eaten(o)` whether column j+o had a trade at this price (7.1 aggregation).
 * Appearance: (k+1)/7 for the first 6 painted columns after a not-painted column; a run that
 * reaches back to unknown data (left edge of held data or a >=3s gap) does not fade.
 * Cancel: (k+1)/5 for the 4 columns before the first not-painted column, unless eaten.
 * Both apply -> multiply appearance and cancellation (user-approved Phase 14 rule).
 */
export function fadeFactor(state: (offset: number) => number, eaten: (offset: number) => boolean): number {
  if (state(0) !== PAINTED) return 0;
  let appear = 1;
  for (let k = 0; k < APPEAR_COLUMNS; k++) {
    const prev = state(-k - 1);
    if (prev === PAINTED) continue;
    if (prev === NOT_PAINTED) appear = (k + 1) / (APPEAR_COLUMNS + 1);
    break;
  }
  let cancel = 1;
  for (let k = 0; k < CANCEL_COLUMNS; k++) {
    const next = state(k + 1);
    if (next === PAINTED) continue;
    if (next === NOT_PAINTED && !eatenAtVanish(eaten, k)) cancel = (k + 1) / (CANCEL_COLUMNS + 1);
    break;
  }
  return appear * cancel;
}

/** SPEC 7: only a trade in the last painted column before disappearance counts as eaten. */
function eatenAtVanish(eaten: (offset: number) => boolean, k: number): boolean {
  return eaten(k);
}

/** Per-row strengths for K, cached. */
const strengthCache = new Map<number, Float32Array>();
export function rowStrengths(k: number): Float32Array {
  let s = strengthCache.get(k);
  if (!s) { s = Float32Array.from({ length: k }, (_, i) => rowStrength(i, k)); strengthCache.set(k, s); }
  return s;
}

/** Core values (t' x fade x strength) for one drawn column; positions ordered top (high price) first. */
export function coreColumn(positions: Float32Array, k: number, out = new Float32Array(positions.length * k)): Float32Array {
  const s = rowStrengths(k);
  for (let p = 0; p < positions.length; p++) {
    const t = positions[p]!;
    for (let i = 0; i < k; i++) out[p * k + i] = t * s[i]!;
  }
  return out;
}

/**
 * Final RGBA of a column: black -> glow (LUT[min(1, 1.8*h)], opacity 0.9) -> core (LUT[c], alpha min(1,1.4*s)).
 * h = horizontal [1,2,1]/4 of the vertically blurred core of left/self/right columns (missing = 0).
 * Rows with core value 0 draw no core (the glow below stays visible).
 */
export function composeColumn(core: Float32Array, k: number, left: Float32Array | null, self: Float32Array,
  right: Float32Array | null, out = new Uint8ClampedArray(core.length * 4)): Uint8ClampedArray {
  const s = rowStrengths(k);
  for (let y = 0; y < core.length; y++) {
    const h = ((left ? left[y]! : 0) + 2 * self[y]! + (right ? right[y]! : 0)) / 4;
    const gi = lutIndex(Math.min(1, h * GLOW_GAIN)) * 3;
    let r = COLOR_LUT[gi]! * GLOW_OPACITY, g = COLOR_LUT[gi + 1]! * GLOW_OPACITY, b = COLOR_LUT[gi + 2]! * GLOW_OPACITY;
    const c = core[y]!;
    if (c > 0) {
      const a = coreAlpha(s[y % k]!), ci = lutIndex(c) * 3;
      r = r * (1 - a) + COLOR_LUT[ci]! * a; g = g * (1 - a) + COLOR_LUT[ci + 1]! * a; b = b * (1 - a) + COLOR_LUT[ci + 2]! * a;
    }
    const o = y * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  }
  return out;
}

/* ---------- Incremental column-local raster ---------- */

export interface GlowScale { upper: number; lower: number; gamma: number; }
export interface GlowMetrics {
  buckets: number; bucketSec: number; k: number; rows: number;
  sizeRecomputed: number; blurRecomputed: number; composeRecomputed: number; fullFlush: boolean; glowMs: number;
}

interface BucketEntry {
  refs: (HeatColumn | null)[];
  sizes: Uint32Array;          // max size per price row (top = high price)
  known: Uint8Array;           // 1 when price within the column's received levels
  hasData: boolean;
  trades: Uint8Array | null;   // 1 when a trade printed at the price
  tradeSig: string;
  state: Uint8Array | null;    // painted state, derived from sizes + Lo
  core: Float32Array | null;
  blur: Float32Array | null;
  rgba: Uint8ClampedArray | null;
}

export interface GlowFrame {
  image: Uint8ClampedArray; width: number; height: number;
  firstBucket: number; bucketSec: number; topPrice: number; priceCount: number; k: number;
}

/** Drawn-column width: 1 second, or the smallest whole-second bucket ≲ one physical pixel. */
export function glowBucketSeconds(durationSec: number, widthPx: number): number {
  return Math.max(1, Math.ceil(durationSec / Math.max(1, widthPx) - 1e-9));
}

/**
 * Column-local cached glow raster keyed by absolute bucket index.
 * - A new/replaced column (or changed trades) at bucket b recomputes sizes at b,
 *   cores/blur at [b-4, b+6] (fade reach) and composed RGBA at [b-5, b+7] (horizontal 1:2:1).
 * - Panning by whole buckets reuses every cached bucket; only newly exposed buckets are computed.
 * - Price range, K, bucket width, U, Lo or gamma changing flushes the cache (colour depends on them).
 */
export class GlowRaster {
  private entries = new Map<number, BucketEntry>();
  private geomKey = "";
  private colorKey = "";
  private tradeRevision = -1;
  private image: Uint8ClampedArray | null = null;
  private imageKey = "";
  metrics: GlowMetrics = { buckets: 0, bucketSec: 1, k: 2, rows: 0, sizeRecomputed: 0, blurRecomputed: 0,
    composeRecomputed: 0, fullFlush: false, glowMs: 0 };

  reset(): void { this.entries.clear(); this.geomKey = ""; this.colorKey = ""; this.image = null; this.imageKey = ""; this.tradeRevision = -1; }

  frame(columnAt: (second: number) => HeatColumn | null, view: Viewport, widthPx: number, heightPx: number,
    scale: GlowScale, trades: TradeAggregator | null): GlowFrame {
    const started = performance.now();
    const bucketSec = glowBucketSeconds(view.durationSec, widthPx);
    const pxPerTick = heightPx / view.priceSpanTicks;
    const k = glowK(pxPerTick);
    const radius = glowRadius(k);
    const margin = Math.ceil(radius / k) + 1;
    const top = view.centerPriceTicks + view.priceSpanTicks / 2, bottom = top - view.priceSpanTicks;
    const topPrice = Math.ceil(top + 0.5) - 1 + margin;
    const bottomPrice = Math.floor(bottom - 0.5) + 1 - margin;
    const priceCount = Math.max(1, topPrice - bottomPrice + 1);
    const rows = priceCount * k;
    const startSec = view.startUs / US_PER_SECOND, endSec = startSec + view.durationSec;
    const first = Math.floor(startSec / bucketSec), last = Math.max(first, Math.ceil(endSec / bucketSec) - 1);
    const sFrom = first - APPEAR_COLUMNS - 1, sTo = last + CANCEL_COLUMNS + 2;

    const geomKey = `${bucketSec}|${topPrice}|${priceCount}|${k}`;
    const colorKey = `${scale.upper}|${scale.lower}|${scale.gamma}`;
    let fullFlush = false;
    if (geomKey !== this.geomKey) { this.entries.clear(); this.geomKey = geomKey; this.tradeRevision = -1; fullFlush = true; }
    if (colorKey !== this.colorKey) {
      for (const e of this.entries.values()) { e.state = e.core = e.blur = null; e.rgba = null; }
      this.colorKey = colorKey; fullFlush = true;
    }
    for (const b of [...this.entries.keys()]) if (b < sFrom || b > sTo) this.entries.delete(b);

    // 1. sizes per bucket (identity of the drawn 1s columns, gap fill included)
    const changed = new Set<number>();
    let sizeRecomputed = 0;
    for (let b = sFrom; b <= sTo; b++) {
      const refs: (HeatColumn | null)[] = [];
      for (let s = b * bucketSec; s < (b + 1) * bucketSec; s++) refs.push(columnAt(s));
      const prev = this.entries.get(b);
      if (prev && prev.refs.length === refs.length && prev.refs.every((r, i) => r === refs[i])) continue;
      const entry = buildSizes(refs, topPrice, priceCount);
      if (prev) { entry.trades = prev.trades; entry.tradeSig = prev.tradeSig; } else this.tradeRevision = -1;
      this.entries.set(b, entry);
      sizeRecomputed++;
      changed.add(b);
    }

    // 2. trades per bucket (eaten cut) — only rescanned when the aggregation changed
    if (trades && trades.revision !== this.tradeRevision) {
      this.tradeRevision = trades.revision;
      const masks = new Map<number, Set<number>>();
      for (const cell of trades.cells(sFrom * bucketSec * US_PER_SECOND, (sTo + 1) * bucketSec * US_PER_SECOND)) {
        const row = topPrice - cell.price;
        if (row < 0 || row >= priceCount || cell.buy + cell.sell <= 0) continue;
        const b = Math.floor(cell.secondUs / US_PER_SECOND / bucketSec);
        let set = masks.get(b); if (!set) masks.set(b, set = new Set());
        set.add(row);
      }
      for (let b = sFrom; b <= sTo; b++) {
        const e = this.entries.get(b)!;
        const set = masks.get(b);
        const sig = set ? [...set].sort((x, y) => x - y).join(",") : "";
        if (sig === e.tradeSig) continue;
        e.tradeSig = sig;
        e.trades = set ? new Uint8Array(priceCount) : null;
        if (set) for (const r of set) e.trades![r] = 1;
        changed.add(b);
      }
    }

    // 3. invalidate fade/blur reach of changed buckets
    for (const b of changed) {
      for (let j = b - CANCEL_COLUMNS - 1; j <= b + APPEAR_COLUMNS; j++) {
        const e = this.entries.get(j);
        if (e) { e.core = e.blur = null; e.rgba = null; }
      }
      for (const j of [b - CANCEL_COLUMNS - 2, b + APPEAR_COLUMNS + 1]) { const e = this.entries.get(j); if (e) e.rgba = null; }
    }

    const stateOf = (b: number): Uint8Array | null => {
      const e = this.entries.get(b);
      if (!e) return null;
      if (!e.state) {
        e.state = new Uint8Array(priceCount);
        for (let p = 0; p < priceCount; p++) {
          e.state[p] = !e.hasData || !e.known[p] ? UNKNOWN
            : e.sizes[p]! >= 1 && e.sizes[p]! > scale.lower ? PAINTED : NOT_PAINTED;
        }
      }
      return e.state;
    };

    // 4. core + vertical blur for [first-1, last+1]
    const kernel = gaussianKernel(k);
    let blurRecomputed = 0;
    const positions = new Float32Array(priceCount);
    for (let b = first - 1; b <= last + 1; b++) {
      const e = this.entries.get(b)!;
      if (e.blur) continue;
      blurRecomputed++;
      positions.fill(0);
      if (e.hasData) {
        const states: (Uint8Array | null)[] = [];
        for (let o = -APPEAR_COLUMNS; o <= CANCEL_COLUMNS + 1; o++) states.push(stateOf(b + o));
        for (let p = 0; p < priceCount; p++) {
          if (e.state![p] !== PAINTED) continue;
          const fade = fadeFactor(o => states[o + APPEAR_COLUMNS]?.[p] ?? UNKNOWN,
            o => !!this.entries.get(b + o)?.trades?.[p]);
          positions[p] = colorPosition(e.sizes[p]!, scale.upper, scale.lower, scale.gamma) * fade;
        }
      }
      e.core = coreColumn(positions, k);
      e.blur = verticalBlur(e.core, kernel);
      const l = this.entries.get(b - 1), r = this.entries.get(b + 1);
      if (l) l.rgba = null;
      if (r) r.rgba = null;
      e.rgba = null;
    }

    // 5. compose RGBA for visible buckets
    const width = last - first + 1;
    const imageKey = `${geomKey}|${first}|${width}`;
    const reuse = this.image && this.imageKey === imageKey && !fullFlush;
    if (!reuse) this.image = new Uint8ClampedArray(width * rows * 4);
    const image = this.image!;
    this.imageKey = imageKey;
    let composeRecomputed = 0;
    for (let b = first; b <= last; b++) {
      const e = this.entries.get(b)!;
      if (e.rgba && reuse) continue;
      if (!e.rgba) {
        composeRecomputed++;
        e.rgba = composeColumn(e.core!, k, this.entries.get(b - 1)?.blur ?? null, e.blur!, this.entries.get(b + 1)?.blur ?? null);
      }
      const x = b - first, src = e.rgba;
      for (let y = 0; y < rows; y++) {
        const si = y * 4, di = (y * width + x) * 4;
        image[di] = src[si]!; image[di + 1] = src[si + 1]!; image[di + 2] = src[si + 2]!; image[di + 3] = 255;
      }
    }
    this.metrics = { buckets: width, bucketSec, k, rows, sizeRecomputed, blurRecomputed, composeRecomputed, fullFlush,
      glowMs: performance.now() - started };
    return { image, width, height: rows, firstBucket: first, bucketSec, topPrice, priceCount, k };
  }
}

function buildSizes(refs: (HeatColumn | null)[], topPrice: number, priceCount: number): BucketEntry {
  const sizes = new Uint32Array(priceCount), known = new Uint8Array(priceCount);
  let hasData = false;
  for (const column of refs) {
    if (!column) continue;
    hasData = true;
    let lo = Infinity, hi = -Infinity;
    for (const side of [column.bids, column.asks]) {
      for (let i = 0; i < side.prices.length; i++) {
        const price = side.prices[i]!, size = side.sizes[i]!;
        if (price < lo) lo = price;
        if (price > hi) hi = price;
        const row = topPrice - price;
        if (row >= 0 && row < priceCount && size > sizes[row]!) sizes[row] = size;
      }
    }
    // Inside the received 400 levels a missing price means "no order"; outside it is unknown.
    for (let row = Math.max(0, topPrice - hi); row <= Math.min(priceCount - 1, topPrice - lo); row++) known[row] = 1;
  }
  return { refs, sizes, known, hasData, trades: null, tradeSig: "", state: null, core: null, blur: null, rgba: null };
}

/** One glow column for a single book (current-book band): no fade, horizontal neighbours equal to itself. */
export function glowBookColumn(book: HeatColumn | null, view: Viewport, heightPx: number, scale: GlowScale) {
  const k = glowK(heightPx / view.priceSpanTicks);
  const margin = Math.ceil(glowRadius(k) / k) + 1;
  const top = view.centerPriceTicks + view.priceSpanTicks / 2, bottom = top - view.priceSpanTicks;
  const topPrice = Math.ceil(top + 0.5) - 1 + margin;
  const priceCount = Math.max(1, topPrice - (Math.floor(bottom - 0.5) + 1 - margin) + 1);
  const entry = buildSizes([book], topPrice, priceCount);
  const positions = new Float32Array(priceCount);
  for (let p = 0; p < priceCount; p++) positions[p] = colorPosition(entry.sizes[p]!, scale.upper, scale.lower, scale.gamma);
  const core = coreColumn(positions, k);
  const blur = verticalBlur(core, gaussianKernel(k));
  return { rgba: composeColumn(core, k, blur, blur, blur), k, topPrice, priceCount };
}
