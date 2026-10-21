import type { DataQualityInterval, EventHeader } from "./events";
import {
  createBubbleFinality, ingestBubbleTrade, advanceBubbleWatermark, setBubbleCondition,
  type BubbleFinality, type BubbleCondition, type TrustedBubbleProgress,
} from "./bubbleFinality";
import { tradeScopeKey, type TradeScope, type TradeStore } from "./tradeStore";
import { TRADE_BUCKET_NS, tradeTimeBinId } from "./bubbleAggregate";
import { timeToX, type Viewport } from "./viewport";

export interface DeltaAlignment {
  readonly scope: TradeScope;
  readonly timeAxis: "EXCHANGE_TIME_NS";
  readonly evidence: string;
}
export interface DeltaBin {
  readonly id: string; readonly scope: TradeScope; readonly timeBinId: string;
  readonly startNs: string; readonly endNs: string;
  readonly tradeIds: readonly string[]; readonly tradesCount: number;
  readonly B: bigint; readonly S: bigint; readonly U: bigint;
  readonly V_raw: bigint; readonly V: bigint | null; readonly delta: bigint | null;
  /** Classification/coverage quality is separate from temporal finality. */
  readonly quality: "VALID" | "INCOMPLETE" | "NO DATA";
  readonly status: "PROVISIONAL" | "FINAL" | "REVISED" | "INCOMPLETE";
  readonly revision: number; readonly finalized: boolean;
  readonly sealedTradeIds: readonly string[];
  readonly issues: readonly string[];
}
export interface DeltaTimeline {
  /** R09 public policy API supplies the R08 store and event-time watermark.
   * Its bubble array is NEVER read to compute Delta or Delta revisions.
   */
  readonly tradeState: BubbleFinality;
  readonly bins: readonly DeltaBin[];
  readonly alignment: DeltaAlignment | null;
}
function ns(value: string): bigint {
  tradeTimeBinId(value); // Same canonical UTC ns validation as R08.
  return BigInt(value);
}
function coverageIssues(store: TradeStore, start: bigint, end: bigint): string[] {
  const issues: string[] = [];
  let cursor = start;
  for (const q of store.quality) {
    const a = BigInt(q.startNs), b = q.endNs === null ? end : BigInt(q.endNs);
    if (a >= end || b < start || (b === start && a !== b)) continue;
    if (a === b) { if (q.status !== "VALID") issues.push(q.status === "GAP" ? "TRADE_GAP" : "TRADE_QUALITY"); continue; }
    if (a > cursor) issues.push("NO_TRADE_COVERAGE");
    if (q.status !== "VALID") issues.push(q.status === "GAP" ? "TRADE_GAP" : "TRADE_QUALITY");
    if (b > cursor) cursor = b;
  }
  if (cursor < end) issues.push("NO_TRADE_COVERAGE");
  return issues;
}
function arithmetic(timeline: DeltaTimeline, time: string) {
  const store = timeline.tradeState.store, timeBinId = tradeTimeBinId(time);
  const start = BigInt(timeBinId) * TRADE_BUCKET_NS, end = start + TRADE_BUCKET_NS;
  const issues = coverageIssues(store, start, end);
  if (!timeline.alignment) issues.push("NO_ALIGNED_COVERAGE");
  issues.push(...store.issues.map(i => i.code));
  if (timeline.tradeState.condition !== "VALID") issues.push(timeline.tradeState.condition === "GAP" ? "STREAM_GAP" : "RESYNCING");
  let B = 0n, S = 0n, U = 0n;
  const tradeIds: string[] = [];
  // Sole quantity source: R08's normalized, deduplicated normal Trades,
  // across ALL prices. No bubble/filter/cluster output is consulted.
  for (const t of store.trades) {
    const at = BigInt(t.header.exchangeTimeNs!);
    if (at < start || at >= end) continue;
    tradeIds.push(t.tradeId);
    if (t.aggressor === "BUY") B += BigInt(t.qty);
    else if (t.aggressor === "SELL") S += BigInt(t.qty);
    else U += BigInt(t.qty);
    if (t.aggressor === "UNKNOWN" || t.classification === "UNKNOWN") issues.push("INCOMPLETE_CLASSIFICATION");
    if (t.header.quality !== "VALID") issues.push(t.header.quality === "GAP" ? "TRADE_GAP" : "TRADE_QUALITY");
  }
  const missing = issues.some(i => ["TRADE_GAP", "STREAM_GAP", "NO_TRADE_COVERAGE", "NO_ALIGNED_COVERAGE"].includes(i));
  const quality = missing ? "NO DATA" as const : issues.length ? "INCOMPLETE" as const : "VALID" as const;
  return {
    id: JSON.stringify([tradeScopeKey(store.scope), timeBinId]), scope: store.scope,
    timeBinId, startNs: start.toString(), endNs: end.toString(),
    tradeIds: Object.freeze(tradeIds), tradesCount: tradeIds.length, B, S, U,
    V_raw: B + S + U, V: quality === "VALID" ? B + S : null,
    delta: quality === "VALID" ? B - S : null, quality, issues: Object.freeze([...new Set(issues)]),
  };
}
function derive(timeline: DeltaTimeline, time: string, old?: DeltaBin): DeltaBin {
  const base = arithmetic(timeline, time), incomplete = base.quality !== "VALID";
  const changed = !!old?.finalized && (old.sealedTradeIds.length !== base.tradeIds.length
    || old.sealedTradeIds.some((id, i) => id !== base.tradeIds[i]));
  const revision = (old?.revision ?? 0) + (!incomplete && changed ? 1 : 0);
  if (!Number.isSafeInteger(revision)) throw new RangeError("Delta revision exhausted");
  const finalized = old?.finalized === true || (!incomplete && timeline.tradeState.watermarkNs !== null
    && BigInt(timeline.tradeState.watermarkNs) >= BigInt(base.endNs));
  return Object.freeze({
    ...base, revision, finalized,
    status: incomplete ? "INCOMPLETE" : revision > 0 ? "REVISED" : finalized ? "FINAL" : "PROVISIONAL",
    sealedTradeIds: !incomplete && finalized ? base.tradeIds : old?.sealedTradeIds ?? Object.freeze([]),
  });
}
function previousBin(previous: DeltaTimeline, time: string): DeltaBin {
  const stored = previous.bins.find(b => b.timeBinId === tradeTimeBinId(time));
  if (stored) return stored;
  const bin = derive(previous, time);
  // A previously observed empty bin can have been sealed without allocating an
  // infinite timeline. Preserve that knowledge while the current gate is GAP.
  const start = BigInt(bin.startNs), end = BigInt(bin.endNs);
  const sealedEmpty = bin.tradesCount === 0 && previous.alignment !== null
    && previous.tradeState.store.issues.length === 0
    && coverageIssues(previous.tradeState.store, start, end).length === 0
    && previous.tradeState.watermarkNs !== null && BigInt(previous.tradeState.watermarkNs) >= end;
  return sealedEmpty ? Object.freeze({ ...bin, finalized: true }) : bin;
}
function refresh(tradeState: BubbleFinality, alignment: DeltaAlignment | null, previous?: DeltaTimeline): DeltaTimeline {
  const next: DeltaTimeline = { tradeState, alignment, bins: [] };
  const times = [...new Set(tradeState.store.trades.map(t => tradeTimeBinId(t.header.exchangeTimeNs!)))];
  times.sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  return Object.freeze({ ...next, bins: Object.freeze(times.map(id => {
    const time = (BigInt(id) * TRADE_BUCKET_NS).toString();
    return derive(next, time, previous ? previousBin(previous, time) : undefined);
  })) });
}
export function createDeltaTimeline(
  header: EventHeader, quality: readonly DataQualityInterval[], alignment?: DeltaAlignment,
): DeltaTimeline {
  const state = createBubbleFinality(header, quality);
  if (alignment && (alignment.timeAxis !== "EXCHANGE_TIME_NS" || !alignment.evidence?.trim()
    || tradeScopeKey(alignment.scope) !== tradeScopeKey(state.store.scope))) {
    throw new TypeError("Delta requires explicit exchange-time quality alignment for the exact Trade scope");
  }
  return refresh(state, alignment ? Object.freeze({ ...alignment, scope: state.store.scope }) : null);
}
export function ingestDeltaTrade(state: DeltaTimeline, input: unknown): DeltaTimeline {
  return refresh(ingestBubbleTrade(state.tradeState, input), state.alignment, state);
}
export function advanceDeltaWatermark(state: DeltaTimeline, progress: TrustedBubbleProgress): DeltaTimeline {
  return refresh(advanceBubbleWatermark(state.tradeState, progress), state.alignment, state);
}
export function setDeltaCondition(state: DeltaTimeline, condition: BubbleCondition): DeltaTimeline {
  return refresh(setBubbleCondition(state.tradeState, condition), state.alignment, state);
}
export function queryDeltaBin(state: DeltaTimeline, time: string): DeltaBin {
  const id = tradeTimeBinId(time);
  return state.bins.find(b => b.timeBinId === id) ?? derive(state, time);
}
/** Epoch-aligned [start,end) query. No synthetic Trades or wall-clock progress. */
export function queryDeltaTimeline(state: DeltaTimeline, startNs: string, endNs: string): readonly DeltaBin[] {
  const start = ns(startNs), end = ns(endNs);
  if (end < start) throw new RangeError("Reversed Delta query");
  const bins: DeltaBin[] = [];
  if (end === start) return Object.freeze(bins);
  for (let at = start / TRADE_BUCKET_NS * TRADE_BUCKET_NS; at < end; at += TRADE_BUCKET_NS) {
    bins.push(queryDeltaBin(state, at.toString()));
  }
  return Object.freeze(bins);
}

