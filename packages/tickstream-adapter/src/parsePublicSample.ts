import { priceToTicks } from "@workspace/core";
import {
  MAX_PAYLOAD_BYTES, SCHEMA_PROFILES,
  type BookLevel, type BookObservation, type Limitation,
  type ParseInput, type ParseRefusal, type ParseResult, type Provenance,
  type ProvenanceContext, type ReasonCode, type RefusalStatus, type SchemaProfile,
  type SourceClassification, type TradeObservation,
} from "./envelope";

type Fields = Record<string, unknown>;

class Refusal extends Error {
  constructor(
    readonly status: RefusalStatus,
    readonly reasonCode: ReasonCode,
    readonly fieldPath: string,
    explanation: string,
  ) { super(explanation); }
}

function refuse(code: ReasonCode, path: string, explanation: string,
  status: RefusalStatus = "REJECTED_MALFORMED"): never {
  throw new Refusal(status, code, path, explanation);
}

function record(value: unknown, path: string): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("INVALID_FIELD", path, "Expected an object.");
  }
  return value as Fields;
}

function required(o: Fields, key: string, path = "$"): unknown {
  if (!Object.hasOwn(o, key)) refuse("MISSING_FIELD", `${path}.${key}`, "Required field is absent.");
  return o[key];
}

function onlyFields(o: Fields, allowed: readonly string[], path = "$"): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) {
      // Report a stable path, never echo an arbitrary attacker-controlled key.
      refuse("UNSUPPORTED_FIELD", path, "Undocumented fields require a separately reviewed profile.",
        "REJECTED_UNSUPPORTED");
    }
  }
}

/** Early exit with bounded work/allocation, matching TextEncoder UTF-8 lengths. */
function utf8Size(text: string): number {
  if (text.length > MAX_PAYLOAD_BYTES) return MAX_PAYLOAD_BYTES + 1;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 0x7f) bytes++;
    else if (c <= 0x7ff) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4; i++;
    } else bytes += 3;
    if (bytes > MAX_PAYLOAD_BYTES) return bytes;
  }
  return bytes;
}

function decode(raw: unknown): unknown {
  let text: string;
  if (typeof raw === "string") {
    if (utf8Size(raw) > MAX_PAYLOAD_BYTES) {
      refuse("PAYLOAD_TOO_LARGE", "raw", "Payload exceeds the local 1 MiB UTF-8 byte limit.");
    }
    text = raw;
  } else if (raw instanceof Uint8Array) {
    if (raw.byteLength > MAX_PAYLOAD_BYTES) {
      refuse("PAYLOAD_TOO_LARGE", "raw", "Payload exceeds the local 1 MiB UTF-8 byte limit.");
    }
    try {
      // Keep a BOM so byte and string inputs follow the same JSON rules.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      refuse("INVALID_UTF8", "raw", "Input bytes are not valid UTF-8.");
    }
  } else {
    refuse("INVALID_PAYLOAD_TYPE", "raw", "Expected a JSON string or Uint8Array.");
  }
  try { return JSON.parse(text); }
  catch { return refuse("INVALID_JSON", "raw", "Input is not valid JSON."); }
}

function context(value: unknown, profile: SchemaProfile): ProvenanceContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("MISSING_PROVENANCE", "provenance", "Explicit documentation provenance is required.",
      "INCOMPLETE_PROVENANCE");
  }
  const c = value as Fields;
  const source = profile === "WS_BOOK_LIVE_V1" ? "https://tick-stream.xyz/docs/level2" :
    profile === "WS_TICK_LIVE_V1" ? "https://tick-stream.xyz/docs/streaming" :
      "https://tick-stream.xyz/docs/historical";
  if (c.timestampUnit === undefined || c.timestampUnit === null) {
    refuse("TIMESTAMP_UNIT_MISSING", "provenance.timestampUnit",
      "Timestamp units must be explicit, never inferred from digit count.", "INCOMPLETE_PROVENANCE");
  }
  const expected = profile === "HISTORICAL_TICK_ROW_V1" ? "us" : "s";
  if (c.timestampUnit !== expected) {
    refuse("TIMESTAMP_UNIT_MISMATCH", "provenance.timestampUnit",
      "Timestamp units do not match the explicitly selected local profile.");
  }
  if (c.sourceUrl !== source) {
    refuse("INVALID_PROVENANCE", "provenance.sourceUrl",
      "Expected the official documentation URL for the selected profile.", "INCOMPLETE_PROVENANCE");
  }
  const checked = c.documentationCheckedAt;
  if (typeof checked !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(checked) ||
    !Number.isFinite(Date.parse(checked)) ||
    new Date(checked).toISOString() !== checked.replace(/Z$/, checked.includes(".") ? "Z" : ".000Z")) {
    refuse("INVALID_PROVENANCE", "provenance.documentationCheckedAt",
      "A valid explicit UTC ISO-8601 documentation check instant is required.", "INCOMPLETE_PROVENANCE");
  }
  if (!["SYNTHETIC_TEST", "DOCUMENTATION_ILLUSTRATIVE", "ACTUAL_PROVIDER_RESPONSE"]
    .includes(c.sampleOrigin as string)) {
    refuse("INVALID_PROVENANCE", "provenance.sampleOrigin",
      "An explicit recognized sample origin is required.", "INCOMPLETE_PROVENANCE");
  }
  return Object.freeze({
    sourceUrl: source, documentationCheckedAt: checked,
    sampleOrigin: c.sampleOrigin as ProvenanceContext["sampleOrigin"], timestampUnit: expected,
  });
}

