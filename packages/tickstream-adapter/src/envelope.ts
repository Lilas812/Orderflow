/** Local documentation profiles, NOT provider-issued schema versions. */
export const SCHEMA_PROFILES = Object.freeze([
  "WS_BOOK_LIVE_V1", "WS_TICK_LIVE_V1", "HISTORICAL_TICK_ROW_V1",
] as const);
export type SchemaProfile = typeof SCHEMA_PROFILES[number];
export type TimestampUnit = "s" | "us";
export type SampleOrigin =
  | "DOCUMENTATION_ILLUSTRATIVE" | "SYNTHETIC_TEST" | "ACTUAL_PROVIDER_RESPONSE";

/** Offline byte budget, not a provider frame-size guarantee. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface ProvenanceContext {
  readonly sourceUrl: string;
  /** An explicit UTC ISO-8601 instant; never obtained from the system clock. */
  readonly documentationCheckedAt: string;
  readonly sampleOrigin: SampleOrigin;
  readonly timestampUnit: TimestampUnit;
}

/**
 * ES is not inferred from NQ. Its quarter-point grid must be explicitly supplied
 * with evidence by the caller. Tests use an explicitly SYNTHETIC assumption.
 * Evidence is retained, NOT certified as exchange/provider verification.
 */
export type InstrumentContext =
  | { readonly kind: "CORE_NQ"; readonly symbol: "NQ" }
  | { readonly kind: "EXPLICIT_QUARTER_POINT"; readonly symbol: "ES";
      readonly tickSize: 0.25; readonly evidence: string };

export interface ParseInput {
  readonly raw: string | Uint8Array;
  readonly schemaProfile: SchemaProfile;
  readonly provenance: ProvenanceContext;
  readonly instrument?: InstrumentContext;
  /** Historical row symbols come ONLY from an explicitly supplied parent. */
  readonly historicalParent?: { readonly symbol: string };
}

export type SourceClassification =
  | "NOT_APPLICABLE"
  | "PROVIDER_DECLARED_UNVERIFIED"
  | "HISTORICAL_ERA_UNVERIFIED";

export type Limitation =
  | "CONTRACT_UNRESOLVED"
  | "PROVIDER_SEQUENCE_UNAVAILABLE"
  | "SEQUENCE_CONTINUITY_UNVERIFIED"
  | "COMPLETENESS_UNKNOWN"
  | "AUTHORITATIVE_HISTORY_UNVERIFIED"
  | "SUBSECOND_PRECISION_UNAVAILABLE"
  | "AGGRESSOR_PROVENANCE_UNVERIFIED"
  | "AGGRESSOR_UNKNOWN"
  | "EXACT_TRADE_DEDUP_UNAVAILABLE"
  | "FINAL_TRADE_STATUS_UNVERIFIED"
  | "LOCKED_OR_CROSSED_BOOK";

export interface Provenance extends ProvenanceContext {
  readonly schemaProfile: SchemaProfile;
  readonly rawSymbol: string;
  readonly rawTimestamp: number;
  readonly timestampPrecision: TimestampUnit;
  readonly contract: null;
  readonly providerTradeId: null;
  readonly providerSequence: null;
  readonly sourceClassification: SourceClassification;
  readonly completenessEvidence: "UNKNOWN";
  readonly instrumentEvidence: string;
}

interface ObservationBase {
  readonly rawSymbol: string;
  readonly rawTimestamp: number;
  readonly timestampUnit: TimestampUnit;
  readonly timestampPrecision: TimestampUnit;
  /** Unit conversion only: padding to ns NEVER increases source precision. */
  readonly timestampNs: string;
  readonly contract: null;
  readonly providerSequence: null;
  readonly sequenceContinuity: "UNVERIFIED";
  readonly provenance: Provenance;
  readonly limitations: readonly Limitation[];
}

export interface BookLevel {
  readonly price: number;
  readonly priceTicks: number;
  readonly size: number;
}

export interface BookObservation extends ObservationBase {
  readonly kind: "BOOK_OBSERVATION";
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  /** Provider value, not recalculated or treated as Trade Delta. */
  readonly imbalance: number;
  readonly providerDepthSpecified: false;
  readonly depthCompleteness: "UNKNOWN";
  /** Describes the submitted best levels, not a market-validity certificate. */
  readonly bidAskRelationship: "UNCROSSED" | "LOCKED" | "CROSSED" | "UNKNOWN";
}

export interface TradeObservation extends ObservationBase {
  readonly kind: "TRADE_OBSERVATION";
  readonly price: number;
  readonly priceTicks: number;
  readonly size: number;
  readonly side: "BUY" | "SELL" | "UNKNOWN";
  readonly rawSide: "buy" | "sell" | "unknown";
  readonly exchange: string | null;
  readonly providerTradeId: null;
  readonly aggressorClassification: SourceClassification;
  readonly exactDedup: "UNAVAILABLE";
  readonly finalTradeStatus: "UNVERIFIED";
}

/** These are LOCAL parser reason codes, not tickstream API error codes. */
export const REASON_CODES = Object.freeze([
  "INVALID_REQUEST", "INVALID_PAYLOAD_TYPE", "PAYLOAD_TOO_LARGE", "INVALID_UTF8",
  "INVALID_JSON", "UNSUPPORTED_SCHEMA_PROFILE", "MISSING_PROVENANCE",
  "INVALID_PROVENANCE", "TIMESTAMP_UNIT_MISSING", "TIMESTAMP_UNIT_MISMATCH",
  "HISTORICAL_PARENT_MISSING", "INSTRUMENT_CONTEXT_MISSING",
  "INSTRUMENT_CONTEXT_MISMATCH", "UNSUPPORTED_INSTRUMENT",
  "UNSUPPORTED_MESSAGE_FAMILY", "UNSUPPORTED_FIELD", "MISSING_FIELD",
  "INVALID_FIELD", "INVALID_TIMESTAMP", "INVALID_PRICE", "OFF_TICK_GRID",
  "INVALID_QUANTITY", "DUPLICATE_PRICE", "INVALID_BOOK_ORDER",
  "INVALID_IMBALANCE", "INVALID_SIDE", "INVALID_EXCHANGE",
] as const);
export type ReasonCode = typeof REASON_CODES[number];
export type RefusalStatus =
  | "REJECTED_MALFORMED" | "REJECTED_UNSUPPORTED" | "INCOMPLETE_PROVENANCE";

export interface ParseRefusal {
  readonly status: RefusalStatus;
  readonly reasonCode: ReasonCode;
  readonly fieldPath: string;
  /** Does not echo raw payload or credentials. */
  readonly explanation: string;
  readonly schemaProfile: SchemaProfile | null;
}

/** ACCEPTED means structurally interpreted, not an exchange-grade MarketEvent. */
export type ParseResult =
  | { readonly status: "ACCEPTED_OBSERVATION"; readonly schemaProfile: SchemaProfile;
      readonly observation: BookObservation | TradeObservation }
  | ParseRefusal;
