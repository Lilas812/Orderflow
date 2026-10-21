import { describe, expect, expectTypeOf, it } from "vitest";
import {
  executedVolume, restingQuantity, validateDataQualityInterval,
  validateEventHeader, validateMarketEvent,
  type ExecutedVolume, type RestingQuantity,
} from "./events";
// Relative test-only import avoids a core -> fixtures -> core package cycle.
import { F01_BOOK, F04_TRADES } from "../../fixtures/src/index";

const snapshot = F01_BOOK.events[0];
const update = F01_BOOK.events[1];
const trade = F04_TRADES.events[0];
const l1 = {
  kind: "L1_QUOTE",
  header: { ...snapshot.header, channel: "L1" },
  bestBidTick: 80000, bestAskTick: 80001, bidQty: 0, askQty: null,
};
const quality = {
  channel: "L2_MBP", startNs: "1767225600000000001",
  endNs: "1767225600000000002", status: "GAP", reason: "MOCK test gap",
};

describe("R01 event structures", () => {
  it.each([...F01_BOOK.events, ...F04_TRADES.events, l1])(
    "accepts valid $kind without modifying the input",
    (event) => {
      const before = JSON.stringify(event);
      expect(validateMarketEvent(event)).toBe(event);
      expect(JSON.stringify(event)).toBe(before);
    },
  );

  it.each(["BID", "ASK"])("keeps book side %s distinct", (side) => {
    expect(validateMarketEvent({ ...update, side })).toMatchObject({ side });
  });

  it.each(["BUY", "SELL", "UNKNOWN"])("preserves aggressor %s", (aggressor) => {
    const event = { ...trade, aggressor, classification: "UNKNOWN" };
    expect(validateMarketEvent(event)).toMatchObject({ aggressor, qty: 12 });
  });

  it.each(["TRADE_CORRECTION", "TRADE_CANCEL"])(
    "accepts %s structure without applying a revision",
    (kind) => {
      expect(validateMarketEvent({ ...trade, kind, originalTradeId: "MOCK-TRADE-ORIGINAL" }))
        .toMatchObject({ kind, originalTradeId: "MOCK-TRADE-ORIGINAL" });
    },
  );

  it.each([
    { type: "FULL" },
    { type: "TOP_N", n: 10 },
    { type: "PRICE_RANGE", minTick: 80000, maxTick: 80001 },
  ])("accepts depth scope $type", (depthScope) => {
    expect(validateMarketEvent({ ...snapshot, depthScope })).toMatchObject({ depthScope });
  });

  it("separates resting quantities and executed volumes at type level", () => {
    expectTypeOf<RestingQuantity>().not.toEqualTypeOf<ExecutedVolume>();
    expectTypeOf<ExecutedVolume>().not.toExtend<RestingQuantity>();
    expectTypeOf<RestingQuantity>().not.toExtend<ExecutedVolume>();
    expect(restingQuantity(0)).toBe(0);
    expect(executedVolume(12)).toBe(12);
  });

  it("keeps known zero and unknown L1 quantities distinct across JSON", () => {
    const checked = validateMarketEvent(JSON.parse(JSON.stringify(l1)));
    expect(checked.kind).toBe("L1_QUOTE");
    if (checked.kind !== "L1_QUOTE") throw new Error("Expected L1 quote");
    expect(checked.bidQty).toBe(0);
    expect(checked.askQty).toBeNull();
    expect(checked.bidQty).not.toBe(checked.askQty);
  });

  it("preserves a known zero SET and does not invent UNKNOWN quantity", () => {
    expect(validateMarketEvent({ ...update, qty: 0 })).toMatchObject({ qty: 0 });
    expect(() => validateMarketEvent({ ...update, qty: null })).toThrow();
    expect(() => validateMarketEvent({ ...update, qty: "UNKNOWN" })).toThrow();
    expect(validateDataQualityInterval({ ...quality, status: "NOT_INITIALIZED" }))
      .toMatchObject({ status: "NOT_INITIALIZED" });
  });
});

