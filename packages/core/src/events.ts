import { ticksToPrice } from "./instrument";

export type Environment = "MOCK" | "LIVE" | "REPLAY_FROM_SAVED_DATA";
export type DataSource = "MOCK_DETERMINISTIC" | "VENDOR_UNVERIFIED" | "VERIFIED_VENDOR";
export type Channel = "L1" | "L2_MBP" | "TRADES" | "MBO";
export type BookSide = "BID" | "ASK";
export type Aggressor = "BUY" | "SELL" | "UNKNOWN";
export type EventQuality = "VALID" | "SUSPECT" | "GAP";
export type DataQualityStatus =
  | "VALID" | "NOT_INITIALIZED" | "GAP" | "STALE" | "CLOSED" | "OUTSIDE_DEPTH";

// Separate units: resting order quantity is not executed trade volume.
declare const restingUnit: unique symbol;
declare const executedUnit: unique symbol;
export type RestingQuantity = number & { readonly [restingUnit]: true };
export type ExecutedVolume = number & { readonly [executedUnit]: true };

export interface EventHeader {
  readonly schemaVersion: 1;
  readonly environment: Environment;
  readonly source: DataSource;
  readonly sourceId: string;
  readonly canonicalInstrumentId: string;
  readonly channel: Channel;
  readonly sessionId: string;
  readonly exchangeTimeNs: string | null;
  readonly receiveTimeNs: string;
  readonly sourceTimePrecision: "ns" | "us" | "ms" | "unknown";
  readonly sequenceScope: "PACKET" | "INSTRUMENT" | "CHANNEL" | "NONE";
  readonly sequence: string | null;
  readonly eventId: string;
  readonly quality: EventQuality;
}

export type DepthScope =
  | { readonly type: "FULL" }
  | { readonly type: "TOP_N"; readonly n: number }
  | { readonly type: "PRICE_RANGE"; readonly minTick: number; readonly maxTick: number };

export interface PriceLevel {
  readonly priceTicks: number;
  readonly qty: RestingQuantity;
}

export interface L2Snapshot {
  readonly kind: "L2_SNAPSHOT";
  readonly header: EventHeader;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly depthScope: DepthScope;
  readonly snapshotCoversSequence: string | null;
  readonly impliedPolicy: "EXCLUDE" | "INCLUDE_SEPARATE" | "UNKNOWN";
}

export interface L2PriceUpdate {
  readonly kind: "L2_SET_LEVEL" | "L2_DELETE_LEVEL";
  readonly header: EventHeader;
  readonly side: BookSide;
  readonly priceTicks: number;
  readonly qty: RestingQuantity;
  readonly updateBatchId?: string;
}

export interface Trade {
  readonly kind: "TRADE" | "TRADE_CORRECTION" | "TRADE_CANCEL";
  readonly header: EventHeader;
  readonly tradeId: string;
  readonly originalTradeId?: string;
  readonly priceTicks: number;
  readonly qty: ExecutedVolume;
  readonly aggressor: Aggressor;
  readonly classification: "VENUE" | "VENDOR_DECLARED" | "DETERMINISTIC_QUOTE" | "UNKNOWN";
}

export interface L1Quote {
  readonly kind: "L1_QUOTE";
  readonly header: EventHeader;
  readonly bestBidTick: number | null;
  readonly bestAskTick: number | null;
  readonly bidQty: RestingQuantity | null;
  readonly askQty: RestingQuantity | null;
}

export interface DataQualityInterval {
  readonly channel: Exclude<Channel, "MBO">;
  readonly startNs: string;
  readonly endNs: string | null;
  readonly status: DataQualityStatus;
  readonly reason: string;
  readonly evidence?: string;
}

export type MarketEvent = L2Snapshot | L2PriceUpdate | Trade | L1Quote;

function requireValid(condition: unknown, path: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid ${path}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  requireValid(value !== null && typeof value === "object" && !Array.isArray(value), path);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): asserts value is string {
  requireValid(typeof value === "string" && value.trim().length > 0, path);
}

function choice(value: unknown, allowed: readonly string[], path: string): void {
  requireValid(typeof value === "string" && allowed.includes(value), path);
}

function quantity(value: unknown, path: string): asserts value is number {
  requireValid(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, path);
}

export function restingQuantity(value: unknown): RestingQuantity {
  quantity(value, "resting quantity");
  return value as RestingQuantity;
}

export function executedVolume(value: unknown): ExecutedVolume {
  quantity(value, "executed volume");
  return value as ExecutedVolume;
}

function tick(value: unknown, path: string): void {
  requireValid(typeof value === "number", path);
  // Reuse the R00 safe-integer tick contract; do not accept point prices here.
  ticksToPrice(value);
}

function nanoseconds(value: unknown, path: string): asserts value is string {
  requireValid(typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value), path);
}

function sequence(value: unknown, path: string): void {
  requireValid(value === null || (typeof value === "string" && /^\d+$/.test(value)), path);
}

