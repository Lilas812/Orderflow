import { describe, expect, it } from "vitest";
import { canonicalObservation, parseObservation, validateObservation, type ReceiveContext } from "./liveObservation";

const context: ReceiveContext = {
  origin: "SYNTHETIC_TEST", channel: "ticks", timestampUnit: "s",
  receivedAtUtcNs: "1700000000000000000", receivedAtMonotonicNs: "9007199254740993123",
  connectionEpoch: 1, receiveOrdinal: 1,
};
const tick = { type: "tick", symbol: "NQ", price: 20000.25, size: 12, side: "buy", exch: "CME", ts: 1700000000 };
const book = { type: "book", symbol: "NQ", bids: [[20000, 0]], asks: [[20000.25, 40]], imbalance: -.5, ts: 1700000000 };
describe("separate observation wrapper; no network and no generated market identity", () => {
  it.each(["SYNTHETIC_TEST", "ACTUAL_PROVIDER_RESPONSE"] as const)("derives provenance from explicit origin %s, not payload", origin => {
    const r = parseObservation(JSON.stringify(tick), { ...context, origin });
    expect(r.provenance).toMatchObject({
      environment: origin === "SYNTHETIC_TEST" ? "SIMULATED" : "LIVE", sampleOrigin: origin,
      provider: "TICKSTREAM", channel: "ticks", requestedSymbol: "NQ", providerSymbol: "NQ",
      individualContract: null, sequenceStatus: "UNAVAILABLE", continuityStatus: "UNKNOWN",
      receivedAtMonotonicNs: context.receivedAtMonotonicNs, receivedAtUtcPrecision: "ms",
    });
    expect(r.result.status).toBe("ACCEPTED_OBSERVATION");
    expect(validateObservation(r)).toEqual(r);
  });
  it("retains two economically identical trades with distinct local receive ordinals", () => {
    const a = parseObservation(JSON.stringify(tick), context);
    const b = parseObservation(JSON.stringify(tick), { ...context, receiveOrdinal: 2 });
    expect(a.result).toEqual(b.result);
    expect(a.provenance.receiveOrdinal).not.toBe(b.provenance.receiveOrdinal);
    if (a.result.status === "ACCEPTED_OBSERVATION" && a.result.observation.kind === "TRADE_OBSERVATION") {
      expect(a.result.observation.providerTradeId).toBeNull();
      expect(a.result.observation.exactDedup).toBe("UNAVAILABLE");
      expect(a.result.observation.timestampNs).toBe("1700000000000000000");
      expect(a.result.observation.timestampPrecision).toBe("s");
    }
  });
  it("round-trips a coalesced book with known zero without inventing continuity", () => {
    const r = parseObservation(JSON.stringify(book), { ...context, channel: "book" });
    expect(validateObservation(r)).toEqual(r);
    expect(r.result.status).toBe("ACCEPTED_OBSERVATION");
    if (r.result.status === "ACCEPTED_OBSERVATION" && r.result.observation.kind === "BOOK_OBSERVATION") {
      expect(r.result.observation.bids[0].size).toBe(0);
      expect(r.result.observation.depthCompleteness).toBe("UNKNOWN");
    }
  });
  it.each([0, 1, -1])("retains locked/crossed/uncrossed book status without validity certification %s", delta => {
    const r = parseObservation(JSON.stringify({ ...book, asks: [[20000 + delta * .25, 1]] }), { ...context, channel: "book" });
    expect(r.result.status).toBe("ACCEPTED_OBSERVATION");
    expect(r.provenance.continuityStatus).toBe("UNKNOWN");
  });
  it.each([
    [{ ...tick, extra: "SECRET_SENTINEL" }, "UNSUPPORTED_FIELD"],
    [{ ...tick, size: -1 }, "INVALID_QUANTITY"],
    [{ ...tick, size: 1.5 }, "INVALID_QUANTITY"],
    [{ ...tick, price: 20000.1 }, "OFF_TICK_GRID"],
    [{ ...tick, symbol: "ES" }, "INSTRUMENT_CONTEXT_MISMATCH"],
  ])("preserves parser refusal without storing raw or field names", (wire, reason) => {
    const r = parseObservation(JSON.stringify(wire), context);
    expect(r.result).toEqual({ status: "REJECTED", reasonCode: reason });
    expect(canonicalObservation(r)).not.toContain("SECRET_SENTINEL");
    expect(validateObservation(r)).toEqual(r);
  });
  it("rejects a unit mismatch instead of guessing", () => {
    const r = parseObservation(JSON.stringify(tick), { ...context, timestampUnit: "us" });
    expect(r.result).toEqual({ status: "REJECTED", reasonCode: "TIMESTAMP_UNIT_MISMATCH" });
    expect(validateObservation(r)).toEqual(r);
  });
  it.each([
    { receiveOrdinal: 0 }, { connectionEpoch: -1 }, { receivedAtUtcNs: "1700000000000000001" },
    { receivedAtMonotonicNs: "1e9" }, { receivedAtUtcNs: "01" }, { origin: "UNKNOWN" },
  ])("rejects invalid receive context and fabricated UTC precision", override => {
    expect(() => parseObservation(JSON.stringify(tick), { ...context, ...override } as ReceiveContext)).toThrow("OBSERVATION_CONTEXT");
  });
  it.each(["unexpected", "providerSequence", "priceTicks", "timestampNs"])("rejects stored metadata/derived field tampering %s", field => {
    const r = JSON.parse(JSON.stringify(parseObservation(JSON.stringify(tick), context)));
    if (field === "unexpected") r[field] = "SECRET_SENTINEL";
    else if (field === "providerSequence") r.result.observation.providerSequence = 1;
    else r.result.observation[field] = -1;
    expect(() => validateObservation(r)).toThrow("OBSERVATION_INVALID");
  });
  it("rejects records larger than the bounded record budget", () => {
    expect(() => validateObservation({ extra: "x".repeat(1024 * 1024 + 1) })).toThrow("OBSERVATION_INVALID");
  });
});