describe("R01 quantity and tick validation", () => {
  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    "40", null, undefined])("rejects invalid quantity %s in every lane", (qty) => {
    expect(() => restingQuantity(qty)).toThrow();
    expect(() => executedVolume(qty)).toThrow();
    expect(() => validateMarketEvent({ ...update, qty })).toThrow();
    expect(() => validateMarketEvent({ ...trade, qty })).toThrow();
    expect(() => validateMarketEvent({ ...snapshot, bids: [{ priceTicks: 80000, qty }] })).toThrow();
    // null is specifically allowed in L1 to denote unknown, never coerced to zero.
    if (qty !== null) expect(() => validateMarketEvent({ ...l1, askQty: qty })).toThrow();
  });

  it.each([80000.25, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    "80000", null, undefined])("rejects invalid Tick %s in every lane", (priceTicks) => {
    expect(() => validateMarketEvent({ ...update, priceTicks })).toThrow();
    expect(() => validateMarketEvent({ ...trade, priceTicks })).toThrow();
    expect(() => validateMarketEvent({
      ...snapshot, asks: [{ priceTicks, qty: 0 }],
    })).toThrow();
    if (priceTicks !== null) {
      expect(() => validateMarketEvent({ ...l1, bestBidTick: priceTicks })).toThrow();
    }
  });

  it("accepts negative integer ticks without confusing them with negative quantities", () => {
    expect(validateMarketEvent({ ...update, priceTicks: -1 })).toMatchObject({ priceTicks: -1 });
  });

  it("requires DELETE to already contain zero rather than silently normalizing", () => {
    expect(() => validateMarketEvent({ ...update, kind: "L2_DELETE_LEVEL", qty: 60 })).toThrow();
    expect(validateMarketEvent({ ...update, kind: "L2_DELETE_LEVEL", qty: 0 }))
      .toMatchObject({ qty: 0 });
  });
});

describe("R01 header and nanosecond precision", () => {
  it("retains adjacent nanoseconds beyond Number precision through JSON", () => {
    const event = {
      ...trade, header: { ...trade.header,
        exchangeTimeNs: "1767261600300000001", receiveTimeNs: "1767261600300000002",
        sequence: "900719925474099312345" },
    };
    const checked = validateMarketEvent(JSON.parse(JSON.stringify(event)));
    expect(checked.header.exchangeTimeNs).toBe("1767261600300000001");
    expect(checked.header.receiveTimeNs).toBe("1767261600300000002");
    expect(BigInt(checked.header.receiveTimeNs) - BigInt(checked.header.exchangeTimeNs!)).toBe(1n);
    expect(checked.header.sequence).toBe("900719925474099312345");
  });

  it.each([1767261600300000000, 1n, "1.5", "1e18", "", " 123 ", "not-a-time"])(
    "rejects non-decimal-string nanoseconds %s",
    (time) => {
      expect(() => validateEventHeader({ ...trade.header, exchangeTimeNs: time })).toThrow();
      expect(() => validateEventHeader({ ...trade.header, receiveTimeNs: time })).toThrow();
    },
  );

  it("allows absent exchange time and sequence without inventing values", () => {
    const header = { ...trade.header, exchangeTimeNs: null, sourceTimePrecision: "unknown",
      sequence: null, sequenceScope: "NONE", quality: "SUSPECT" };
    expect(validateEventHeader(header)).toEqual(header);
    expect(() => validateEventHeader({ ...header, receiveTimeNs: null })).toThrow();
  });

  it.each([
    { schemaVersion: 2 }, { eventId: "" }, { sourceId: "" }, { sessionId: "" },
    { canonicalInstrumentId: "NQ" }, { canonicalInstrumentId: "CME:NQ:2026-13" },
    { canonicalInstrumentId: "CME:NQ:continuous" }, { channel: "ORDER" },
    { sequence: 1 }, { sequence: "-1" }, { sequence: "1.5" },
    { sequenceScope: "NONE", sequence: "1" }, { sequenceScope: "UNKNOWN" },
    { sourceTimePrecision: "seconds" }, { quality: "UNKNOWN" },
    { environment: "PRODUCTION" }, { source: "OFFICIAL" },
  ])("rejects malformed header %j", (patch) => {
    expect(() => validateEventHeader({ ...trade.header, ...patch })).toThrow();
  });

  it("distinguishes MOCK, LIVE and saved replay without connecting to a source", () => {
    const mock = validateEventHeader(trade.header);
    const live = validateEventHeader({
      ...trade.header, environment: "LIVE", source: "VENDOR_UNVERIFIED",
      sourceId: "UNVERIFIED-TEST-ONLY",
    });
    expect(mock.environment).toBe("MOCK");
    expect(live.environment).toBe("LIVE");
    expect(live.source).toBe("VENDOR_UNVERIFIED");
    expect(validateEventHeader({
      ...mock, environment: "REPLAY_FROM_SAVED_DATA",
    }).source).toBe("MOCK_DETERMINISTIC");
    expect(() => validateEventHeader({ ...mock, environment: "LIVE" })).toThrow();
    expect(() => validateEventHeader({ ...live, environment: "MOCK" })).toThrow();
  });

  it("keeps different contract months as distinct identifiers", () => {
    const march = validateEventHeader(trade.header);
    const june = validateEventHeader({ ...trade.header, canonicalInstrumentId: "CME:NQ:2026-06" });
    expect(march.canonicalInstrumentId).not.toBe(june.canonicalInstrumentId);
  });
});

