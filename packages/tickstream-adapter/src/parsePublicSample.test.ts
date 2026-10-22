import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { parsePublicSample } from "./parsePublicSample";
import {
  MAX_PAYLOAD_BYTES, REASON_CODES, SCHEMA_PROFILES,
  type BookObservation, type ParseInput, type ParseRefusal, type ParseResult,
  type ReasonCode, type RefusalStatus, type SchemaProfile, type TradeObservation,
} from "./envelope";

/**
 * ALL payloads below are SYNTHETIC_TEST data generated locally.
 * They are neither copied documentation JSON nor actual provider responses.
 * URLs identify the reviewed schema, not a claim that these values were served.
 */
const CHECKED_AT = "2026-10-23T01:45:00Z";
const SECOND = 1_790_000_000;
const MICROSECOND = 1_790_000_000_123_456;

function book(symbol = "NQ"): Record<string, unknown> {
  return {
    type: "book", symbol, bids: [[25000, 17], [24999.75, 0]],
    asks: [[25000.25, 9], [25000.5, 14]], imbalance: 0.11, ts: SECOND,
  };
}

function tick(): Record<string, unknown> {
  return { type: "tick", symbol: "NQ", price: 25000.25, size: 10, side: "buy", exch: "CME", ts: SECOND };
}

function row(): Record<string, unknown> {
  return { price: 25000.25, size: 10, side: "sell", ts: MICROSECOND };
}

function request(profile: SchemaProfile, payload?: unknown): ParseInput {
  return {
    schemaProfile: profile,
    raw: JSON.stringify(payload ?? (profile === "WS_BOOK_LIVE_V1" ? book() :
      profile === "WS_TICK_LIVE_V1" ? tick() : row())),
    provenance: {
      sourceUrl: profile === "WS_BOOK_LIVE_V1" ? "https://tick-stream.xyz/docs/level2" :
        profile === "WS_TICK_LIVE_V1" ? "https://tick-stream.xyz/docs/streaming" :
          "https://tick-stream.xyz/docs/historical",
      documentationCheckedAt: CHECKED_AT, sampleOrigin: "SYNTHETIC_TEST",
      timestampUnit: profile === "HISTORICAL_TICK_ROW_V1" ? "us" : "s",
    },
    instrument: { kind: "CORE_NQ", symbol: "NQ" },
    ...(profile === "HISTORICAL_TICK_ROW_V1" ? { historicalParent: { symbol: "NQ" } } : {}),
  };
}

function observation(i: ParseInput): BookObservation | TradeObservation {
  const r = parsePublicSample(i);
  expect(r.status).toBe("ACCEPTED_OBSERVATION");
  if (r.status !== "ACCEPTED_OBSERVATION") throw new Error("Synthetic input was unexpectedly refused.");
  return r.observation;
}

function bookObservation(i = request("WS_BOOK_LIVE_V1")): BookObservation {
  const o = observation(i);
  expect(o.kind).toBe("BOOK_OBSERVATION");
  if (o.kind !== "BOOK_OBSERVATION") throw new Error("Expected a book observation.");
  return o;
}

function tradeObservation(i = request("WS_TICK_LIVE_V1")): TradeObservation {
  const o = observation(i);
  expect(o.kind).toBe("TRADE_OBSERVATION");
  if (o.kind !== "TRADE_OBSERVATION") throw new Error("Expected a trade observation.");
  return o;
}

function refused(i: ParseInput, reasonCode: ReasonCode,
  status: RefusalStatus = "REJECTED_MALFORMED"): ParseRefusal {
  const r = parsePublicSample(i);
  expect(r.status).toBe(status);
  if (r.status === "ACCEPTED_OBSERVATION") throw new Error("Expected an explicit refusal.");
  expect(r.reasonCode).toBe(reasonCode);
  expect(r.fieldPath.length).toBeGreaterThan(0);
  expect(r.explanation.length).toBeGreaterThan(0);
  expect(r).toHaveProperty("schemaProfile");
  expect(r).not.toHaveProperty("observation");
  return r;
}

