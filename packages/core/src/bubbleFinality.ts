import type { DataQualityInterval, EventHeader } from "./events";
import { aggregateTrades, type TradeBucket } from "./bubbleAggregate";
import {
  createTradeStore, ingestTrade, tradeScopeKey, withTradeQuality,
  type TradeScope, type TradeStore,
} from "./tradeStore";

/** R09 MOCK policy only, not a verified exchange/vendor finality guarantee. */
export const MOCK_ALLOWED_LATENESS_NS = 3_000_000_000n;
export type BubbleStatus = "PROVISIONAL" | "FINAL" | "REVISED" | "INCOMPLETE";
export type BubbleCondition = "VALID" | "GAP" | "RESYNCING";
export interface BubbleState {
  readonly id: string;
  readonly bucket: TradeBucket;
  readonly status: BubbleStatus;
  readonly revision: number;
  /** Remembers sealing even if later quality evidence invalidates the display. */
  readonly finalized: boolean;
  /** Last complete sealed version, not the intervening INCOMPLETE diagnostic set. */
  readonly sealedTradeIds: readonly string[];
}
export interface BubbleFinality {
  readonly store: TradeStore;
  readonly bubbles: readonly BubbleState[];
  readonly condition: BubbleCondition;
  readonly maxSeenValidExchangeNs: string | null;
  readonly watermarkNs: string | null;
}
function utcNs(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError("Expected lossless canonical UTC nanoseconds");
  }
  return BigInt(value);
}
export function bubbleIdentity(bucket: TradeBucket): string {
  return JSON.stringify([tradeScopeKey(bucket.scope), bucket.timeBinId, bucket.priceBinId]);
}
export function bubbleOpacity(bubble: BubbleState): number {
  return bubble.status === "INCOMPLETE" ? 0 : bubble.status === "PROVISIONAL" ? .45 : .92;
}
function coveredAt(store: TradeStore, time: bigint): boolean {
  return store.quality.some(q => q.status === "VALID" && BigInt(q.startNs) <= time
    && (q.endNs === null || time < BigInt(q.endNs)));
}
function progress(state: BubbleFinality, time: string): BubbleFinality {
  const next = utcNs(time);
  if (state.condition !== "VALID" || state.store.issues.length || !coveredAt(state.store, next)) return state;
  if (state.maxSeenValidExchangeNs !== null && next <= BigInt(state.maxSeenValidExchangeNs)) return state;
  const wm = next > MOCK_ALLOWED_LATENESS_NS ? next - MOCK_ALLOWED_LATENESS_NS : 0n;
  return { ...state, maxSeenValidExchangeNs: time, watermarkNs: wm.toString() };
}
function refresh(state: BubbleFinality): BubbleFinality {
  const previous = new Map(state.bubbles.map(b => [b.id, b]));
  const bubbles = aggregateTrades(state.store).map(bucket => {
    const id = bubbleIdentity(bucket), old = previous.get(id);
    const incomplete = bucket.status === "INCOMPLETE" || state.condition !== "VALID";
    // R08 owns the unique Trade set. Delivery metadata and retransmissions do not revise.
    const sealedIds = old?.sealedTradeIds ?? [];
    const changed = !!old && (sealedIds.length !== bucket.tradeIds.length
      || sealedIds.some((tradeId, i) => tradeId !== bucket.tradeIds[i]));
    const revised = !incomplete && !!old?.finalized && changed;
    const revision = (old?.revision ?? 0) + (revised ? 1 : 0);
    if (!Number.isSafeInteger(revision)) throw new RangeError("Bubble revision exhausted");
    const sealed = old?.finalized === true || (!incomplete && state.watermarkNs !== null
      && BigInt(state.watermarkNs) >= BigInt(bucket.endNs));
    const status: BubbleStatus = incomplete ? "INCOMPLETE" : revision > 0 ? "REVISED"
      : sealed ? "FINAL" : "PROVISIONAL";
    return Object.freeze({
      id, bucket, status, revision, finalized: sealed,
      sealedTradeIds: !incomplete && sealed ? bucket.tradeIds : sealedIds,
    });
  });
  return Object.freeze({ ...state, bubbles: Object.freeze(bubbles) });
}
export function createBubbleFinality(
  header: EventHeader, quality: readonly DataQualityInterval[],
): BubbleFinality {
  if (header.environment !== "MOCK" || header.source !== "MOCK_DETERMINISTIC") {
    throw new TypeError("R09 3000ms finality policy is MOCK-only; vendor finality is unverified");
  }
  return refresh({
    store: withTradeQuality(createTradeStore(header), quality), bubbles: [],
    condition: "VALID", maxSeenValidExchangeNs: null, watermarkNs: null,
  });
}
/** No wall-clock parameter: only R08-accepted, valid classified event times advance WM. */
export function ingestBubbleTrade(state: BubbleFinality, input: unknown): BubbleFinality {
  const result = ingestTrade(state.store, input);
  let next: BubbleFinality = { ...state, store: result.store };
  const trade = result.store.rawEvents[result.store.rawEvents.length - 1];
  if (result.disposition === "ACCEPTED" && trade.header.quality === "VALID"
    && trade.header.sourceTimePrecision !== "unknown"
    && trade.aggressor !== "UNKNOWN" && trade.classification !== "UNKNOWN") {
    next = progress(next, trade.header.exchangeTimeNs!);
  }
  return refresh(next);
}
export interface TrustedBubbleProgress {
  readonly exchangeTimeNs: string;
  readonly trusted: true;
  readonly evidence: string;
  readonly scope: TradeScope;
}
export function advanceBubbleWatermark(state: BubbleFinality, input: TrustedBubbleProgress): BubbleFinality {
  utcNs(input.exchangeTimeNs);
  if (input.trusted !== true || !input.evidence?.trim()
    || tradeScopeKey(input.scope) !== tradeScopeKey(state.store.scope)) {
    throw new TypeError("Explicit trusted event-time evidence for the same Trade scope is required");
  }
  return refresh(progress(state, input.exchangeTimeNs));
}
/** Conservative live-gap gate; never clears R08's unresolved revision/identity issues. */
export function setBubbleCondition(state: BubbleFinality, condition: BubbleCondition): BubbleFinality {
  if (!["VALID", "GAP", "RESYNCING"].includes(condition)) throw new TypeError("Invalid Trade condition");
  return refresh({ ...state, condition });
}
