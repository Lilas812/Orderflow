import {
  validateDataQualityInterval, validateEventHeader, validateMarketEvent,
  type DataQualityInterval, type EventHeader, type Trade,
} from "./events";

export type TradeScope = Pick<EventHeader,
  "environment" | "source" | "sourceId" | "canonicalInstrumentId" | "sessionId">;
export type TradeIssueCode = "CONFLICTING_TRADE_ID" | "UNSUPPORTED_REVISION";
export interface TradeIssue {
  readonly code: TradeIssueCode;
  readonly eventId: string;
  readonly tradeId: string;
  readonly originalTradeId?: string;
}
export interface TradeStore {
  readonly scope: Readonly<TradeScope>;
  /** All validated deliveries, including duplicates and unsupported revisions. */
  readonly rawEvents: readonly Trade[];
  /** First delivery of each normal TRADE, not a final/settled trade ledger. */
  readonly trades: readonly Trade[];
  readonly issues: readonly TradeIssue[];
  /** Explicit observation evidence for this store's identity; absence is unknown. */
  readonly quality: readonly DataQualityInterval[];
}
export interface TradeIngestResult {
  readonly store: TradeStore;
  readonly disposition: "ACCEPTED" | "DUPLICATE" | TradeIssueCode;
}

function scopeOf(h: EventHeader): Readonly<TradeScope> {
  return Object.freeze({
    environment: h.environment, source: h.source, sourceId: h.sourceId,
    canonicalInstrumentId: h.canonicalInstrumentId, sessionId: h.sessionId,
  });
}
export function tradeScopeKey(scope: TradeScope): string {
  // JSON tuple prevents delimiter collisions. Channel is always TRADES.
  return JSON.stringify([scope.environment, scope.source, scope.sourceId,
    scope.canonicalInstrumentId, scope.sessionId]);
}
export function createTradeStore(header: EventHeader): TradeStore {
  validateEventHeader(header);
  if (header.channel !== "TRADES") throw new TypeError("Trade store requires TRADES channel");
  return Object.freeze({
    scope: scopeOf(header), rawEvents: Object.freeze([]), trades: Object.freeze([]),
    issues: Object.freeze([]), quality: Object.freeze([]),
  });
}

/** R08 consumes quality evidence; it neither invents continuity nor reimplements R03. */
export function withTradeQuality(
  store: TradeStore, intervals: readonly DataQualityInterval[],
): TradeStore {
  const quality = intervals.map((input) => {
    const q = validateDataQualityInterval(input);
    if (q.channel !== "TRADES") throw new TypeError("Only TRADES quality belongs in a trade store");
    return Object.freeze({ ...q });
  });
  for (let i = 1; i < quality.length; i++) {
    const previous = quality[i - 1], current = quality[i];
    if (previous.endNs === null || BigInt(current.startNs) < BigInt(previous.endNs)) {
      throw new TypeError("Trade quality must be ordered and non-overlapping");
    }
  }
  return Object.freeze({ ...store, quality: Object.freeze(quality) });
}

function sameTrade(a: Trade, b: Trade): boolean {
  // Delivery metadata (receive time, sequence, eventId) may differ on retransmission.
  // Economic content, event time, provenance/precision and declared quality may not.
  return a.kind === b.kind && a.priceTicks === b.priceTicks && a.qty === b.qty &&
    a.aggressor === b.aggressor && a.classification === b.classification &&
    a.originalTradeId === b.originalTradeId &&
    a.header.exchangeTimeNs === b.header.exchangeTimeNs &&
    a.header.sourceTimePrecision === b.header.sourceTimePrecision &&
    a.header.quality === b.header.quality;
}

export function ingestTrade(store: TradeStore, input: unknown): TradeIngestResult {
  const parsed = validateMarketEvent(input);
  if (!["TRADE", "TRADE_CANCEL", "TRADE_CORRECTION"].includes(parsed.kind)) {
    throw new TypeError("Expected a Trade, never an L1 or MBP event");
  }
  const event = parsed as Trade;
  if (event.header.exchangeTimeNs === null) {
    throw new TypeError("Trade aggregation requires exchangeTimeNs; receive time is not a substitute");
  }
  if (tradeScopeKey(scopeOf(event.header)) !== tradeScopeKey(store.scope)) {
    throw new TypeError("Trade source/instrument/session/environment identity mismatch");
  }
  const copy: Trade = Object.freeze({ ...event, header: Object.freeze({ ...event.header }) });
  const rawEvents = Object.freeze([...store.rawEvents, copy]);
  let disposition: TradeIngestResult["disposition"] = "ACCEPTED";
  if (event.kind !== "TRADE") disposition = "UNSUPPORTED_REVISION";
  else {
    const previous = store.trades.find((t) => t.tradeId === event.tradeId);
    if (previous) disposition = sameTrade(previous, event) ? "DUPLICATE" : "CONFLICTING_TRADE_ID";
  }
  const issue: TradeIssue | null =
    disposition === "CONFLICTING_TRADE_ID" || disposition === "UNSUPPORTED_REVISION"
      ? Object.freeze({ code: disposition, eventId: event.header.eventId, tradeId: event.tradeId,
        ...(event.originalTradeId === undefined ? {} : { originalTradeId: event.originalTradeId }) })
      : null;
  return {
    disposition,
    store: Object.freeze({
      ...store, rawEvents,
      trades: disposition === "ACCEPTED" ? Object.freeze([...store.trades, copy]) : store.trades,
      issues: issue ? Object.freeze([...store.issues, issue]) : store.issues,
    }),
  };
}