/** Structural validation only: provenance labels are not verification of a vendor. */
export function validateEventHeader(input: unknown): EventHeader {
  const h = record(input, "header");
  requireValid(h.schemaVersion === 1, "header.schemaVersion");
  choice(h.environment, ["MOCK", "LIVE", "REPLAY_FROM_SAVED_DATA"], "header.environment");
  choice(h.source, ["MOCK_DETERMINISTIC", "VENDOR_UNVERIFIED", "VERIFIED_VENDOR"], "header.source");
  text(h.sourceId, "header.sourceId");
  text(h.canonicalInstrumentId, "header.canonicalInstrumentId");
  requireValid(
    /^[^:\s]+:[^:\s]+:\d{4}-(0[1-9]|1[0-2])$/.test(h.canonicalInstrumentId),
    "header.canonicalInstrumentId (venue:root:YYYY-MM)",
  );
  choice(h.channel, ["L1", "L2_MBP", "TRADES", "MBO"], "header.channel");
  text(h.sessionId, "header.sessionId");
  if (h.exchangeTimeNs !== null) nanoseconds(h.exchangeTimeNs, "header.exchangeTimeNs");
  nanoseconds(h.receiveTimeNs, "header.receiveTimeNs");
  choice(h.sourceTimePrecision, ["ns", "us", "ms", "unknown"], "header.sourceTimePrecision");
  choice(h.sequenceScope, ["PACKET", "INSTRUMENT", "CHANNEL", "NONE"], "header.sequenceScope");
  sequence(h.sequence, "header.sequence");
  requireValid(h.sequenceScope !== "NONE" || h.sequence === null, "header.sequenceScope");
  text(h.eventId, "header.eventId");
  choice(h.quality, ["VALID", "SUSPECT", "GAP"], "header.quality");
  // Saved MOCK stays MOCK-origin. Replaying never promotes it to LIVE.
  requireValid(
    h.environment === "MOCK" ? h.source === "MOCK_DETERMINISTIC" :
      h.environment === "LIVE" ? h.source !== "MOCK_DETERMINISTIC" : true,
    "header.environment/source",
  );
  return input as EventHeader;
}

function depthScope(input: unknown): void {
  const d = record(input, "depthScope");
  choice(d.type, ["FULL", "TOP_N", "PRICE_RANGE"], "depthScope.type");
  if (d.type === "TOP_N") {
    quantity(d.n, "depthScope.n");
    requireValid(d.n > 0, "depthScope.n");
  } else if (d.type === "PRICE_RANGE") {
    tick(d.minTick, "depthScope.minTick");
    tick(d.maxTick, "depthScope.maxTick");
    requireValid((d.minTick as number) <= (d.maxTick as number), "depthScope range");
  }
}

/** Validate without coercion, rounding, reordering, filling nulls, or mutating input. */
export function validateMarketEvent(input: unknown): MarketEvent {
  const e = record(input, "event");
  const h = validateEventHeader(e.header);
  choice(e.kind, ["L2_SNAPSHOT", "L2_SET_LEVEL", "L2_DELETE_LEVEL",
    "TRADE", "TRADE_CORRECTION", "TRADE_CANCEL", "L1_QUOTE"], "event.kind");

  if (e.kind === "L2_SNAPSHOT") {
    requireValid(h.channel === "L2_MBP", "snapshot channel");
    for (const side of ["bids", "asks"]) {
      const levels = e[side];
      requireValid(Array.isArray(levels), side);
      for (const level of levels) {
        const p = record(level, side);
        tick(p.priceTicks, `${side}.priceTicks`);
        restingQuantity(p.qty);
      }
    }
    depthScope(e.depthScope);
    sequence(e.snapshotCoversSequence, "snapshotCoversSequence");
    choice(e.impliedPolicy, ["EXCLUDE", "INCLUDE_SEPARATE", "UNKNOWN"], "impliedPolicy");
  } else if (e.kind === "L2_SET_LEVEL" || e.kind === "L2_DELETE_LEVEL") {
    requireValid(h.channel === "L2_MBP", "L2 update channel");
    choice(e.side, ["BID", "ASK"], "side");
    tick(e.priceTicks, "priceTicks");
    restingQuantity(e.qty);
    requireValid(e.kind !== "L2_DELETE_LEVEL" || e.qty === 0, "DELETE qty must be 0");
    if (e.updateBatchId !== undefined) text(e.updateBatchId, "updateBatchId");
  } else if (e.kind === "L1_QUOTE") {
    requireValid(h.channel === "L1", "L1 channel");
    for (const field of ["bestBidTick", "bestAskTick"]) {
      if (e[field] !== null) tick(e[field], field);
    }
    for (const field of ["bidQty", "askQty"]) {
      if (e[field] !== null) restingQuantity(e[field]);
    }
  } else {
    requireValid(h.channel === "TRADES", "trade channel");
    text(e.tradeId, "tradeId");
    if (e.originalTradeId !== undefined) text(e.originalTradeId, "originalTradeId");
    tick(e.priceTicks, "priceTicks");
    executedVolume(e.qty);
    choice(e.aggressor, ["BUY", "SELL", "UNKNOWN"], "aggressor");
    choice(e.classification, ["VENUE", "VENDOR_DECLARED", "DETERMINISTIC_QUOTE", "UNKNOWN"], "classification");
  }
  return input as MarketEvent;
}

export function validateDataQualityInterval(input: unknown): DataQualityInterval {
  const q = record(input, "quality interval");
  choice(q.channel, ["L1", "L2_MBP", "TRADES"], "quality.channel");
  nanoseconds(q.startNs, "quality.startNs");
  if (q.endNs !== null) {
    nanoseconds(q.endNs, "quality.endNs");
    requireValid(BigInt(q.endNs) > BigInt(q.startNs), "quality interval bounds");
  }
  choice(q.status, ["VALID", "NOT_INITIALIZED", "GAP", "STALE", "CLOSED", "OUTSIDE_DEPTH"], "quality.status");
  text(q.reason, "quality.reason");
  if (q.evidence !== undefined) text(q.evidence, "quality.evidence");
  return input as DataQualityInterval;
}
