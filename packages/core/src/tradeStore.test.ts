import { describe, expect, it } from "vitest";
import { F01_BOOK, F04_TRADES, F08_DUPLICATE_TRADES } from "../../fixtures/src/index";
import { executedVolume, type DataQualityInterval, type Trade } from "./events";
import {
  createTradeStore, ingestTrade, tradeScopeKey, withTradeQuality,
} from "./tradeStore";

const first = F04_TRADES.events[0];
const fresh = () => createTradeStore(first.header);
const change = (patch: Partial<Trade> = {}, header: Partial<Trade["header"]> = {}): Trade =>
  ({ ...first, ...patch, header: { ...first.header, ...header } });
const valid: DataQualityInterval = { channel: "TRADES", startNs: "1767261600000000000",
  endNs: "1767261602000000000", status: "VALID", reason: "MOCK observation" };

describe("R08 trade identity and audit", () => {
  it("accepts a normal trade without changing the input or old store", () => {
    const store = fresh(), before = JSON.stringify(first);
    const result = ingestTrade(store, first);
    expect(result.disposition).toBe("ACCEPTED");
    expect(store.rawEvents).toHaveLength(0);
    expect(result.store.rawEvents).toHaveLength(1);
    expect(result.store.trades).toHaveLength(1);
    expect(JSON.stringify(first)).toBe(before);
  });
  it("F08 preserves two raw deliveries but only one unique trade", () => {
    let store = fresh();
    store = createTradeStore(F08_DUPLICATE_TRADES.events[0].header);
    const results = F08_DUPLICATE_TRADES.events.map((event) => {
      const result = ingestTrade(store, event); store = result.store; return result.disposition;
    });
    expect(results).toEqual(["ACCEPTED", "DUPLICATE"]);
    expect(store.rawEvents).toHaveLength(2);
    expect(store.trades).toHaveLength(1);
    expect(store.issues).toEqual([]);
  });
  it("an exact redelivery is retained in the audit array", () => {
    const once = ingestTrade(fresh(), first).store;
    const twice = ingestTrade(once, first);
    expect(twice.disposition).toBe("DUPLICATE");
    expect(twice.store.rawEvents).toHaveLength(2);
    expect(twice.store.trades).toHaveLength(1);
  });
  it("the same time with a different trade ID is another trade", () => {
    const once = ingestTrade(fresh(), first).store;
    const result = ingestTrade(once, change({ tradeId: "OTHER" }));
    expect(result.disposition).toBe("ACCEPTED");
    expect(result.store.trades).toHaveLength(2);
  });
  it.each([
    { qty: executedVolume(13) }, { priceTicks: 80001 }, { aggressor: "SELL" as const },
    { classification: "VENDOR_DECLARED" as const }, { originalTradeId: "OTHER" },
  ])("same ID with different content is a conflict: %j", (patch) => {
    const once = ingestTrade(fresh(), first).store;
    const result = ingestTrade(once, change(patch));
    expect(result.disposition).toBe("CONFLICTING_TRADE_ID");
    expect(result.store.issues[0].code).toBe("CONFLICTING_TRADE_ID");
    expect(result.store.rawEvents).toHaveLength(2);
    expect(result.store.trades[0].qty).toBe(12);
  });
  it.each([
    { exchangeTimeNs: "1767261600300000001" }, { quality: "SUSPECT" as const },
    { sourceTimePrecision: "ms" as const },
  ])("changed event-time/quality/precision is not a harmless retransmission: %j", (header) => {
    const result = ingestTrade(ingestTrade(fresh(), first).store, change({}, header));
    expect(result.disposition).toBe("CONFLICTING_TRADE_ID");
  });
  it.each([
    { canonicalInstrumentId: "CME:NQ:2026-06" }, { sessionId: "OTHER" }, { sourceId: "OTHER" },
    { environment: "REPLAY_FROM_SAVED_DATA" as const },
    { environment: "LIVE" as const, source: "VENDOR_UNVERIFIED" as const },
  ])("does not mix scoped identities: %j", (header) => {
    expect(() => ingestTrade(fresh(), change({}, header))).toThrow(/identity/);
    const event = change({}, header);
    const separate = ingestTrade(createTradeStore(event.header), event);
    expect(separate.disposition).toBe("ACCEPTED");
    expect(tradeScopeKey(separate.store.scope)).not.toBe(tradeScopeKey(fresh().scope));
  });
  it("scoped keys cannot collide through delimiter-containing identifiers", () => {
    expect(tradeScopeKey({ ...fresh().scope, sourceId: "a|b", sessionId: "c" }))
      .not.toBe(tradeScopeKey({ ...fresh().scope, sourceId: "a", sessionId: "b|c" }));
  });
  it.each(["TRADE_CORRECTION", "TRADE_CANCEL"] as const)("never adds %s as a normal trade", (kind) => {
    const once = ingestTrade(fresh(), first).store;
    const result = ingestTrade(once, change({ kind, originalTradeId: first.tradeId }));
    expect(result.disposition).toBe("UNSUPPORTED_REVISION");
    expect(result.store.rawEvents).toHaveLength(2);
    expect(result.store.trades).toHaveLength(1);
    expect(result.store.trades[0]).toEqual(first);
  });
  it("an unmatched correction is retained and explicitly unsupported", () => {
    const result = ingestTrade(fresh(), change({ kind: "TRADE_CORRECTION", originalTradeId: "MISSING" }));
    expect(result.store.trades).toEqual([]);
    expect(result.store.issues[0].originalTradeId).toBe("MISSING");
    expect(result.store.rawEvents).toHaveLength(1);
  });
  it("copies and freezes deliveries, not the caller's event", () => {
    const event = change(), result = ingestTrade(fresh(), event);
    (event.header as { eventId: string }).eventId = "MUTATED_CALLER";
    expect(result.store.rawEvents[0].header.eventId).toBe(first.header.eventId);
    expect(Object.isFrozen(event)).toBe(false);
    expect(Object.isFrozen(result.store.rawEvents[0])).toBe(true);
    expect(Object.isFrozen(result.store.rawEvents[0].header)).toBe(true);
    expect(Object.isFrozen(result.store.rawEvents)).toBe(true);
  });
  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "12", null])(
    "rejects invalid executed quantity %s", (qty) => {
      expect(() => ingestTrade(fresh(), { ...first, qty })).toThrow();
    });
  it.each([80000.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "80000"])(
    "rejects invalid Tick price %s", (priceTicks) => {
      expect(() => ingestTrade(fresh(), { ...first, priceTicks })).toThrow();
    });
  it("accepts zero quantity", () => {
    expect(ingestTrade(fresh(), change({ qty: executedVolume(0) })).disposition).toBe("ACCEPTED");
  });
  it("requires exchange time instead of falling back to receive time", () => {
    expect(() => ingestTrade(fresh(), change({}, { exchangeTimeNs: null }))).toThrow(/exchangeTimeNs/);
  });
  it("retains nanosecond time strings exactly", () => {
    const event = change({}, { exchangeTimeNs: "1767261601999999999" });
    expect(ingestTrade(fresh(), event).store.trades[0].header.exchangeTimeNs)
      .toBe("1767261601999999999");
  });
  it("rejects board events and board-channel stores", () => {
    expect(() => ingestTrade(fresh(), F01_BOOK.events[0])).toThrow();
    expect(() => createTradeStore({ ...first.header, channel: "L2_MBP" })).toThrow();
  });
});