function removeField(profile: SchemaProfile, field: string): ParseInput {
  const i = request(profile);
  const data = JSON.parse(i.raw as string) as Record<string, unknown>;
  delete data[field];
  return { ...i, raw: JSON.stringify(data) };
}

function unchecked(i: unknown): ParseInput { return i as ParseInput; }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("synthetic observation acceptance — never native MarketEvent", () => {
  it("interprets NQ book without padding, recalculation or complete-depth claims", () => {
    const o = bookObservation();
    expect(o.bids).toEqual([
      { price: 25000, priceTicks: 100000, size: 17 },
      { price: 24999.75, priceTicks: 99999, size: 0 },
    ]);
    expect(o.asks).toEqual([
      { price: 25000.25, priceTicks: 100001, size: 9 },
      { price: 25000.5, priceTicks: 100002, size: 14 },
    ]);
    expect(o.imbalance).toBe(0.11);
    expect(o.providerDepthSpecified).toBe(false);
    expect(o.depthCompleteness).toBe("UNKNOWN");
    expect(o.bidAskRelationship).toBe("UNCROSSED");
    expect(o.provenance.completenessEvidence).toBe("UNKNOWN");
    expect(o.bids).toHaveLength(2); // Not padded to the documentation's 400.
    expect(o).not.toHaveProperty("header");
    expect(o).not.toHaveProperty("depthScope");
  });

  it("requires an explicit ES grid rather than inferring it from NQ", () => {
    const i = request("WS_BOOK_LIVE_V1", book("ES"));
    const o = bookObservation({
      ...i, instrument: {
        kind: "EXPLICIT_QUARTER_POINT", symbol: "ES", tickSize: 0.25,
        evidence: "SYNTHETIC_TEST ES quarter-point assumption, not verified provider metadata",
      },
    });
    expect(o.rawSymbol).toBe("ES");
    expect(o.provenance.instrumentEvidence).toContain("SYNTHETIC_TEST");
    expect(o.provenance.sampleOrigin).toBe("SYNTHETIC_TEST");
  });

  it("interprets NQ live tick and retains provider values", () => {
    const o = tradeObservation();
    expect(o).toMatchObject({
      price: 25000.25, priceTicks: 100001, size: 10, side: "BUY", rawSide: "buy",
      exchange: "CME", aggressorClassification: "PROVIDER_DECLARED_UNVERIFIED",
      exactDedup: "UNAVAILABLE", finalTradeStatus: "UNVERIFIED",
    });
  });

  it("interprets historical NQ row using ONLY explicit parent symbol context", () => {
    const o = tradeObservation(request("HISTORICAL_TICK_ROW_V1"));
    expect(o.rawSymbol).toBe("NQ");
    expect(o.exchange).toBeNull(); // Not invented from the root.
    expect(o.side).toBe("SELL");
    expect(o.rawTimestamp).toBe(MICROSECOND);
    expect(o.aggressorClassification).toBe("HISTORICAL_ERA_UNVERIFIED");
    expect(o.provenance.sourceClassification).not.toBe("VENUE");
  });

  it.each(["WS_BOOK_LIVE_V1", "WS_TICK_LIVE_V1"] as const)("retains seconds for %s", profile => {
    const o = observation(request(profile));
    expect(o.rawTimestamp).toBe(SECOND);
    expect(o.timestampUnit).toBe("s");
    expect(o.timestampPrecision).toBe("s");
    expect(o.timestampNs).toBe("1790000000000000000");
    expect(o.provenance.timestampPrecision).toBe("s");
    expect(o.limitations).toContain("SUBSECOND_PRECISION_UNAVAILABLE");
  });

  it("retains microseconds exactly, without Number multiplication or precision promotion", () => {
    const o = tradeObservation(request("HISTORICAL_TICK_ROW_V1"));
    expect(o.timestampUnit).toBe("us");
    expect(o.timestampPrecision).toBe("us");
    expect(o.timestampNs).toBe("1790000000123456000");
    expect(o.provenance.rawTimestamp).toBe(MICROSECOND);
    expect(o.limitations).not.toContain("SUBSECOND_PRECISION_UNAVAILABLE");
  });

  it.each(SCHEMA_PROFILES)("keeps identity/continuity/completeness unresolved for %s", profile => {
    const o = observation(request(profile));
    expect(o.contract).toBeNull();
    expect(o.providerSequence).toBeNull();
    expect(o.sequenceContinuity).toBe("UNVERIFIED");
    expect(o.provenance).toMatchObject({
      schemaProfile: profile, contract: null, providerTradeId: null, providerSequence: null,
      sampleOrigin: "SYNTHETIC_TEST", documentationCheckedAt: CHECKED_AT, completenessEvidence: "UNKNOWN",
    });
    expect(o.limitations).toEqual(expect.arrayContaining([
      "CONTRACT_UNRESOLVED", "SEQUENCE_CONTINUITY_UNVERIFIED", "COMPLETENESS_UNKNOWN",
    ]));
    expect(o).not.toHaveProperty("eventId");
    expect(o).not.toHaveProperty("sessionId");
  });

  it.each(["WS_TICK_LIVE_V1", "HISTORICAL_TICK_ROW_V1"] as const)(
    "keeps nullable trade ID and exact-dedup unavailability for %s", profile => {
      const o = tradeObservation(request(profile));
      expect(o.providerTradeId).toBeNull();
      expect(o.exactDedup).toBe("UNAVAILABLE");
      expect(o.limitations).toContain("FINAL_TRADE_STATUS_UNVERIFIED");
    });

  it("keeps explicit zero book size rather than treating it as absent", () => {
    expect(bookObservation().bids[1].size).toBe(0);
    refused(request("WS_BOOK_LIVE_V1", { ...book(), bids: [[25000]] }), "INVALID_FIELD");
  });

  it("keeps explicit zero trade size (without turning an index tick into a trade)", () => {
    expect(tradeObservation(request("WS_TICK_LIVE_V1", { ...tick(), size: 0 })).size).toBe(0);
    refused(removeField("WS_TICK_LIVE_V1", "size"), "MISSING_FIELD");
  });

  it("keeps Bid/Ask identical prices separate and marks the locked relationship", () => {
    const o = bookObservation(request("WS_BOOK_LIVE_V1", {
      ...book(), bids: [[25000, 7]], asks: [[25000, 3]],
    }));
    expect(o.bids[0].size).toBe(7);
    expect(o.asks[0].size).toBe(3);
    expect(o.bidAskRelationship).toBe("LOCKED");
    expect(o.limitations).toContain("LOCKED_OR_CROSSED_BOOK");
  });

  it("does not repair a crossed observation or certify it as a normal market", () => {
    const o = bookObservation(request("WS_BOOK_LIVE_V1", {
      ...book(), bids: [[25001, 7]], asks: [[25000, 3]],
    }));
    expect(o.bidAskRelationship).toBe("CROSSED");
    expect(o.bids[0].price).toBe(25001);
    expect(o.limitations).toContain("LOCKED_OR_CROSSED_BOOK");
  });

  it.each([{ bids: [], asks: [] }, { bids: [], asks: [[25000.25, 9]] },
    { bids: [[25000, 17]], asks: [] }])("never certifies empty arrays as a complete empty book: %j", sides => {
    const o = bookObservation(request("WS_BOOK_LIVE_V1", { ...book(), ...sides }));
    expect(o.depthCompleteness).toBe("UNKNOWN");
    expect(o.bidAskRelationship).toBe("UNKNOWN");
  });

  it("does not dedup two identical observation candidates or invent receive ordinals", () => {
    const i = request("WS_TICK_LIVE_V1");
    const a = tradeObservation(i);
    const b = tradeObservation(i);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.providerTradeId).toBeNull();
    expect(a).not.toHaveProperty("receiveOrdinal");
    expect([a, b]).toHaveLength(2);
  });

  it.each(["WS_TICK_LIVE_V1", "HISTORICAL_TICK_ROW_V1"] as const)(
    "retains explicit unknown side without inference: %s", profile => {
      const o = tradeObservation(request(profile, {
        ...(profile === "WS_TICK_LIVE_V1" ? tick() : row()), side: "unknown",
      }));
      expect(o.side).toBe("UNKNOWN");
      expect(o.rawSide).toBe("unknown");
      expect(o.limitations).toContain("AGGRESSOR_UNKNOWN");
    });

  it("accepts valid UTF-8 byte input", () => {
    const i = request("WS_BOOK_LIVE_V1");
    expect(parsePublicSample({ ...i, raw: new TextEncoder().encode(i.raw as string) }))
      .toEqual(parsePublicSample(i));
  });
});