function instrument(value: unknown, symbol: string): string {
  if (symbol !== "NQ" && symbol !== "ES") {
    refuse("UNSUPPORTED_INSTRUMENT", "$.symbol",
      "Only explicitly profiled NQ/ES futures observations are supported; quotes/indices are not trades.",
      "REJECTED_UNSUPPORTED");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("INSTRUMENT_CONTEXT_MISSING", "instrument",
      "An explicit instrument context is required.", "INCOMPLETE_PROVENANCE");
  }
  const i = value as Fields;
  if (symbol === "NQ" && i.kind === "CORE_NQ" && i.symbol === "NQ") {
    return "Existing @workspace/core NQ quarter-point public API";
  }
  if (symbol === "ES" && i.kind === "EXPLICIT_QUARTER_POINT" && i.symbol === "ES" &&
    i.tickSize === 0.25 && typeof i.evidence === "string" && i.evidence.trim()) return i.evidence;
  refuse("INSTRUMENT_CONTEXT_MISMATCH", "instrument",
    "Instrument identity and explicitly evidenced quarter-point grid must match.",
    "INCOMPLETE_PROVENANCE");
}

function symbolField(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) refuse("INVALID_FIELD", path, "Expected a root symbol.");
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    refuse("INVALID_TIMESTAMP", "$.ts", "Expected a non-negative safe integer timestamp.");
  }
  return value;
}

function price(value: unknown, path: string): { price: number; priceTicks: number } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    refuse("INVALID_PRICE", path, "Expected a finite numeric price.");
  }
  try {
    // Context was checked first. ES explicitly supplies the SAME 0.25 numeric
    // grid; sharing this public conversion does not infer ES identity from NQ.
    return { price: value, priceTicks: priceToTicks(value) };
  } catch {
    return refuse("OFF_TICK_GRID", path, "Price is outside the explicit 0.25 grid or safe Tick range.");
  }
}

function quantity(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    refuse("INVALID_QUANTITY", path, "Expected a non-negative safe integer quantity.");
  }
  return value;
}

function levels(value: unknown, side: "bids" | "asks"): readonly BookLevel[] {
  if (!Array.isArray(value)) refuse("INVALID_FIELD", `$.${side}`, "Expected an array of [price, size] tuples.");
  const seen = new Set<number>();
  const result: BookLevel[] = [];
  for (let n = 0; n < value.length; n++) {
    const tuple: unknown = value[n];
    const path = `$.${side}[${n}]`;
    if (!Array.isArray(tuple) || tuple.length !== 2) {
      refuse("INVALID_FIELD", path, "Each level must be exactly [price, size].");
    }
    const p = price(tuple[0], `${path}[0]`);
    const size = quantity(tuple[1], `${path}[1]`);
    if (seen.has(p.priceTicks)) refuse("DUPLICATE_PRICE", `${path}[0]`, "Duplicate price on the same side.");
    const previous = result[n - 1];
    if (previous && (side === "bids" ? p.priceTicks >= previous.priceTicks : p.priceTicks <= previous.priceTicks)) {
      refuse("INVALID_BOOK_ORDER", `${path}[0]`, "Levels must retain strict best-first side ordering.");
    }
    seen.add(p.priceTicks);
    result.push(Object.freeze({ ...p, size }));
  }
  return Object.freeze(result);
}