describe("R08 explicit scope-local Trade quality", () => {
  it("starts with no invented observation coverage", () => {
    expect(fresh().quality).toEqual([]);
  });
  it("copies quality records and leaves the caller untouched", () => {
    const q = { ...valid }, result = withTradeQuality(fresh(), [q]);
    q.reason = "changed";
    expect(result.quality[0].reason).toBe("MOCK observation");
    expect(Object.isFrozen(result.quality[0])).toBe(true);
  });
  it("accepts VALID/GAP/VALID intervals and explicit open-ended observation", () => {
    const result = withTradeQuality(fresh(), [
      { ...valid, endNs: "1767261601000000000" },
      { ...valid, startNs: "1767261601000000000", status: "GAP" },
      { ...valid, startNs: "1767261602000000000", endNs: null },
    ]);
    expect(result.quality).toHaveLength(3);
  });
  it("does not borrow L2 quality for Trade", () => {
    expect(() => withTradeQuality(fresh(), [{ ...valid, channel: "L2_MBP" }])).toThrow(/TRADES/);
  });
  it.each([
    [{ ...valid }, { ...valid }],
    [{ ...valid, endNs: null }, { ...valid, startNs: "1767261603000000000" }],
    [{ ...valid, startNs: "1767261601000000000" }, { ...valid, endNs: "1767261601000000000" }],
  ].map((quality) => [quality] as const))("rejects overlapping/unordered observation evidence %j", (quality) => {
    expect(() => withTradeQuality(fresh(), quality)).toThrow();
  });
  it("rejects an invalid quality interval", () => {
    expect(() => withTradeQuality(fresh(), [{ ...valid, endNs: valid.startNs }])).toThrow();
  });
});