export interface DeltaBar {
  readonly bin: DeltaBin; readonly x0: number; readonly x1: number;
  readonly top: number | null; readonly bottom: number | null;
  readonly direction: "UP" | "DOWN" | "ZERO" | "NO DATA" | "INCOMPLETE";
  readonly opacity: number;
}
export interface DeltaFrame {
  readonly bars: readonly DeltaBar[]; readonly zeroY: number; readonly maxAbsDelta: bigint;
  readonly scaleLimitNumerator: bigint; readonly scaleLimitDenominator: bigint;
  readonly height: number; readonly plot: { readonly left: number; readonly width: number };
}
/** Pure display geometry over the SAME R05 Viewport; no private time axis. */
export function projectDeltaTimeline(bins: readonly DeltaBin[], vp: Viewport, height = 126): DeltaFrame {
  if (!Number.isFinite(height) || height <= 0) throw new RangeError("Invalid Delta panel height");
  const visible = bins.filter(b => BigInt(b.endNs) > ns(vp.time.minNs) && BigInt(b.startNs) < ns(vp.time.maxNs));
  let maxAbsDelta = 0n;
  for (const b of visible) if (b.delta !== null) {
    const abs = b.delta < 0n ? -b.delta : b.delta;
    if (abs > maxAbsDelta) maxAbsDelta = abs;
  }
  const scaleLimitNumerator = maxAbsDelta === 0n ? 1n : maxAbsDelta * 11n;
  const scaleLimitDenominator = maxAbsDelta === 0n ? 1n : 10n, zeroY = height / 2;
  const precision = 1_000_000_000_000_000_000n;
  const bars = visible.map(bin => {
    const x0 = timeToX(vp, bin.startNs)!, x1 = timeToX(vp, bin.endNs)!;
    const missing = bin.delta === null, abs = missing ? 0n : bin.delta! < 0n ? -bin.delta! : bin.delta!;
    // Convert a bounded display ratio only, never an unsafe integer quantity.
    const pixels = Number(abs * scaleLimitDenominator * precision / scaleLimitNumerator) / 1e18 * zeroY;
    const y = missing ? null : zeroY + (bin.delta! < 0n ? pixels : -pixels);
    return Object.freeze({
      bin, x0, x1, top: y === null ? null : Math.min(y, zeroY), bottom: y === null ? null : Math.max(y, zeroY),
      direction: missing ? bin.quality === "NO DATA" ? "NO DATA" as const : "INCOMPLETE" as const
        : bin.delta! > 0n ? "UP" as const : bin.delta! < 0n ? "DOWN" as const : "ZERO" as const,
      opacity: bin.status === "PROVISIONAL" ? .45 : bin.status === "INCOMPLETE" ? 0 : .92,
    });
  });
  return Object.freeze({ bars: Object.freeze(bars), zeroY, maxAbsDelta, scaleLimitNumerator, scaleLimitDenominator,
    height, plot: Object.freeze({ left: vp.bounds.left, width: vp.bounds.width }) });
}