/** Pure offline parser: no I/O, clocks, ID generation, global queues or dedup. */
export function parsePublicSample(input: ParseInput): ParseResult {
  let profile: SchemaProfile | null = null;
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      refuse("INVALID_REQUEST", "input", "Expected an explicit parser request.");
    }
    if (!(SCHEMA_PROFILES as readonly unknown[]).includes(input.schemaProfile)) {
      refuse("UNSUPPORTED_SCHEMA_PROFILE", "schemaProfile", "Unsupported local schema profile.",
        "REJECTED_UNSUPPORTED");
    }
    profile = input.schemaProfile;
    const data = record(decode(input.raw), "$");
    const c = context(input.provenance, profile);
    let symbol: string;
    if (profile === "HISTORICAL_TICK_ROW_V1") {
      const parent = input.historicalParent;
      if (!parent || typeof parent !== "object" || Array.isArray(parent) ||
        typeof parent.symbol !== "string" || !parent.symbol.trim()) {
        refuse("HISTORICAL_PARENT_MISSING", "historicalParent.symbol",
          "Historical row root must come from an explicit parent response context.", "INCOMPLETE_PROVENANCE");
      }
      symbol = parent.symbol;
    } else {
      const expected = profile === "WS_BOOK_LIVE_V1" ? "book" : "tick";
      if (required(data, "type") !== expected) {
        refuse("UNSUPPORTED_MESSAGE_FAMILY", "$.type", "Message family does not match the selected profile.",
          "REJECTED_UNSUPPORTED");
      }
      symbol = symbolField(required(data, "symbol"), "$.symbol");
    }
    const instrumentEvidence = instrument(input.instrument, symbol);
    const rawTimestamp = timestamp(required(data, "ts"));
    const classification: SourceClassification = profile === "WS_BOOK_LIVE_V1" ? "NOT_APPLICABLE" :
      profile === "HISTORICAL_TICK_ROW_V1" ? "HISTORICAL_ERA_UNVERIFIED" : "PROVIDER_DECLARED_UNVERIFIED";
    const provenance: Provenance = Object.freeze({
      ...c, schemaProfile: profile, rawSymbol: symbol, rawTimestamp,
      timestampPrecision: c.timestampUnit, contract: null, providerTradeId: null,
      providerSequence: null, sourceClassification: classification, completenessEvidence: "UNKNOWN",
      instrumentEvidence,
    });
    const limitations: Limitation[] = [
      "CONTRACT_UNRESOLVED", "PROVIDER_SEQUENCE_UNAVAILABLE", "SEQUENCE_CONTINUITY_UNVERIFIED",
      "COMPLETENESS_UNKNOWN", "AUTHORITATIVE_HISTORY_UNVERIFIED",
    ];
    if (c.timestampUnit === "s") limitations.push("SUBSECOND_PRECISION_UNAVAILABLE");
    const base = {
      rawSymbol: symbol, rawTimestamp, timestampUnit: c.timestampUnit,
      timestampPrecision: c.timestampUnit,
      timestampNs: (BigInt(rawTimestamp) * (c.timestampUnit === "s" ? 1_000_000_000n : 1_000n)).toString(),
      contract: null, providerSequence: null, sequenceContinuity: "UNVERIFIED" as const, provenance,
    };
    let observation: BookObservation | TradeObservation;
    if (profile === "WS_BOOK_LIVE_V1") {
      onlyFields(data, ["type", "symbol", "bids", "asks", "imbalance", "ts"]);
      const bids = levels(required(data, "bids"), "bids");
      const asks = levels(required(data, "asks"), "asks");
      const imbalance = required(data, "imbalance");
      if (typeof imbalance !== "number" || !Number.isFinite(imbalance) || imbalance < -1 || imbalance > 1) {
        refuse("INVALID_IMBALANCE", "$.imbalance", "Expected a finite imbalance in [-1, 1].");
      }
      const relation = !bids.length || !asks.length ? "UNKNOWN" :
        bids[0].priceTicks < asks[0].priceTicks ? "UNCROSSED" :
          bids[0].priceTicks === asks[0].priceTicks ? "LOCKED" : "CROSSED";
      if (relation === "LOCKED" || relation === "CROSSED") limitations.push("LOCKED_OR_CROSSED_BOOK");
      observation = Object.freeze({
        ...base, kind: "BOOK_OBSERVATION", bids, asks, imbalance,
        providerDepthSpecified: false, depthCompleteness: "UNKNOWN", bidAskRelationship: relation,
        limitations: Object.freeze(limitations),
      });
    } else {
      onlyFields(data, profile === "HISTORICAL_TICK_ROW_V1" ? ["ts", "price", "size", "side"] :
        ["type", "symbol", "price", "size", "side", "exch", "ts"]);
      const p = price(required(data, "price"), "$.price");
      const size = quantity(required(data, "size"), "$.size");
      const rawSide = required(data, "side");
      if (rawSide !== "buy" && rawSide !== "sell" && rawSide !== "unknown") {
        refuse("INVALID_SIDE", "$.side", "Only explicit buy, sell or unknown values are supported.");
      }
      let exchange: string | null = null;
      if (profile === "WS_TICK_LIVE_V1") {
        if (required(data, "exch") !== "CME") {
          refuse("INVALID_EXCHANGE", "$.exch", "This reviewed profile requires the documented CME exchange value.");
        }
        exchange = "CME";
      }
      limitations.push("AGGRESSOR_PROVENANCE_UNVERIFIED", "EXACT_TRADE_DEDUP_UNAVAILABLE", "FINAL_TRADE_STATUS_UNVERIFIED");
      if (rawSide === "unknown") limitations.push("AGGRESSOR_UNKNOWN");
      observation = Object.freeze({
        ...base, ...p, kind: "TRADE_OBSERVATION", size, rawSide,
        side: rawSide === "buy" ? "BUY" : rawSide === "sell" ? "SELL" : "UNKNOWN",
        exchange, providerTradeId: null, aggressorClassification: classification,
        exactDedup: "UNAVAILABLE", finalTradeStatus: "UNVERIFIED", limitations: Object.freeze(limitations),
      });
    }
    return Object.freeze({ status: "ACCEPTED_OBSERVATION", schemaProfile: profile, observation });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    const result: ParseRefusal = {
      status: e.status, reasonCode: e.reasonCode, fieldPath: e.fieldPath,
      explanation: e.message, schemaProfile: profile,
    };
    return Object.freeze(result);
  }
}
