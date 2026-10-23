import { describe, expect, it } from "vitest";
import { canonicalObservation, parseObservation } from "@workspace/tickstream-adapter/live-observation";
import { OFFLINE_LIVE_MODE, offlineLiveRecord, validateLiveRecord } from "./liveRecord";

const wire = { type: "tick", symbol: "NQ", ts: 1700000000, price: 20000.25, size: 12, side: "buy", exch: "CME" };
const context = { origin: "SYNTHETIC_TEST", channel: "ticks", timestampUnit: "s",
  receivedAtUtcNs: "1700000000000000000", receivedAtMonotonicNs: "12345678901234567890",
  connectionEpoch: 1, receiveOrdinal: 1 } as const;
const observation = () => parseObservation(JSON.stringify(wire), context);
const record = () => offlineLiveRecord(observation());

describe("B-2A strict offline LIVE-equivalent record", () => {
  it("preserves every required value, explicit precision and unknown quality", () => {
    const r = record();
    expect(r).toEqual({
      schema: "TICKSTREAM_LIVE_TICK_RECORD_V1", testMode: OFFLINE_LIVE_MODE, inputOrigin: "SYNTHETIC_TEST",
      environment: "LIVE", provider: "TICKSTREAM", channel: "ticks", requestedSymbol: "NQ", providerSymbol: "NQ",
      individualContract: null, providerTimestamp: 1700000000, providerTimestampUnit: "s", providerTimestampPrecision: "s",
      receivedAtUtcNs: context.receivedAtUtcNs, clockPrecision: "ms",
      receivedAtMonotonicNs: context.receivedAtMonotonicNs, connectionEpoch: 1, receiveOrdinal: 1,
      price: 20000.25, priceTicks: 80001, size: 12, side: "BUY", exchange: "CME",
      schemaProfile: "WS_TICK_LIVE_V1", parserVersion: "tickstream-observation-wrapper-1",
      validationStatus: "ACCEPTED_OBSERVATION", qualityStatus: "COMPLETENESS_UNKNOWN",
      tradeId: null, providerSequence: "UNAVAILABLE", continuityStatus: "UNKNOWN",
    });
    expect(validateLiveRecord(r)).toEqual(r); expect(Object.isFrozen(r)).toBe(true);
    expect(canonicalObservation(validateLiveRecord(r))).toBe(canonicalObservation(r));
  });
  it("does not claim real data or accept an actual-provider observation in B-2A", () => {
    const actual = parseObservation(JSON.stringify(wire), { ...context, origin: "ACTUAL_PROVIDER_RESPONSE" });
    expect(() => offlineLiveRecord(actual)).toThrow("LIVE_PRODUCTION_DISABLED");
    expect(record().inputOrigin).toBe("SYNTHETIC_TEST");
  });
  it.each([
    ["environment", "SIMULATED"], ["inputOrigin", "ACTUAL_PROVIDER_RESPONSE"], ["testMode", "PRODUCTION"],
    ["provider", "OTHER"], ["channel", "book"], ["requestedSymbol", "ES"], ["providerSymbol", "ES"],
    ["individualContract", "NQZ6"], ["providerTimestampUnit", "us"], ["providerTimestampPrecision", "ns"],
    ["clockPrecision", "ns"], ["schemaProfile", "WS_BOOK_LIVE_V1"], ["parserVersion", "changed"],
    ["qualityStatus", "COMPLETE"], ["continuityStatus", "VALID"], ["providerSequence", 1],
    ["tradeId", "invented"], ["validationStatus", "REJECTED"], ["priceTicks", 80002],
    ["price", 20000.1], ["size", -1], ["size", 1.5], ["size", Number.MAX_SAFE_INTEGER + 1],
    ["connectionEpoch", 0], ["receiveOrdinal", 0], ["side", "B"],
    ["providerTimestamp", 1700000000000000], ["receivedAtUtcNs", "1700000000000000001"],
    ["receivedAtMonotonicNs", "1e10"], ["exchange", "KEY_SENTINEL"],
  ])("rejects altered %s=%s without leaking input", (field, value) => {
    expect(() => validateLiveRecord({ ...record(), [field]: value })).toThrow(/^LIVE_RECORD_INVALID$/);
  });
  it.each(["key", "TICKSTREAM_API_KEY", "url", "raw", "diagnostics", "__proto__"])(
    "rejects extra field %s rather than copying it to a file", field => {
      const input = Object.assign(Object.create(null), record()); input[field] = "SECRET_SENTINEL";
      expect(() => validateLiveRecord(input)).toThrow(/^LIVE_RECORD_INVALID$/);
    });
  it.each(["buy", "sell", "unknown"])("preserves %s without certifying aggressor direction", side => {
    const r = offlineLiveRecord(parseObservation(JSON.stringify({ ...wire, side }), context));
    expect(r.side).toBe(side.toUpperCase()); expect(r.qualityStatus).toBe("COMPLETENESS_UNKNOWN");
  });
  it.each([null, [], {}, { secret: "SECRET_SENTINEL" }])("rejects malformed input %j", input => {
    expect(() => validateLiveRecord(input)).toThrow(/^LIVE_RECORD_INVALID$/);
  });
  it("accepts known zero size separately from UNKNOWN side", () => {
    const r = offlineLiveRecord(parseObservation(JSON.stringify({ ...wire, size: 0, side: "unknown" }), context));
    expect(r.size).toBe(0); expect(r.side).toBe("UNKNOWN");
  });
  it("rejects rejected/book observations and unverified timestamp context", () => {
    expect(() => offlineLiveRecord(parseObservation('{"secret":"SENTINEL"}', context))).toThrow("LIVE_RECORD_INVALID");
    expect(() => offlineLiveRecord(parseObservation(JSON.stringify({ ...wire, ts: wire.ts - 86401 }), context)))
      .toThrow("LIVE_RECORD_INVALID");
    expect(() => offlineLiveRecord(parseObservation(JSON.stringify({ ...wire, ts: wire.ts + 6 }), context)))
      .toThrow("LIVE_RECORD_INVALID");
    const book = parseObservation(JSON.stringify({ type: "book", symbol: "NQ", ts: wire.ts,
      bids: [[20000, 1]], asks: [[20000.25, 1]], imbalance: 0 }), { ...context, channel: "book" });
    expect(() => offlineLiveRecord(book)).toThrow("LIVE_RECORD_INVALID");
  });
});
