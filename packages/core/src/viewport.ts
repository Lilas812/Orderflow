import { validateMarketEvent, type Trade } from "./events";
import type { QualityInterval } from "./qualityTimeline";

export const MIN_SPAN_NS = 60n * 1_000_000_000n;
export const DEFAULT_SPAN_NS = 30n * MIN_SPAN_NS;
/** SPEC recommendation [P], not a vendor retention or API limit. */
export const MAX_SPAN_NS = 6n * 60n * MIN_SPAN_NS;

export interface ChartBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface PriceRange { readonly minTick: number; readonly maxTick: number }
export interface Viewport {
  readonly bounds: ChartBounds;
  readonly dpr: number;
  readonly time: { readonly minNs: string; readonly maxNs: string };
  readonly price: PriceRange | null;
  readonly latestNs: string | null;
  readonly timeMode: "LIVE" | "HISTORY";
  readonly priceMode: "AUTO" | "MANUAL";
  readonly priceData: "VALID" | "NO TRADE PRICE";
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("Expected finite CSS coordinate");
  return value;
}
function ns(value: string): bigint {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) throw new TypeError("Expected decimal UTC ns");
  return BigInt(value);
}
function checkBounds(bounds: ChartBounds): void {
  for (const value of [bounds.left, bounds.top, bounds.width, bounds.height]) finite(value);
  if (bounds.width < 0 || bounds.height < 0) throw new RangeError("Negative chart dimensions");
}
function checkPrice(price: PriceRange | null): void {
  if (price && (!Number.isSafeInteger(price.minTick) || !Number.isSafeInteger(price.maxTick)
    || price.maxTick <= price.minTick || !Number.isSafeInteger(price.maxTick - price.minTick))) {
    throw new RangeError("Invalid integer Tick price range");
  }
}
function duration(v: Viewport): bigint {
  const span = ns(v.time.maxNs) - ns(v.time.minNs);
  if (span <= 0n) throw new RangeError("Invalid viewport time range");
  return span;
}
/** Only a relative, bounded quotient becomes Number; never an epoch timestamp. */
function relativeRatio(delta: bigint, span: bigint): number {
  return finite(Number(delta * 1_000_000_000_000_000n / span) / 1e15);
}
/** Decimal form of a finite relative CSS ratio, multiplied in BigInt, rounded to ns. */
function relativeNs(span: bigint, fraction: number): bigint {
  finite(fraction);
  const [mantissa, exponent = "0"] = fraction.toString().toLowerCase().split("e");
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole, decimal = ""] = unsigned.split(".");
  const power = Number(exponent) - decimal.length;
  let numerator = BigInt(whole + decimal) * span;
  let denominator = 1n;
  if (power >= 0) numerator *= 10n ** BigInt(power);
  else denominator = 10n ** BigInt(-power);
  const rounded = (numerator + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

export function createViewport(options: {
  bounds: ChartBounds; latestNs?: string | null; price?: PriceRange | null; dpr?: number;
}): Viewport {
  checkBounds(options.bounds);
  const dpr = options.dpr ?? 1;
  if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError("Invalid DPR");
  checkPrice(options.price ?? null);
  const latestNs = options.latestNs ?? null;
  // With no market clock these are an unlabelled coordinate domain, not market data.
  const end = latestNs === null ? 0n : ns(latestNs);
  return {
    bounds: { ...options.bounds }, dpr,
    time: { minNs: (end - DEFAULT_SPAN_NS).toString(), maxNs: end.toString() },
    price: options.price ? { ...options.price } : null, latestNs,
    timeMode: "LIVE", priceMode: "AUTO", priceData: "NO TRADE PRICE",
  };
}
export function resizeViewport(v: Viewport, bounds: ChartBounds, dpr: number): Viewport {
  checkBounds(bounds);
  if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError("Invalid DPR");
  return { ...v, bounds: { ...bounds }, dpr };
}
export function timeToX(v: Viewport, timeNs: string): number | null {
  const span = duration(v);
  const delta = ns(timeNs) - ns(v.time.minNs);
  return v.bounds.width === 0 ? null : v.bounds.left + relativeRatio(delta, span) * v.bounds.width;
}
export function xToTime(v: Viewport, x: number): string | null {
  finite(x);
  const span = duration(v);
  return v.bounds.width === 0 ? null
    : (ns(v.time.minNs) + relativeNs(span, (x - v.bounds.left) / v.bounds.width)).toString();
}
/** Fractional ticks are permitted only as continuous display coordinates (inverse mapping). */
export function tickToY(v: Viewport, tick: number): number | null {
  finite(tick); checkPrice(v.price);
  return !v.price || v.bounds.height === 0 ? null : v.bounds.top
    + (v.price.maxTick - tick) / (v.price.maxTick - v.price.minTick) * v.bounds.height;
}
export function yToTick(v: Viewport, y: number): number | null {
  finite(y); checkPrice(v.price);
  return !v.price || v.bounds.height === 0 ? null : v.price.maxTick
    - (y - v.bounds.top) / v.bounds.height * (v.price.maxTick - v.price.minTick);
}
function withTime(v: Viewport, start: bigint, span: bigint, mode: Viewport["timeMode"]): Viewport {
  let end = start + span;
  if (v.latestNs !== null && end > ns(v.latestNs)) {
    end = ns(v.latestNs); start = end - span;
  }
  return { ...v, time: { minNs: start.toString(), maxNs: end.toString() }, timeMode: mode };
}
export function zoomTime(v: Viewport, anchorX: number, factor: number): Viewport {
  finite(anchorX);
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError("Invalid zoom factor");
  if (v.bounds.width === 0) return v;
  const old = duration(v);
  let span = relativeNs(old, factor);
  span = span < MIN_SPAN_NS ? MIN_SPAN_NS : span > MAX_SPAN_NS ? MAX_SPAN_NS : span;
  const fraction = Math.max(0, Math.min(1, (anchorX - v.bounds.left) / v.bounds.width));
  const start = ns(v.time.minNs) + relativeNs(old, fraction) - relativeNs(span, fraction);
  const result = withTime(v, start, span, v.timeMode);
  return result.latestNs !== null && ns(result.time.maxNs) < ns(result.latestNs)
    ? { ...result, timeMode: "HISTORY" } : result;
}
export function panTime(v: Viewport, deltaCssPx: number): Viewport {
  finite(deltaCssPx);
  if (v.bounds.width === 0 || deltaCssPx === 0) return v;
  const span = duration(v);
  return withTime(v, ns(v.time.minNs) - relativeNs(span, deltaCssPx / v.bounds.width), span, "HISTORY");
}
export function receiveLatest(v: Viewport, latestNs: string): Viewport {
  const latest = ns(latestNs);
  if (v.latestNs !== null && latest <= ns(v.latestNs)) return v;
  const next = { ...v, latestNs };
  return v.timeMode === "HISTORY" ? next
    : withTime(next, latest - duration(v), duration(v), "LIVE");
}
export function goLatest(v: Viewport): Viewport {
  if (v.latestNs === null) return { ...v, timeMode: "LIVE" };
  return withTime(v, ns(v.latestNs) - DEFAULT_SPAN_NS, DEFAULT_SPAN_NS, "LIVE");
}
export function panPrice(v: Viewport, deltaCssPx: number): Viewport {
  finite(deltaCssPx);
  if (!v.price || v.bounds.height === 0 || deltaCssPx === 0) return v;
  const shift = Math.round(deltaCssPx / v.bounds.height * (v.price.maxTick - v.price.minTick));
  const price = { minTick: v.price.minTick + shift, maxTick: v.price.maxTick + shift };
  checkPrice(price);
  return { ...v, price, priceMode: "MANUAL" };
}

function validateQuality(intervals: readonly QualityInterval[]): void {
  let previousEnd: bigint | null = null;
  for (let i = 0; i < intervals.length; i++) {
    const q = intervals[i];
    const start = ns(q.startNs);
    const end = q.endNs === null ? null : ns(q.endNs);
    if (q.channel !== "TRADES" || (end !== null && end < start)
      || (i > 0 && (previousEnd === null || start < previousEnd))) {
      throw new TypeError("Invalid ordered TRADES quality intervals");
    }
    previousEnd = end;
  }
}
function validAt(time: bigint, intervals: readonly QualityInterval[]): boolean {
  return intervals.some((q) => q.status === "VALID" && ns(q.startNs) <= time
    && (q.endNs === null || time < ns(q.endNs)));
}
function continuous(a: bigint, b: bigint, intervals: readonly QualityInterval[]): boolean {
  // Invalid markers, even zero-length markers, must never be interpolated through.
  if (intervals.some((q) => q.status !== "VALID" && ns(q.startNs) <= b
    && (q.endNs === null || ns(q.endNs) > a || (q.startNs === q.endNs && ns(q.startNs) > a)))) return false;
  let cursor = a;
  for (const q of intervals) {
    if (q.status !== "VALID" || ns(q.startNs) > cursor) continue;
    const end = q.endNs === null ? b + 1n : ns(q.endNs);
    if (end > cursor) cursor = end;
    if (cursor > b) return true;
  }
  return false;
}
/**
 * Intervals MUST be on the exchange/event-time axis. R03's receive/detection-time
 * timeline needs an explicit clock mapping before it can be passed here.
 * Stable copy-sort only; returned runs retain immutable raw Trade references.
 */
export function buildPriceSegments(
  trades: readonly Trade[], intervals: readonly QualityInterval[],
): readonly (readonly Trade[])[] {
  validateQuality(intervals);
  let identity: string | null = null;
  for (const trade of trades) {
    const event = validateMarketEvent(trade);
    if (event.kind !== "TRADE") throw new TypeError("R05 supports ordinary Trade events only");
    const h = event.header;
    const key = [h.environment, h.source, h.sourceId, h.canonicalInstrumentId].join("|");
    if (identity !== null && identity !== key) throw new TypeError("Mixed Trade identity");
    identity = key;
  }
  // An untimed event cannot be placed relative to any other point. Preserve
  // timed points, but conservatively suppress all interpolation in that case.
  const hasUntimed = trades.some((trade) => trade.header.exchangeTimeNs === null);
  const ordered = trades.map((trade, index) => ({ trade, index }))
    .filter(({ trade }) => trade.header.exchangeTimeNs !== null)
    .sort((a, b) => {
      const at = a.trade.header.exchangeTimeNs!, bt = b.trade.header.exchangeTimeNs!;
      return ns(at) < ns(bt) ? -1 : ns(at) > ns(bt) ? 1 : a.index - b.index;
    });
  const segments: Trade[][] = [];
  let previous: Trade | null = null;
  for (const { trade } of ordered) {
    const h = trade.header;
    if (h.exchangeTimeNs === null || h.sourceTimePrecision === "unknown"
      || h.quality !== "VALID" || !validAt(ns(h.exchangeTimeNs), intervals)) {
      previous = null; continue;
    }
    if (hasUntimed || !previous || previous.header.sessionId !== h.sessionId
      || !continuous(ns(previous.header.exchangeTimeNs!), ns(h.exchangeTimeNs), intervals)) segments.push([]);
    segments[segments.length - 1].push(trade);
    previous = trade;
  }
  return segments;
}
export function autoPrice(
  v: Viewport, trades: readonly Trade[], quality: readonly QualityInterval[], forceAuto = false,
): Viewport {
  duration(v);
  const visible = buildPriceSegments(trades, quality).flat().filter((trade) => {
    const time = ns(trade.header.exchangeTimeNs!);
    return time >= ns(v.time.minNs) && time <= ns(v.time.maxNs);
  });
  const priceData = visible.length ? "VALID" as const : "NO TRADE PRICE" as const;
  const priceMode = forceAuto ? "AUTO" : v.priceMode;
  let price = v.price;
  if (priceMode === "AUTO" && visible.length) {
    let min = visible[0].priceTicks, max = min;
    for (const trade of visible) {
      min = Math.min(min, trade.priceTicks);
      max = Math.max(max, trade.priceTicks);
    }
    const range = BigInt(max) - BigInt(min);
    const margin = range === 0n ? 8n : (range * 15n + 99n) / 100n;
    const low = BigInt(min) - margin, high = BigInt(max) + margin;
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    if (low < -limit || high > limit) throw new RangeError("AUTO range exceeds safe integer Ticks");
    price = { minTick: Number(low), maxTick: Number(high) };
    checkPrice(price);
  }
  if (priceMode === v.priceMode && priceData === v.priceData
    && price?.minTick === v.price?.minTick && price?.maxTick === v.price?.maxTick) return v;
  return { ...v, priceMode, priceData, price };
}
