import { priceBinId, priceBinTicks } from "./priceBins";
import type { TradeStore, TradeScope, TradeIssueCode } from "./tradeStore";

export const TRADE_BUCKET_NS = 2_000_000_000n;
export const TRADE_PRICE_WIDTH = 2 as const;
export type TradeBucketIssue = TradeIssueCode | "INCOMPLETE_CLASSIFICATION" |
  "TRADE_GAP" | "TRADE_QUALITY" | "NO_TRADE_COVERAGE";
export interface TradeBucket {
  readonly scope: TradeScope;
  readonly timeBinId: string;
  readonly startNs: string;
  readonly endNs: string;
  readonly priceBinId: number;
  readonly minTick: number;
  readonly maxTick: number;
  readonly tradeIds: readonly string[];
  readonly B: bigint;
  readonly S: bigint;
  readonly U: bigint;
  /** Observed quantities only; not a market-wide total during a gap. */
  readonly V_raw: bigint;
  readonly V: bigint | null;
  readonly delta: bigint | null;
  /** Approximate display ratio. Filter comparisons below use exact integer ratios. */
  readonly imbalancePercent: number | null;
  /** Arithmetic/classification completeness, NOT R09 watermark FINAL. */
  readonly status: "COMPLETE" | "INCOMPLETE";
  readonly quality: readonly TradeBucketIssue[];
}

function epochNs(ns: string): bigint {
  if (typeof ns !== "string" || !/^(0|[1-9]\d*)$/.test(ns)) {
    throw new TypeError("Expected UTC nanoseconds as a nonnegative decimal string");
  }
  return BigInt(ns);
}
export function tradeTimeBinId(ns: string): string {
  return (epochNs(ns) / TRADE_BUCKET_NS).toString();
}

function observedIssues(store: TradeStore, start: bigint, end: bigint): TradeBucketIssue[] {
  const issues: TradeBucketIssue[] = [];
  let cursor = start;
  for (const q of store.quality) {
    const a = BigInt(q.startNs), b = q.endNs === null ? end : BigInt(q.endNs);
    if (a >= end || b <= start) continue;
    if (a > cursor) issues.push("NO_TRADE_COVERAGE");
    if (q.status !== "VALID") issues.push(q.status === "GAP" ? "TRADE_GAP" : "TRADE_QUALITY");
    if (b > cursor) cursor = b;
  }
  if (cursor < end) issues.push("NO_TRADE_COVERAGE");
  // Unresolved revisions/conflicts can change price, time or original target.
  // Conservative scope-wide invalidation until a reconciled store is supplied.
  issues.push(...store.issues.map((i) => i.code));
  return issues;
}

/** Query one exact epoch-aligned bucket, including an empty or missing interval. */
export function aggregateTradeBucket(store: TradeStore, timeNs: string, tick: number): TradeBucket {
  const id = tradeTimeBinId(timeNs), start = BigInt(id) * TRADE_BUCKET_NS;
  const end = start + TRADE_BUCKET_NS, priceId = priceBinId(tick, TRADE_PRICE_WIDTH);
  const ticks = priceBinTicks(tick, TRADE_PRICE_WIDTH);
  const trades = store.trades.filter((t) =>
    tradeTimeBinId(t.header.exchangeTimeNs!) === id &&
    priceBinId(t.priceTicks, TRADE_PRICE_WIDTH) === priceId);
  let B = 0n, S = 0n, U = 0n;
  const issues = observedIssues(store, start, end);
  for (const t of trades) {
    if (t.aggressor === "BUY") B += BigInt(t.qty);
    else if (t.aggressor === "SELL") S += BigInt(t.qty);
    else U += BigInt(t.qty);
    // Even UNKNOWN of zero quantity or contradictory classification provenance
    // is not silently presented as fully classified.
    if (t.aggressor === "UNKNOWN" || t.classification === "UNKNOWN") {
      issues.push("INCOMPLETE_CLASSIFICATION");
    }
    if (t.header.quality !== "VALID") {
      issues.push(t.header.quality === "GAP" ? "TRADE_GAP" : "TRADE_QUALITY");
    }
  }
  const quality = Object.freeze([...new Set(issues)]);
  const complete = quality.length === 0;
  const V_raw = B + S + U, V = complete ? B + S : null, delta = complete ? B - S : null;
  const absDelta = delta === null ? null : delta < 0n ? -delta : delta;
  // Display-only floating ratio. Counts and every threshold comparison remain BigInt.
  // Validated event quantities and JS array lengths bound these sums well below Number overflow.
  const imbalancePercent = V !== null && V > 0n && absDelta !== null
    ? Number(absDelta * 100n) / Number(V) : null;
  return Object.freeze({
    scope: store.scope, timeBinId: id, startNs: start.toString(), endNs: end.toString(),
    priceBinId: priceId, minTick: ticks[0], maxTick: ticks[1],
    tradeIds: Object.freeze(trades.map((t) => t.tradeId)), B, S, U, V_raw, V, delta,
    imbalancePercent, status: complete ? "COMPLETE" : "INCOMPLETE", quality,
  });
}