describe("R01 payload and quality validation", () => {
  it.each([null, undefined, [], 0, "TRADE", {}, { ...trade, header: null },
    { ...trade, kind: "ORDER" }, { ...trade, tradeId: "" },
    { ...trade, aggressor: "BID" }, { ...trade, classification: "GUESSED" },
    { ...trade, originalTradeId: "" }, { ...update, side: "BUY" },
    { ...update, updateBatchId: "" }, { ...snapshot, bids: null },
    { ...snapshot, asks: [null] }, { ...snapshot, snapshotCoversSequence: 1 },
    { ...snapshot, impliedPolicy: "ASSUMED" }, { ...snapshot, depthScope: { type: "UNKNOWN" } },
    { ...snapshot, depthScope: { type: "TOP_N", n: 0 } },
    { ...snapshot, depthScope: { type: "TOP_N", n: 1.5 } },
    { ...snapshot, depthScope: { type: "PRICE_RANGE", minTick: 1, maxTick: 0 } },
    { ...snapshot, depthScope: { type: "PRICE_RANGE", minTick: 0.1, maxTick: 1 } },
    { ...l1, header: { ...l1.header, channel: "TRADES" } },
    { ...snapshot, header: { ...snapshot.header, channel: "L1" } },
    { ...update, header: { ...update.header, channel: "TRADES" } },
    { ...trade, header: { ...trade.header, channel: "L2_MBP" } },
  ])("rejects malformed payload %#", (event) => {
    expect(() => validateMarketEvent(event)).toThrow();
  });

  it.each(["VALID", "NOT_INITIALIZED", "GAP", "STALE", "CLOSED", "OUTSIDE_DEPTH"])(
    "accepts explicit quality status %s", (status) => {
      expect(validateDataQualityInterval({ ...quality, status })).toMatchObject({ status });
    },
  );

  it("accepts an open-ended quality interval", () => {
    expect(validateDataQualityInterval({ ...quality, endNs: null })).toMatchObject({ endNs: null });
  });

  it.each([
    { startNs: 1 }, { endNs: 2 }, { endNs: "1767225600000000001" },
    { endNs: "1767225600000000000" }, { status: "ZERO" },
    { reason: "" }, { channel: "MBO" }, { evidence: 1 },
  ])("rejects invalid quality interval %j", (patch) => {
    expect(() => validateDataQualityInterval({ ...quality, ...patch })).toThrow();
  });
});