describe("payload budget BEFORE JSON parse/decode", () => {
  it.each(["string", "bytes"])("accepts a valid exact 1 MiB %s payload", representation => {
    const i = request("WS_BOOK_LIVE_V1");
    const raw = (i.raw as string).padEnd(MAX_PAYLOAD_BYTES, " ");
    const payload = representation === "bytes" ? new TextEncoder().encode(raw) : raw;
    expect(parsePublicSample({ ...i, raw: payload }).status).toBe("ACCEPTED_OBSERVATION");
  });

  it.each(["string", "bytes"])("rejects 1 MiB + 1 %s before JSON.parse", representation => {
    const raw = " ".repeat(MAX_PAYLOAD_BYTES + 1);
    const payload = representation === "bytes" ? new TextEncoder().encode(raw) : raw;
    const spy = vi.spyOn(JSON, "parse");
    const result = parsePublicSample({ ...requestWithoutEncoding(), raw: payload });
    expect(spy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "REJECTED_MALFORMED", reasonCode: "PAYLOAD_TOO_LARGE" });
  });

  // Intentionally an unsupported extra field: exact byte-limit inputs must
  // reach structural validation, not be incorrectly rejected for byte count.
  it.each(["é", "あ", "😀", "\ud800", "\udc00"])("counts UTF-8 correctly at the byte boundary: %j", char => {
    const prefix = '{"type":"book","symbol":"NQ","bids":[],"asks":[],"imbalance":0,"ts":1790000000,"padding":"';
    const suffix = '"}';
    const overhead = prefix.length + suffix.length;
    const bytes = new TextEncoder().encode(char).byteLength;
    const count = Math.floor((MAX_PAYLOAD_BYTES - overhead) / bytes);
    const raw = prefix + char.repeat(count) + " ".repeat(MAX_PAYLOAD_BYTES - overhead - count * bytes) + suffix;
    expect(new TextEncoder().encode(raw).byteLength).toBe(MAX_PAYLOAD_BYTES);
    const i = request("WS_BOOK_LIVE_V1");
    refused({ ...i, raw }, "UNSUPPORTED_FIELD", "REJECTED_UNSUPPORTED");
    const spy = vi.spyOn(JSON, "parse");
    const r = parsePublicSample({ ...i, raw: raw + " " });
    expect(spy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ reasonCode: "PAYLOAD_TOO_LARGE" });
  });

  it("rejects oversized invalid UTF-8 before calling TextDecoder", () => {
    const i = request("WS_BOOK_LIVE_V1");
    const bytes = new Uint8Array(MAX_PAYLOAD_BYTES + 1).fill(0xff);
    const spy = vi.spyOn(TextDecoder.prototype, "decode");
    refused({ ...i, raw: bytes }, "PAYLOAD_TOO_LARGE");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([{ bytes: [0xff] }, { bytes: [0xc3, 0x28] }, { bytes: [0xc0, 0xaf] }])(
    "rejects invalid UTF-8 without replacement: %j", ({ bytes }) => {
    const i = request("WS_BOOK_LIVE_V1");
    const spy = vi.spyOn(JSON, "parse");
    refused({ ...i, raw: new Uint8Array(bytes) }, "INVALID_UTF8");
    expect(spy).not.toHaveBeenCalled();
    });

  it.each(["", "{", "NaN", "Infinity", '{"size":NaN}'])("rejects invalid JSON: %s", raw => {
    refused({ ...request("WS_TICK_LIVE_V1"), raw }, "INVALID_JSON");
  });

  it.each(["null", "[]", "5", '"a"'])("rejects non-object payloads: %s", raw => {
    refused({ ...request("WS_TICK_LIVE_V1"), raw }, "INVALID_FIELD");
  });

  it.each([null, 42, {}, ["not", "bytes"]])("rejects invalid raw input types: %j", raw => {
    refused(unchecked({ ...request("WS_TICK_LIVE_V1"), raw }), "INVALID_PAYLOAD_TYPE");
  });
});