/** Only observed normal-Trade buckets; no synthetic empty market events. */
export function aggregateTrades(store: TradeStore): readonly TradeBucket[] {
  const keys = new Set<string>();
  const buckets: TradeBucket[] = [];
  for (const t of store.trades) {
    const id = tradeTimeBinId(t.header.exchangeTimeNs!);
    const priceId = priceBinId(t.priceTicks, TRADE_PRICE_WIDTH), key = JSON.stringify([id, priceId]);
    if (!keys.has(key)) {
      keys.add(key);
      buckets.push(aggregateTradeBucket(store, t.header.exchangeTimeNs!, t.priceTicks));
    }
  }
  // Sort derived output only. Raw deliveries and constituent IDs retain arrival order.
  buckets.sort((a, b) => BigInt(a.startNs) < BigInt(b.startNs) ? -1 :
    BigInt(a.startNs) > BigInt(b.startNs) ? 1 : a.priceBinId - b.priceBinId);
  return Object.freeze(buckets);
}

export interface BubbleFilter {
  readonly enabled: boolean;
  readonly minimum: number;
}
export interface BubbleFilters {
  readonly volume: BubbleFilter;
  readonly absoluteDelta: BubbleFilter;
  readonly imbalancePercent: BubbleFilter;
}
export const DEFAULT_BUBBLE_FILTERS: BubbleFilters = Object.freeze({
  volume: Object.freeze({ enabled: true, minimum: 15 }),
  absoluteDelta: Object.freeze({ enabled: true, minimum: 10 }),
  imbalancePercent: Object.freeze({ enabled: true, minimum: 40 }),
});

/** Exact rational form of the configured decimal number, including exponent notation. */
function rational(value: number): readonly [bigint, bigint] {
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const power = Number(exponent) - fraction.length;
  const digits = BigInt(whole + fraction);
  return power >= 0 ? [digits * 10n ** BigInt(power), 1n] :
    [digits, 10n ** BigInt(-power)];
}
export function validateBubbleFilters(filters: BubbleFilters): void {
  if (!filters || typeof filters !== "object") throw new TypeError("Missing bubble filters");
  for (const key of ["volume", "absoluteDelta", "imbalancePercent"] as const) {
    const f = filters[key], limit = key === "imbalancePercent" ? 100 : Number.MAX_SAFE_INTEGER;
    if (!f || typeof f.enabled !== "boolean" || !Number.isFinite(f.minimum) ||
      f.minimum < 0 || f.minimum > limit) throw new TypeError(`Invalid ${key} filter`);
  }
}

export function evaluateBubbleFilter(
  bucket: TradeBucket, filters: BubbleFilters = DEFAULT_BUBBLE_FILTERS,
): Readonly<{ eligible: boolean; volume: boolean; absoluteDelta: boolean;
  imbalancePercent: boolean; pass: boolean }> {
  validateBubbleFilters(filters);
  const eligible = bucket.status === "COMPLETE" && bucket.V !== null && bucket.V > 0n &&
    bucket.delta !== null && bucket.U === 0n && bucket.quality.length === 0;
  const absoluteDelta = bucket.delta === null ? null :
    bucket.delta < 0n ? -bucket.delta : bucket.delta;
  const [vn, vd] = rational(filters.volume.minimum);
  const [dn, dd] = rational(filters.absoluteDelta.minimum);
  const [pn, pd] = rational(filters.imbalancePercent.minimum);
  const volume = !filters.volume.enabled || (bucket.V !== null && bucket.V * vd >= vn);
  const delta = !filters.absoluteDelta.enabled || (absoluteDelta !== null && absoluteDelta * dd >= dn);
  const bias = !filters.imbalancePercent.enabled ||
    (absoluteDelta !== null && bucket.V !== null && bucket.V > 0n &&
      absoluteDelta * 100n * pd >= bucket.V * pn);
  return Object.freeze({ eligible, volume, absoluteDelta: delta, imbalancePercent: bias,
    pass: eligible && volume && delta && bias });
}