describe("R01 permanent deterministic fixtures (no calculation engine)", () => {
  it("fixes F-01 to five events at 0,1,3,5,8 seconds with quantities 40,80,0,60,0", () => {
    expect(F01_BOOK.events).toHaveLength(5);
    expect(F01_BOOK.events.map((e) => e.kind)).toEqual([
      "L2_SNAPSHOT", "L2_SET_LEVEL", "L2_DELETE_LEVEL", "L2_SET_LEVEL", "L2_DELETE_LEVEL",
    ]);
    expect(F01_BOOK.events.map((e) => e.header.exchangeTimeNs)).toEqual([
      "1767225600000000000", "1767225601000000000", "1767225603000000000",
      "1767225605000000000", "1767225608000000000",
    ]);
    expect(F01_BOOK.events.map((e) => e.kind === "L2_SNAPSHOT" ? e.bids[0].qty : e.qty))
      .toEqual([40, 80, 0, 60, 0]);
    expect(F01_BOOK.events.map((e) => e.header.sequence)).toEqual(["1", "2", "3", "4", "5"]);
    expect(F01_BOOK.events.map((e) => e.header.eventId)).toEqual([
      "MOCK-F-01-1", "MOCK-F-01-2", "MOCK-F-01-3", "MOCK-F-01-4", "MOCK-F-01-5",
    ]);
    expect(F01_BOOK.events[0].bids[0].priceTicks).toBe(80000);
    expect(F01_BOOK.events[0].depthScope).toEqual({
      type: "PRICE_RANGE", minTick: 80000, maxTick: 80000,
    });
    expect(F01_BOOK.events.slice(1).map((e) => "side" in e ? e.side : null))
      .toEqual(["BID", "BID", "BID", "BID"]);
    expect(F01_BOOK.expected).toEqual({
      startNs: "1767225600000000000", endNs: "1767225610000000000", eventCount: 5,
      timeWeightedAverage: 38, twoSecondAverages: [60, 40, 30, 60, 0], coverageRatio: 1,
    });
  });

  it("fixes F-04 to BUY12, SELL4, BUY11 at .300,.800,1.700 seconds", () => {
    expect(F04_TRADES.events).toHaveLength(3);
    expect(F04_TRADES.events.map((e) => [e.kind, e.aggressor, e.qty, e.priceTicks]))
      .toEqual([["TRADE", "BUY", 12, 80000], ["TRADE", "SELL", 4, 80000], ["TRADE", "BUY", 11, 80000]]);
    expect(F04_TRADES.events.map((e) => e.header.exchangeTimeNs)).toEqual([
      "1767261600300000000", "1767261600800000000", "1767261601700000000",
    ]);
    expect(F04_TRADES.events.map((e) => e.header.sequence)).toEqual(["1", "2", "3"]);
    expect(F04_TRADES.events.map((e) => e.tradeId)).toEqual(["MOCK-TRADE-1", "MOCK-TRADE-2", "MOCK-TRADE-3"]);
    expect(F04_TRADES.expected).toEqual({
      startNs: "1767261600000000000", endNs: "1767261602000000000", eventCount: 3,
      buy: 23, sell: 4, totalVolume: 27, delta: 19, imbalancePercent: 70.37037037037037,
    });
  });

  it.each([F01_BOOK, F04_TRADES])("retains MOCK metadata and JSON event order for $fixtureId", (fixture) => {
    expect(fixture.environment).toBe("MOCK");
    expect(fixture.seed).toBe(fixture.fixtureId === "F-01" ? 1 : 4);
    expect(fixture.expectedResultSchemaVersion).toBe(1);
    const loaded = JSON.parse(JSON.stringify(fixture));
    expect(loaded).toEqual(fixture);
    for (const event of loaded.events) {
      const checked = validateMarketEvent(event);
      expect(checked.header.environment).toBe("MOCK");
      expect(checked.header.source).toBe("MOCK_DETERMINISTIC");
      expect(checked.header.sourceId).toBe("MOCK");
      expect(checked.header.canonicalInstrumentId).toBe("CME:NQ:2026-03");
    }
  });
});