function requestWithoutEncoding(): ParseInput {
  return {
    schemaProfile: "WS_BOOK_LIVE_V1", raw: "",
    provenance: { sourceUrl: "https://tick-stream.xyz/docs/level2", documentationCheckedAt: CHECKED_AT,
      sampleOrigin: "SYNTHETIC_TEST", timestampUnit: "s" },
    instrument: { kind: "CORE_NQ", symbol: "NQ" },
  };
}

describe("book structure/numbers/order — reject, never repair", () => {
  it.each(["bids", "asks", "imbalance", "ts", "symbol", "type"])("rejects missing %s", field => {
    const r = refused(removeField("WS_BOOK_LIVE_V1", field), "MISSING_FIELD");
    expect(r.fieldPath).toBe(`$.${field}`);
  });

  it.each([
    { bids: null }, { asks: {} }, { bids: [null] }, { bids: [[]] },
    { asks: [[25000.25]] }, { bids: [[25000, 2, "extra"]] },
    { bids: [{ price: 25000, size: 3 }] },
  ])("rejects malformed levels: %j", patch => {
    refused(request("WS_BOOK_LIVE_V1", { ...book(), ...patch }), "INVALID_FIELD");
  });

  it.each([25000.1, 25000.249999999996, Number.MAX_SAFE_INTEGER])("rejects off-grid/unsafe price %s", p => {
    const r = refused(request("WS_BOOK_LIVE_V1", { ...book(), bids: [[p, 2]] }), "OFF_TICK_GRID");
    expect(r.fieldPath).toBe("$.bids[0][0]");
  });

  it.each([null, "25000", true])("rejects invalid level price %j", p => {
    refused(request("WS_BOOK_LIVE_V1", { ...book(), bids: [[p, 2]] }), "INVALID_PRICE");
  });

  it.each([-1, 1.5, null, "2", true, Number.MAX_SAFE_INTEGER + 1])("rejects level size %j", size => {
    refused(request("WS_BOOK_LIVE_V1", { ...book(), asks: [[25000.25, size]] }), "INVALID_QUANTITY");
  });

  it.each(["bids", "asks"] as const)("rejects same-side duplicate prices: %s", side => {
    refused(request("WS_BOOK_LIVE_V1", { ...book(), [side]: [[25000, 4], [25000, 9]] }), "DUPLICATE_PRICE");
  });

  it.each([
    { bids: [[24999.75, 1], [25000, 2]] },
    { asks: [[25000.5, 1], [25000.25, 2]] },
  ])("rejects unsorted sides without sorting: %j", patch => {
    refused(request("WS_BOOK_LIVE_V1", { ...book(), ...patch }), "INVALID_BOOK_ORDER");
  });

  it.each([-1.01, 1.01, null, "0.1"])("rejects imbalance %j", imbalance => {
    refused(request("WS_BOOK_LIVE_V1", { ...book(), imbalance }), "INVALID_IMBALANCE");
  });

  it.each([-1, 0, 1])("accepts imbalance boundary %s", imbalance => {
    expect(bookObservation(request("WS_BOOK_LIVE_V1", { ...book(), imbalance })).imbalance).toBe(imbalance);
  });

  it("rejects provider-depth claims outside the reviewed wire schema", () => {
    refused(request("WS_BOOK_LIVE_V1", { ...book(), depth: 400 }), "UNSUPPORTED_FIELD", "REJECTED_UNSUPPORTED");
  });
});

describe("tick fields/numeric/time boundaries", () => {
  it.each(["price", "size", "side", "exch", "ts", "symbol"])("rejects missing tick %s", field => {
    refused(removeField("WS_TICK_LIVE_V1", field), "MISSING_FIELD");
  });

  it.each(SCHEMA_PROFILES)("rejects missing timestamp for %s", profile => {
    refused(removeField(profile, "ts"), "MISSING_FIELD");
  });

  it.each([null, "1790000000", 1.5, -1, true, Number.MAX_SAFE_INTEGER + 1])("rejects timestamp %j", ts => {
    refused(request("WS_TICK_LIVE_V1", { ...tick(), ts }), "INVALID_TIMESTAMP");
  });

  it("rejects an overflowing JSON integer rather than accepting its rounded value", () => {
    const i = request("HISTORICAL_TICK_ROW_V1");
    refused({ ...i, raw: '{"price":25000.25,"size":1,"side":"buy","ts":9007199254740993}' }, "INVALID_TIMESTAMP");
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("converts safe timestamp boundary %s exactly", ts => {
    const o = tradeObservation(request("WS_TICK_LIVE_V1", { ...tick(), ts }));
    expect(o.timestampNs).toBe((BigInt(ts) * 1_000_000_000n).toString());
    expect(o.timestampPrecision).toBe("s");
  });

  it("never infers timestamp units from the number's digit count", () => {
    const o = tradeObservation(request("WS_TICK_LIVE_V1", { ...tick(), ts: MICROSECOND }));
    expect(o.timestampUnit).toBe("s");
    expect(o.timestampNs).toBe("1790000000123456000000000");
  });

  it.each([-1, 0.5, null, "10", Number.MAX_SAFE_INTEGER + 1])("rejects tick quantity %j", size => {
    refused(request("WS_TICK_LIVE_V1", { ...tick(), size }), "INVALID_QUANTITY");
  });

  it.each([null, "25000.25", true])("rejects invalid tick price %j", price => {
    refused(request("WS_TICK_LIVE_V1", { ...tick(), price }), "INVALID_PRICE");
  });

  it("rejects off-grid tick price", () => {
    refused(request("WS_TICK_LIVE_V1", { ...tick(), price: 25000.1 }), "OFF_TICK_GRID");
  });

  it.each(["price", "size", "ts"])("rejects finite-JSON syntax yielding Infinity in %s", field => {
    const i = request("WS_TICK_LIVE_V1");
    const raw = (i.raw as string).replace(new RegExp(`"${field}":[^,}]+`), `"${field}":1e309`);
    refused({ ...i, raw }, field === "price" ? "INVALID_PRICE" : field === "ts" ? "INVALID_TIMESTAMP" : "INVALID_QUANTITY");
  });

  it.each(["BUY", "hold", "", 1, null])("rejects unrecognized side instead of guessing: %j", side => {
    refused(request("WS_TICK_LIVE_V1", { ...tick(), side }), "INVALID_SIDE");
  });

  it.each(["", "OTHER", null, 1])("rejects unsupported/invalid exchange %j", exch => {
    refused(request("WS_TICK_LIVE_V1", { ...tick(), exch }), "INVALID_EXCHANGE");
  });

  it.each(["tradeId", "sequence", "contract"])("does not silently consume undocumented %s", key => {
    refused(request("WS_TICK_LIVE_V1", { ...tick(), [key]: "not-a-reviewed-native-field" }),
      "UNSUPPORTED_FIELD", "REJECTED_UNSUPPORTED");
  });
});

describe("profile/provenance/instrument boundaries", () => {
  it("rejects an absent parser request", () => {
    refused(unchecked(null), "INVALID_REQUEST");
  });

  it.each(["UNKNOWN", "HISTORICAL_BOOK_SNAPSHOT", "HISTORICAL_BOOK_INCREMENTAL", "ARCHIVE_CSV", "L3_MBO"])(
    "does not add an unapproved profile: %s", schemaProfile => {
      const r = refused(unchecked({ ...request("WS_BOOK_LIVE_V1"), schemaProfile }),
        "UNSUPPORTED_SCHEMA_PROFILE", "REJECTED_UNSUPPORTED");
      expect(r.schemaProfile).toBeNull();
    });

  it.each(["warning", "error", "welcome", "ping", "l3", "unrecognized", "tick"])(
    "rejects incompatible book message family %s", type => {
      refused(request("WS_BOOK_LIVE_V1", { ...book(), type }), "UNSUPPORTED_MESSAGE_FAMILY", "REJECTED_UNSUPPORTED");
    });

  it("rejects a book supplied under the tick profile", () => {
    refused(request("WS_TICK_LIVE_V1", book()), "UNSUPPORTED_MESSAGE_FAMILY", "REJECTED_UNSUPPORTED");
  });

  it("rejects historical incremental book rows under the historical tick profile", () => {
    refused(request("HISTORICAL_TICK_ROW_V1", {
      ts: MICROSECOND, side: "bid", level: 1, price: 25000, size: 10, flag: 0,
    }), "UNSUPPORTED_FIELD", "REJECTED_UNSUPPORTED");
  });

  it("rejects historical snapshot book rows even when flag=0", () => {
    refused(request("HISTORICAL_TICK_ROW_V1", {
      ts: MICROSECOND, side: "ask", level: 1, price: 25000.25, size: 10, flag: 0,
    }), "UNSUPPORTED_FIELD", "REJECTED_UNSUPPORTED");
  });

  it.each(["QQQ", "SPX", "NDX", "VIX", "NQZ6"])("never treats %s as a supported root futures trade", symbol => {
    refused(request("WS_TICK_LIVE_V1", { ...tick(), symbol, size: 0, side: "unknown" }),
      "UNSUPPORTED_INSTRUMENT", "REJECTED_UNSUPPORTED");
  });

  it.each([null, "", 42])("rejects invalid symbol %j", symbol => {
    refused(request("WS_TICK_LIVE_V1", { ...tick(), symbol }), "INVALID_FIELD");
  });

  it("requires instrument context even for a known NQ symbol", () => {
    refused({ ...request("WS_BOOK_LIVE_V1"), instrument: undefined },
      "INSTRUMENT_CONTEXT_MISSING", "INCOMPLETE_PROVENANCE");
  });

  it.each([
    { kind: "CORE_NQ", symbol: "NQ" },
    { kind: "EXPLICIT_QUARTER_POINT", symbol: "ES", tickSize: 0.5, evidence: "synthetic" },
    { kind: "EXPLICIT_QUARTER_POINT", symbol: "ES", tickSize: 0.25, evidence: "" },
  ])("requires ES matching explicit instrument/grid/evidence: %j", instrument => {
    refused(unchecked({ ...request("WS_BOOK_LIVE_V1", book("ES")), instrument }),
      "INSTRUMENT_CONTEXT_MISMATCH", "INCOMPLETE_PROVENANCE");
  });

  it.each([null, undefined])("requires provenance context: %s", provenance => {
    refused(unchecked({ ...request("WS_TICK_LIVE_V1"), provenance }), "MISSING_PROVENANCE", "INCOMPLETE_PROVENANCE");
  });

  it.each(SCHEMA_PROFILES)("requires explicit unit for %s", profile => {
    const i = request(profile);
    refused(unchecked({ ...i, provenance: { ...i.provenance, timestampUnit: undefined } }),
      "TIMESTAMP_UNIT_MISSING", "INCOMPLETE_PROVENANCE");
  });

  it.each(SCHEMA_PROFILES)("rejects conflicting unit for %s", profile => {
    const i = request(profile);
    refused({ ...i, provenance: { ...i.provenance, timestampUnit: profile === "HISTORICAL_TICK_ROW_V1" ? "s" : "us" } },
      "TIMESTAMP_UNIT_MISMATCH");
  });

  it.each(["https://example.com", "https://tick-stream.xyz/docs/rest", "", undefined])(
    "requires the reviewed source URL: %s", sourceUrl => {
      const i = request("WS_BOOK_LIVE_V1");
      refused(unchecked({ ...i, provenance: { ...i.provenance, sourceUrl } }),
        "INVALID_PROVENANCE", "INCOMPLETE_PROVENANCE");
    });

  it.each(["not-a-date", "2026-02-30T00:00:00Z", "2026-10-23", "", undefined])(
    "requires an actual UTC check instant: %s", documentationCheckedAt => {
      const i = request("WS_BOOK_LIVE_V1");
      refused(unchecked({ ...i, provenance: { ...i.provenance, documentationCheckedAt } }),
        "INVALID_PROVENANCE", "INCOMPLETE_PROVENANCE");
    });

  it("rejects missing origin rather than claiming an actual provider response", () => {
    const i = request("WS_BOOK_LIVE_V1");
    refused(unchecked({ ...i, provenance: { ...i.provenance, sampleOrigin: undefined } }),
      "INVALID_PROVENANCE", "INCOMPLETE_PROVENANCE");
  });

  it.each([undefined, null, {}, { symbol: "" }, { symbol: 7 }])("requires explicit historical parent: %j", historicalParent => {
    refused(unchecked({ ...request("HISTORICAL_TICK_ROW_V1"), historicalParent }),
      "HISTORICAL_PARENT_MISSING", "INCOMPLETE_PROVENANCE");
  });

  it("does not substitute instrument symbol for historical parent", () => {
    refused({ ...request("HISTORICAL_TICK_ROW_V1"), historicalParent: { symbol: "ES" } },
      "INSTRUMENT_CONTEXT_MISMATCH", "INCOMPLETE_PROVENANCE");
  });
});

describe("pure deterministic output and discriminated unions", () => {
  it("does not call networking, console, randomness or the system clock", () => {
    const i = request("WS_BOOK_LIVE_V1");
    const forbidden = vi.fn(() => { throw new Error("Forbidden side effect"); });
    vi.stubGlobal("fetch", forbidden);
    vi.spyOn(Date, "now").mockImplementation(forbidden);
    vi.spyOn(Math, "random").mockImplementation(forbidden);
    const log = vi.spyOn(console, "log").mockImplementation(forbidden);
    const error = vi.spyOn(console, "error").mockImplementation(forbidden);
    const a = parsePublicSample(i);
    const b = parsePublicSample(i);
    expect(a).toEqual(b);
    expect(forbidden).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not mutate inputs and returns detached deeply frozen observations", () => {
    const i = request("WS_BOOK_LIVE_V1");
    const before = JSON.stringify(i);
    Object.freeze(i.provenance);
    Object.freeze(i.instrument);
    Object.freeze(i);
    const o = bookObservation(i);
    expect(JSON.stringify(i)).toBe(before);
    expect(o.provenance).not.toBe(i.provenance);
    for (const v of [o, o.provenance, o.bids, o.bids[0], o.asks, o.limitations]) {
      expect(Object.isFrozen(v)).toBe(true);
    }
    expect(Object.isFrozen(SCHEMA_PROFILES)).toBe(true);
    expect(Object.isFrozen(REASON_CODES)).toBe(true);
  });

  it("does not mutate caller-owned byte buffers", () => {
    const i = request("WS_TICK_LIVE_V1");
    const bytes = new TextEncoder().encode(i.raw as string);
    const copy = bytes.slice();
    tradeObservation({ ...i, raw: bytes });
    expect(bytes).toEqual(copy);
  });

  it("returns stable structured refusals without echoing raw payload", () => {
    const i = { ...request("WS_TICK_LIVE_V1"), raw: "SYNTHETIC_SENTINEL_NOT_JSON" };
    const a = parsePublicSample(i);
    expect(a).toEqual(parsePublicSample(i));
    expect(JSON.stringify(a)).not.toContain("SYNTHETIC_SENTINEL");
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("narrows all four result variants without native event types", () => {
    const inspect = (r: ParseResult): string => {
      switch (r.status) {
        case "ACCEPTED_OBSERVATION":
          expectTypeOf(r.observation).toEqualTypeOf<BookObservation | TradeObservation>();
          return r.observation.kind;
        case "REJECTED_MALFORMED":
        case "REJECTED_UNSUPPORTED":
        case "INCOMPLETE_PROVENANCE": return r.reasonCode;
        default: { const unreachable: never = r; return unreachable; }
      }
    };
    expect(inspect(parsePublicSample(request("WS_BOOK_LIVE_V1")))).toBe("BOOK_OBSERVATION");
  });
});
