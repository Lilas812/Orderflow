import { describe, expect, it } from "vitest";
import {
  F04_TRADES, F05_TRADES, F08_DUPLICATE_TRADES, F09_UNKNOWN_TRADES, F10_TRADE_BOUNDARY,
} from "../../fixtures/src/index";
import { executedVolume, type Trade, type DataQualityInterval } from "./events";
import { priceToTicks } from "./instrument";
import { priceBinId } from "./priceBins";
import { createBubbleFinality, ingestBubbleTrade } from "./bubbleFinality";
import { createTradeStore, ingestTrade, withTradeQuality, type TradeStore } from "./tradeStore";
import {
  aggregateTradeBucket, aggregateTrades, DEFAULT_BUBBLE_FILTERS, evaluateBubbleFilter,
  tradeTimeBinId, validateBubbleFilters, type BubbleFilters,
} from "./bubbleAggregate";

const first = F04_TRADES.events[0], startNs = "1767261600000000000", endNs = "1767261602000000000";
const firstTimeNs = first.header.exchangeTimeNs!;
const coverage: DataQualityInterval = { channel: "TRADES", startNs, endNs, status: "VALID",
  reason: "F04 MOCK continuity declared in fixture notes, not inferred from event count" };
function load(events: readonly Trade[], quality: readonly DataQualityInterval[] = [coverage]): TradeStore {
  let store = withTradeQuality(createTradeStore(events[0]?.header ?? first.header), quality);
  for (const event of events) store = ingestTrade(store, event).store;
  return store;
}
function trade(id: string, qty: number, aggressor: Trade["aggressor"] = "BUY",
  ns: string = firstTimeNs, tick = 80000): Trade {
  return { ...first, tradeId: id, qty: executedVolume(qty), aggressor, priceTicks: tick,
    classification: aggressor === "UNKNOWN" ? "UNKNOWN" : "VENUE",
    header: { ...first.header, eventId: id, exchangeTimeNs: ns } };
}
const bucket = (events: readonly Trade[]) => aggregateTradeBucket(load(events), startNs, 80000);
const allOff: BubbleFilters = {
  volume: { enabled: false, minimum: 15 }, absoluteDelta: { enabled: false, minimum: 10 },
  imbalancePercent: { enabled: false, minimum: 40 },
};
const only = (key: keyof BubbleFilters, minimum: number): BubbleFilters =>
  ({ ...allOff, [key]: { enabled: true, minimum } });
const serialize = (x: unknown) => JSON.stringify(x);
// Tests run in Vitest's Node environment; production core remains ES2022-only.
declare const console: { log(message: string): void; table(rows: unknown): void };

describe("R08 fixed numeric oracles", () => {
  it("F04: B23 S4 U0 V27 Delta19, not a count of board orders", () => {
    const b = bucket(F04_TRADES.events);
    expect([b.B, b.S, b.U, b.V_raw, b.V, b.delta]).toEqual([23n, 4n, 0n, 27n, 27n, 19n]);
    expect(b.imbalancePercent).toBeCloseTo(F04_TRADES.expected.imbalancePercent, 12);
    expect(b.status).toBe("COMPLETE");
    expect(b.quality).toEqual([]);
    expect(evaluateBubbleFilter(b)).toEqual({
      eligible: true, volume: true, absoluteDelta: true, imbalancePercent: true, pass: true,
    });
  });
  it("F05: volume26 passes, absDelta2 and 7.692308% do not", () => {
    const b = aggregateTrades(load(F05_TRADES.events, F05_TRADES.quality))[0];
    expect([b.B, b.S, b.U, b.V_raw, b.V, b.delta]).toEqual([12n, 14n, 0n, 26n, 26n, -2n]);
    expect(b.imbalancePercent).toBeCloseTo(F05_TRADES.expected.imbalancePercent, 12);
    expect(evaluateBubbleFilter(b)).toEqual({
      eligible: true, volume: true, absoluteDelta: false, imbalancePercent: false, pass: false,
    });
  });
  it("F08: duplicate raw count2, unique volume12 not24", () => {
    const store = load(F08_DUPLICATE_TRADES.events, F08_DUPLICATE_TRADES.quality);
    const b = aggregateTrades(store)[0];
    expect(store.rawEvents).toHaveLength(2);
    expect(b.tradeIds).toHaveLength(1);
    expect([b.B, b.S, b.V_raw, b.V, b.delta]).toEqual([12n, 0n, 12n, 12n, 12n]);
    expect(b.imbalancePercent).toBe(100);
    expect(evaluateBubbleFilter(b).pass).toBe(false);
  });
  it("F09: U5 and V_raw32, exact V/Delta/bias remain null even with every filter OFF", () => {
    const b = aggregateTrades(load(F09_UNKNOWN_TRADES.events, F09_UNKNOWN_TRADES.quality))[0];
    expect([b.B, b.S, b.U, b.V_raw]).toEqual([23n, 4n, 5n, 32n]);
    expect([b.V, b.delta, b.imbalancePercent]).toEqual([null, null, null]);
    expect(b.status).toBe("INCOMPLETE");
    expect(b.quality).toContain("INCOMPLETE_CLASSIFICATION");
    expect(evaluateBubbleFilter(b, allOff).pass).toBe(false);
  });
  it("F10: 1ns before/on/after the boundary, separate price buckets, no double count", () => {
    const bs = aggregateTrades(load(F10_TRADE_BOUNDARY.events, F10_TRADE_BOUNDARY.quality));
    expect(bs).toHaveLength(3);
    for (const [i, b] of bs.entries()) {
      const e = F10_TRADE_BOUNDARY.expected.buckets[i];
      expect([b.startNs, b.endNs, b.minTick, b.maxTick]).toEqual([e.startNs, e.endNs, e.minTick, e.maxTick]);
      expect([b.B, b.S, b.U, b.V_raw, b.V, b.delta]).toEqual(
        [e.buy, e.sell, e.unknown, e.rawVolume, e.totalVolume, e.delta].map(BigInt));
      expect(b.imbalancePercent).toBe(e.imbalancePercent);
      expect(evaluateBubbleFilter(b).pass).toBe(e.pass);
    }
    expect(bs.map((b) => b.tradeIds)).toEqual([
      ["MOCK-F10-T1", "MOCK-F10-T2", "MOCK-F10-T3"], ["MOCK-F10-T4"], ["MOCK-F10-T5"],
    ]);
  });
  it("prints deterministic EXPECTED and ACTUAL bucket tables for manual inspection", () => {
    const cases = [
      { fixtureId: "F04", events: F04_TRADES.events, quality: [coverage], expected: [{
        startNs, endNs, minTick: 80000, maxTick: 80001, buy: 23, sell: 4, unknown: 0,
        rawVolume: 27, totalVolume: 27, delta: 19, imbalancePercent: 70.37037037037037,
        quality: "COMPLETE", filters: { volume: true, absoluteDelta: true, imbalancePercent: true }, pass: true,
      }] },
      ...[F05_TRADES, F08_DUPLICATE_TRADES, F09_UNKNOWN_TRADES].map((f) => ({
        ...f, expected: [{ ...f.expected, startNs: f.quality[0].startNs,
          endNs: f.quality[0].endNs, minTick: 80000, maxTick: 80001 }],
      })),
      { ...F10_TRADE_BOUNDARY, expected: F10_TRADE_BOUNDARY.expected.buckets },
    ];
    const rows: Record<string, string | number | boolean | null>[] = [];
    for (const fixture of cases) {
      const store = load(fixture.events, fixture.quality), bs = aggregateTrades(store);
      expect(bs).toHaveLength(fixture.expected.length);
      expect(store.rawEvents).toHaveLength(fixture.events.length);
      for (const [i, b] of bs.entries()) {
        const e = fixture.expected[i], check = evaluateBubbleFilter(b);
        expect([b.B, b.S, b.U, b.V_raw]).toEqual([e.buy, e.sell, e.unknown, e.rawVolume].map(BigInt));
        expect(b.V).toBe(e.totalVolume === null ? null : BigInt(e.totalVolume));
        expect(b.delta).toBe(e.delta === null ? null : BigInt(e.delta));
        expect(check.pass).toBe(e.pass);
        const quality = b.status === "COMPLETE" ? "COMPLETE" : b.quality.join(",");
        expect(quality).toBe(e.quality);
        expect([check.volume, check.absoluteDelta, check.imbalancePercent]).toEqual([
          e.filters.volume, e.filters.absoluteDelta, e.filters.imbalancePercent,
        ]);
        for (const kind of ["EXPECTED", "ACTUAL"] as const) rows.push({
          fixture: fixture.fixtureId, kind, interval: `[${b.startNs},${b.endNs})`,
          ticks: `${b.minTick}..${b.maxTick}`,
          B: String(kind === "EXPECTED" ? e.buy : b.B), S: String(kind === "EXPECTED" ? e.sell : b.S),
          U: String(kind === "EXPECTED" ? e.unknown : b.U),
          V_raw: String(kind === "EXPECTED" ? e.rawVolume : b.V_raw),
          V: kind === "EXPECTED" ? e.totalVolume : b.V === null ? null : String(b.V),
          Delta: kind === "EXPECTED" ? e.delta : b.delta === null ? null : String(b.delta),
          bias: kind === "EXPECTED" ? e.imbalancePercent : b.imbalancePercent,
          quality: kind === "EXPECTED" ? e.quality : quality,
          volume: kind === "EXPECTED" ? e.filters.volume : check.volume,
          absDelta: kind === "EXPECTED" ? e.filters.absoluteDelta : check.absoluteDelta,
          biasPass: kind === "EXPECTED" ? e.filters.imbalancePercent : check.imbalancePercent,
          pass: kind === "EXPECTED" ? e.pass : check.pass,
        });
      }
    }
    console.log("R08 MOCK bucket audit — UTC ns, [start,end), observed V_raw; no FINAL/watermark claim");
    console.table(rows);
  });
});

describe("R08 exact epoch/time/price partitioning", () => {
  it.each([
    ["1767261600000000000", "883630800"], ["1767261601999000000", "883630800"],
    ["1767261601999999999", "883630800"], ["1767261602000000000", "883630801"],
    ["1767261602000000001", "883630801"], ["0", "0"], ["1999999999", "0"], ["2000000000", "1"],
  ])("time %s -> epoch bucket %s", (ns, id) => {
    expect(tradeTimeBinId(ns)).toBe(id);
  });
  it("epoch alignment is not anchored to the first arriving trade", () => {
    const b = bucket([trade("late-first", 12, "BUY", "1767261601700000000")]);
    expect([b.startNs, b.endNs]).toEqual([startNs, endNs]);
  });
  it.each(["01", "-1", "1.1", "1e9", "", " 1"])("rejects noncanonical time %s", (ns) => {
    expect(() => tradeTimeBinId(ns)).toThrow();
  });
  it("80000 and 80001 share a bucket, 80002 does not", () => {
    const bs = aggregateTrades(load([trade("a", 1), trade("b", 2, "BUY", firstTimeNs, 80001),
      trade("c", 4, "BUY", firstTimeNs, 80002)]));
    expect(bs.map((b) => [b.minTick, b.maxTick, b.V])).toEqual([[80000, 80001, 3n], [80002, 80003, 4n]]);
  });
  it("negative Tick grouping uses floor rather than truncation", () => {
    const b = aggregateTrades(load([trade("negative", 1, "BUY", firstTimeNs, -1)]))[0];
    expect([b.priceBinId, b.minTick, b.maxTick]).toEqual([-1, -2, -1]);
  });
  it("rejects unsafe price-bin boundaries instead of rounding", () => {
    expect(() => aggregateTradeBucket(load([]), startNs, Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(() => aggregateTradeBucket(load([]), startNs, -Number.MAX_SAFE_INTEGER)).toThrow(/boundaries/);
  });
  it("non-Tick NQ point price is rejected by the existing converter", () => {
    expect(() => priceToTicks(20000.10)).toThrow();
  });
  it("same-timestamp distinct IDs contribute independently", () => {
    const b = bucket([trade("a", 12), trade("b", 11)]);
    expect(b.V).toBe(23n);
    expect(b.tradeIds).toEqual(["a", "b"]);
  });
  it("sorting output does not silently reorder raw deliveries", () => {
    const events = [...F10_TRADE_BOUNDARY.events].reverse(), before = serialize(events);
    const store = load(events, F10_TRADE_BOUNDARY.quality), bs = aggregateTrades(store);
    expect(bs[0].startNs).toBe(startNs);
    expect(store.rawEvents.map((t) => t.tradeId)).toEqual(events.map((t) => t.tradeId));
    expect(serialize(events)).toBe(before);
  });
  it.each([
    { canonicalInstrumentId: "CME:NQ:2026-06" }, { sourceId: "OTHER" }, { sessionId: "OTHER" },
  ])("same trade ID in another identity remains separate: %j", (header) => {
    const e = { ...first, header: { ...first.header, ...header } };
    const a = aggregateTrades(load([first]))[0], b = aggregateTrades(load([e]))[0];
    expect(a.scope).not.toEqual(b.scope);
    expect([a.V, b.V]).toEqual([12n, 12n]);
  });
});

describe("R08 classification, completeness and safe integers", () => {
  it.each([["BUY", 27n], ["SELL", -27n]] as const)("all %s gives bias100%%", (side, delta) => {
    const b = bucket([trade("one", 27, side)]);
    expect(b.V).toBe(27n); expect(b.delta).toBe(delta); expect(b.imbalancePercent).toBe(100);
  });
  it("equal buy and sell has valid zero Delta and zero bias", () => {
    const b = bucket([trade("b", 12), trade("s", 12, "SELL")]);
    expect([b.V, b.delta, b.imbalancePercent]).toEqual([24n, 0n, 0]);
    expect(evaluateBubbleFilter(b).pass).toBe(false);
    expect(evaluateBubbleFilter(b, allOff).pass).toBe(true);
  });
  it("V=0 has null bias and is ineligible even with all filters OFF", () => {
    const b = bucket([trade("zero", 0)]);
    expect([b.V, b.delta, b.imbalancePercent]).toEqual([0n, 0n, null]);
    expect(evaluateBubbleFilter(b, allOff).pass).toBe(false);
    expect(evaluateBubbleFilter(aggregateTradeBucket(load([]), startNs, 80000), allOff).pass).toBe(false);
  });
  it("does not infer BUY/SELL from rising UNKNOWN prices", () => {
    const b = bucket([trade("u1", 3, "UNKNOWN"), trade("u2", 4, "UNKNOWN", firstTimeNs, 80001)]);
    expect([b.B, b.S, b.U, b.V_raw]).toEqual([0n, 0n, 7n, 7n]);
    expect(b.delta).toBeNull();
  });
  it("unknown classification provenance invalidates Delta despite a supplied direction", () => {
    const b = bucket([{ ...first, classification: "UNKNOWN" }]);
    expect([b.B, b.S, b.U, b.V_raw]).toEqual([12n, 0n, 0n, 12n]);
    expect(b.V).toBeNull(); expect(b.delta).toBeNull();
    expect(b.quality).toContain("INCOMPLETE_CLASSIFICATION");
  });
  it("a zero-size UNKNOWN still is not silently claimed fully classified", () => {
    const b = bucket([first, trade("u0", 0, "UNKNOWN")]);
    expect(b.U).toBe(0n); expect(b.status).toBe("INCOMPLETE");
  });
  it("one UNKNOWN invalidates only its own time/price bucket", () => {
    const store = load([first, trade("u", 3, "UNKNOWN", firstTimeNs, 80002)]);
    const bs = aggregateTrades(store);
    expect(bs.map((b) => b.status)).toEqual(["COMPLETE", "INCOMPLETE"]);
  });
  it("sums above MAX_SAFE_INTEGER exactly using BigInt", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const b = bucket([trade("a", max), trade("b", max)]);
    expect([b.B, b.V_raw, b.V, b.delta]).toEqual(Array(4).fill(18_014_398_509_481_982n));
    expect(b.imbalancePercent).toBe(100);
    expect(evaluateBubbleFilter(b).pass).toBe(true);
  });
  it("retains a one-unit Delta at totals beyond safe Number precision", () => {
    const b = bucket([trade("b", 4_503_599_627_370_497), trade("s", 4_503_599_627_370_496, "SELL")]);
    expect(b.V).toBe(9_007_199_254_740_993n); expect(b.delta).toBe(1n);
    // Number(V) would round down and falsely pass this threshold.
    expect(evaluateBubbleFilter(b, only("imbalancePercent", 1.1102230246251565e-14)).pass).toBe(false);
    expect(evaluateBubbleFilter(b, only("imbalancePercent", 1e-14)).pass).toBe(true);
  });
});

describe("R08 Trade gap/revision/conflict safety", () => {
  it("never infers full observation from a list of VALID events", () => {
    const b = aggregateTradeBucket(load(F04_TRADES.events, []), startNs, 80000);
    expect(b.V_raw).toBe(27n); expect(b.V).toBeNull();
    expect(b.quality).toContain("NO_TRADE_COVERAGE");
  });
  it("a 1ns GAP anywhere inside the bucket invalidates exact quantities", () => {
    const q: DataQualityInterval[] = [
      { ...coverage, endNs: "1767261601000000000" },
      { ...coverage, startNs: "1767261601000000000", endNs: "1767261601000000001", status: "GAP" },
      { ...coverage, startNs: "1767261601000000001" },
    ];
    const b = aggregateTrades(load(F04_TRADES.events, q))[0];
    expect([b.B, b.S, b.V_raw, b.V, b.delta, b.imbalancePercent]).toEqual([23n, 4n, 27n, null, null, null]);
    expect(b.quality).toContain("TRADE_GAP");
    expect(evaluateBubbleFilter(b, allOff).pass).toBe(false);
  });
  it("GAP touching only the excluded end does not contaminate the previous bucket", () => {
    const q: DataQualityInterval[] = [coverage, { ...coverage, startNs: endNs,
      endNs: "1767261604000000000", status: "GAP" }];
    const store = load(F04_TRADES.events, q);
    expect(aggregateTrades(store)[0].status).toBe("COMPLETE");
    const missing = aggregateTradeBucket(store, endNs, 80000);
    expect(missing.V_raw).toBe(0n); expect(missing.V).toBeNull();
    expect(missing.quality).toContain("TRADE_GAP");
  });
  it("GAP ending at the included start does not contaminate recovered coverage", () => {
    const q: DataQualityInterval[] = [{ ...coverage, startNs: "1767261598000000000",
      endNs: startNs, status: "GAP" }, coverage];
    expect(aggregateTrades(load(F04_TRADES.events, q))[0].status).toBe("COMPLETE");
  });
  it("a hole between VALID intervals remains unobserved", () => {
    const q = [{ ...coverage, endNs: "1767261601000000000" },
      { ...coverage, startNs: "1767261601000000001" }];
    expect(aggregateTrades(load(F04_TRADES.events, q))[0].quality).toContain("NO_TRADE_COVERAGE");
  });
  it.each(["SUSPECT", "GAP"] as const)("event header %s overrides supplied VALID coverage", (quality) => {
    const b = bucket([{ ...first, header: { ...first.header, quality } }]);
    expect(b.status).toBe("INCOMPLETE");
    expect(b.quality).toContain(quality === "GAP" ? "TRADE_GAP" : "TRADE_QUALITY");
  });
  it.each(["STALE", "NOT_INITIALIZED", "CLOSED", "OUTSIDE_DEPTH"] as const)(
    "non-VALID Trade observation %s is not a zero-filled bucket", (status) => {
      const b = aggregateTrades(load(F04_TRADES.events, [{ ...coverage, status }]))[0];
      expect(b.V).toBeNull(); expect(b.quality).toContain("TRADE_QUALITY");
    });
  it("UNKNOWN and Trade GAP are both retained rather than masking each other", () => {
    const b = aggregateTrades(load(F09_UNKNOWN_TRADES.events,
      [{ ...coverage, status: "GAP" }]))[0];
    expect(b.quality).toEqual(expect.arrayContaining(["TRADE_GAP", "INCOMPLETE_CLASSIFICATION"]));
  });
  it.each(["TRADE_CORRECTION", "TRADE_CANCEL"] as const)(
    "unsupported %s is audited, not added or subtracted; whole scope is incomplete", (kind) => {
      let store = load(F04_TRADES.events);
      store = ingestTrade(store, { ...first, kind, originalTradeId: first.tradeId,
        tradeId: "revision", qty: executedVolume(999),
        header: { ...first.header, exchangeTimeNs: "1767261605000000000", eventId: "revision" } }).store;
      const b = aggregateTrades(store)[0];
      expect([b.B, b.S, b.V_raw]).toEqual([23n, 4n, 27n]);
      expect([b.V, b.delta, b.imbalancePercent]).toEqual([null, null, null]);
      expect(b.quality).toContain("UNSUPPORTED_REVISION");
      expect(evaluateBubbleFilter(b, allOff).pass).toBe(false);
      expect(store.rawEvents).toHaveLength(4);
    });
  it("unmatched revision without trades is not an executable bubble", () => {
    const store = load([{ ...first, kind: "TRADE_CANCEL", originalTradeId: "unknown" }]);
    expect(aggregateTrades(store)).toEqual([]);
    expect(aggregateTradeBucket(store, startNs, 80000).quality).toContain("UNSUPPORTED_REVISION");
  });
  it("conflicting IDs invalidate results; first trade remains diagnostic only", () => {
    const store = load([first, { ...first, qty: executedVolume(100) }]);
    const b = aggregateTrades(store)[0];
    expect(b.V_raw).toBe(12n); expect(b.V).toBeNull(); expect(b.delta).toBeNull();
    expect(b.quality).toContain("CONFLICTING_TRADE_ID");
    expect(evaluateBubbleFilter(b, allOff).pass).toBe(false);
  });
});

describe("R08 independently switchable inclusive AND filters", () => {
  it("defaults are 15 volume, 10 absolute Delta, 40 percent, all ON", () => {
    expect(DEFAULT_BUBBLE_FILTERS).toEqual({ volume: { enabled: true, minimum: 15 },
      absoluteDelta: { enabled: true, minimum: 10 }, imbalancePercent: { enabled: true, minimum: 40 } });
  });
  it.each(Array.from({ length: 8 }, (_, mask) => [mask] as const))("F05 ON/OFF combination %i", (mask) => {
    const b = aggregateTrades(load(F05_TRADES.events, F05_TRADES.quality))[0];
    const f = { volume: { enabled: !!(mask & 1), minimum: 15 },
      absoluteDelta: { enabled: !!(mask & 2), minimum: 10 },
      imbalancePercent: { enabled: !!(mask & 4), minimum: 40 } };
    expect(evaluateBubbleFilter(b, f).pass).toBe(!(mask & 2) && !(mask & 4));
  });
  it.each([
    ["volume", 27, true], ["volume", 27.1, false], ["volume", 26.9, true],
    ["absoluteDelta", 19, true], ["absoluteDelta", 19.1, false], ["absoluteDelta", 18.9, true],
    ["imbalancePercent", 70.37037037037037, true],
    ["imbalancePercent", 70.37037037037038, false],
  ] as const)("inclusive and sub-unit boundary %s >= %s -> %s", (key, threshold, pass) => {
    expect(evaluateBubbleFilter(bucket(F04_TRADES.events), only(key, threshold)).pass).toBe(pass);
  });
  it.each([["BUY", 21, 9], ["SELL", 9, 21]] as const)("40%% exactly, sign %s", (_, buy, sell) => {
    const b = bucket([trade("b", buy), trade("s", sell, "SELL")]);
    expect(b.imbalancePercent).toBe(40);
    expect(evaluateBubbleFilter(b, only("imbalancePercent", 40)).pass).toBe(true);
    expect(evaluateBubbleFilter(b, only("imbalancePercent", 40.0001)).pass).toBe(false);
  });
  it("a negative Delta is compared by magnitude", () => {
    const b = bucket([trade("s", 15, "SELL")]);
    expect(b.delta).toBe(-15n); expect(evaluateBubbleFilter(b).pass).toBe(true);
  });
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects quantity threshold %s", (minimum) => {
    expect(() => validateBubbleFilters(only("volume", minimum))).toThrow();
    expect(() => validateBubbleFilters(only("absoluteDelta", minimum))).toThrow();
  });
  it.each([-1, 100.001, NaN, Infinity])("rejects percent threshold %s", (minimum) => {
    expect(() => validateBubbleFilters(only("imbalancePercent", minimum))).toThrow();
  });
  it("invalid settings are rejected even when that filter is OFF", () => {
    expect(() => validateBubbleFilters({ ...allOff, volume: { enabled: false, minimum: NaN } })).toThrow();
  });
  it("rejects nonboolean flags and missing filter records", () => {
    expect(() => validateBubbleFilters({ ...allOff, volume: { enabled: 1, minimum: 15 } } as never)).toThrow();
    expect(() => validateBubbleFilters({} as never)).toThrow();
  });
  it("threshold exponent notation compares correctly", () => {
    expect(evaluateBubbleFilter(bucket(F04_TRADES.events), only("absoluteDelta", 1e-7)).pass).toBe(true);
  });
  it("all filters and aggregation leave raw source events and store serialized bytes unchanged", () => {
    const fixtures = [F04_TRADES, F05_TRADES, F08_DUPLICATE_TRADES, F09_UNKNOWN_TRADES, F10_TRADE_BOUNDARY];
    const before = serialize(fixtures);
    const store = load(F04_TRADES.events), storeBefore = serialize(store);
    for (const volume of [0, 15, 100, 0]) for (const b of aggregateTrades(store)) {
      evaluateBubbleFilter(b, { ...DEFAULT_BUBBLE_FILTERS, volume: { enabled: true, minimum: volume } });
    }
    expect(serialize(fixtures)).toBe(before);
    expect(serialize(store)).toBe(storeBefore);
    expect(store.rawEvents).toHaveLength(3);
  });
});

describe("28-C1 grouped aggregation compatibility", () => {
  // The old outer traversal stays test-only. Its public single-bucket queries
  // provide the oracle; fixed numeric fixtures above remain independent goldens.
  function reference(store: TradeStore) {
    const keys = new Set<string>(), buckets = [];
    for (const t of store.trades) {
      const id = tradeTimeBinId(t.header.exchangeTimeNs!);
      const key = JSON.stringify([id, priceBinId(t.priceTicks, 2)]);
      if (!keys.has(key)) {
        keys.add(key);
        buckets.push(aggregateTradeBucket(store, t.header.exchangeTimeNs!, t.priceTicks));
      }
    }
    buckets.sort((a, b) => BigInt(a.startNs) < BigInt(b.startNs) ? -1 :
      BigInt(a.startNs) > BigInt(b.startNs) ? 1 : a.priceBinId - b.priceBinId);
    return buckets;
  }
  const fullCoverage = [{ ...coverage, endNs: (BigInt(startNs) + 10_000_000_000n).toString() }];

  it.each([F04_TRADES, F05_TRADES, F08_DUPLICATE_TRADES, F09_UNKNOWN_TRADES, F10_TRADE_BOUNDARY])(
    "matches single-bucket reference for $fixtureId without mixing scopes", fixture => {
      const store = load(fixture.events, "quality" in fixture ? fixture.quality : [coverage]);
      expect(aggregateTrades(store)).toEqual(reference(store));
    });

  it.each(Array.from({ length: 12 }, (_, seed) => seed))(
    "matches the reference across deterministic order/quality variations %i", seed => {
      const offsets = [0n, 1_999_999_999n, 2_000_000_000n, 2_000_000_001n, 3_999_999_999n, 4_000_000_000n];
      const ticks = [-3, -2, -1, 0, 1, 2, 79999, 80000, 80001, 80002];
      const sides = ["BUY", "SELL", "UNKNOWN"] as const;
      const events = Array.from({ length: 72 }, (_, i) => trade(`mixed-${i}`,
        i % 19 === 0 ? Number.MAX_SAFE_INTEGER : i % 11, sides[(i + seed) % 3],
        (BigInt(startNs) + offsets[(i * 5 + seed) % offsets.length]).toString(),
        ticks[(i * 7 + seed) % ticks.length]));
      const ordered = seed % 2 ? [...events].reverse() : [...events.slice(seed), ...events.slice(0, seed)];
      const quality: readonly DataQualityInterval[] = seed % 4 === 0 ? [] :
        seed % 4 === 1 ? [{ ...fullCoverage[0], status: "NOT_INITIALIZED" }] :
        seed % 4 === 2 ? [
          { ...coverage, endNs: (BigInt(startNs) + 1n).toString(), status: "GAP" },
          { ...fullCoverage[0], startNs: (BigInt(startNs) + 1n).toString() },
        ] : fullCoverage;
      const store = load([...ordered, ordered[0]], quality), before = serialize(store);
      const actual = aggregateTrades(store);
      expect(actual).toEqual(reference(store));
      expect(actual.map(b => evaluateBubbleFilter(b))).toEqual(reference(store).map(b => evaluateBubbleFilter(b)));
      expect(store.trades).toHaveLength(72);
      expect(serialize(store)).toBe(before);
    });

  it("pins inclusive starts, exclusive ends, price bins and within-bucket arrival order", () => {
    const on = endNs, before = (BigInt(on) - 1n).toString(), after = (BigInt(on) + 1n).toString();
    const store = load([trade("after", 3, "UNKNOWN", after, 80001),
      trade("before", 7, "BUY", before, 80001), trade("on", 2, "SELL", on, 80000),
      trade("other-price", 5, "BUY", on, 80002)], fullCoverage);
    const result = aggregateTrades(store);
    expect(result.map(b => [b.startNs, b.minTick, b.tradeIds, b.B, b.S, b.U])).toEqual([
      [startNs, 80000, ["before"], 7n, 0n, 0n],
      [endNs, 80000, ["after", "on"], 0n, 2n, 3n],
      [endNs, 80002, ["other-price"], 5n, 0n, 0n],
    ]);
    expect(result[1].quality).toEqual(["INCOMPLETE_CLASSIFICATION"]);
    expect(result).toEqual(reference(store));
  });

  it("keeps exact large BUY/SELL/UNKNOWN totals at the same timestamp", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const store = load([trade("b1", max), trade("b2", max), trade("s", max, "SELL"),
      trade("u", max, "UNKNOWN")]);
    const [b] = aggregateTrades(store);
    expect([b.B, b.S, b.U, b.V_raw, b.V, b.delta]).toEqual([
      18_014_398_509_481_982n, 9_007_199_254_740_991n, 9_007_199_254_740_991n,
      36_028_797_018_963_964n, null, null,
    ]);
    expect(b.tradeIds).toEqual(["b1", "b2", "s", "u"]);
    expect(aggregateTrades(store)).toEqual(reference(store));
  });

  it("returns only observed buckets and fresh frozen output without mutating the Store", () => {
    const empty = aggregateTrades(load([]));
    expect(empty).toEqual([]); expect(Object.isFrozen(empty)).toBe(true);
    const store = load(F04_TRADES.events), before = serialize(store), trades = store.trades;
    const a = aggregateTrades(store), b = aggregateTrades(store);
    expect(a).toEqual(b); expect(a).not.toBe(b);
    expect(a[0].scope).toBe(store.scope);
    for (const value of [a, a[0], a[0].tradeIds, a[0].quality]) expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(a[0].tradeIds, 0, "changed")).toBe(false);
    expect(store.trades).toBe(trades); expect(serialize(store)).toBe(before);
  });

  it("reads membership once and adds quantity once per Trade, independent of bucket count", () => {
    const store = load(Array.from({ length: 24 }, (_, i) =>
      trade(`once-${i}`, i + 1, i % 2 ? "SELL" : "BUY",
        (BigInt(startNs) + BigInt(i % 6) * 2_000_000_000n).toString(), 80000 + i * 2)));
    let times = 0, prices = 0, quantities = 0;
    const trades = store.trades.map(t => ({
      ...t,
      header: { ...t.header, get exchangeTimeNs() { times++; return t.header.exchangeTimeNs; } },
      get priceTicks() { prices++; return t.priceTicks; },
      get qty() { quantities++; return t.qty; },
    }));
    const result = aggregateTrades({ ...store, trades });
    expect(result).toHaveLength(24);
    expect([times, prices, quantities]).toEqual([24, 24, 24]);
  });

  it("preserves PROVISIONAL / FINAL / REVISED, sealed IDs and retransmission behavior", () => {
    let state = createBubbleFinality(first.header, fullCoverage);
    for (const t of F04_TRADES.events) state = ingestBubbleTrade(state, t);
    expect(state.bubbles[0]).toMatchObject({ status: "PROVISIONAL", finalized: false, revision: 0 });
    state = ingestBubbleTrade(state, trade("progress", 1, "BUY",
      (BigInt(startNs) + 5_000_000_000n).toString(), 80004));
    expect(state.bubbles[0]).toMatchObject({ status: "FINAL", finalized: true, revision: 0 });
    const late = trade("late-sell", 60, "SELL", (BigInt(endNs) - 1n).toString());
    state = ingestBubbleTrade(state, late);
    expect(state.bubbles[0]).toMatchObject({ status: "REVISED", finalized: true, revision: 1,
      bucket: { B: 23n, S: 64n, V: 87n, delta: -41n } });
    expect(state.bubbles[0].sealedTradeIds).toEqual(state.bubbles[0].bucket.tradeIds);
    const before = state.bubbles;
    state = ingestBubbleTrade(state, late);
    expect(state.bubbles).toEqual(before);
    expect(state.bubbles.map(b => b.bucket)).toEqual(reference(state.store));
  });

  const a = trade("valid-a", 1), b = trade("valid-b", 2, "SELL", endNs);
  const invalidInputs: readonly (readonly Trade[])[] = [
    [{ ...a, header: { ...a.header, exchangeTimeNs: "01" } }],
    [{ ...a, header: { ...a.header, exchangeTimeNs: null } }],
    [{ ...a, priceTicks: 0.5 }],
    [{ ...a, priceTicks: -Number.MAX_SAFE_INTEGER }],
    [{ ...a, qty: 0.5 as Trade["qty"] }],
    [{ ...a, priceTicks: -Number.MAX_SAFE_INTEGER },
      { ...b, header: { ...b.header, exchangeTimeNs: "bad-time" } }],
    [a, { ...b, priceTicks: NaN }, { ...a, header: { ...a.header, exchangeTimeNs: "-1" } }],
    [{ ...a, qty: 0.5 as Trade["qty"] }, { ...b, priceTicks: -Number.MAX_SAFE_INTEGER }],
  ];
  it.each(invalidInputs.map((trades, i) => ({ trades, i })))(
    "preserves original error constructor, message and precedence for invalid Store $i", ({ trades }) => {
      // Deliberately malformed public input, not accepted TradeStore ingestion.
      const store: TradeStore = { ...load([]), trades };
      const failure = (run: () => unknown) => {
        try { run(); return null; }
        catch (error) {
          if (!(error instanceof Error)) throw error;
          return { constructor: error.constructor, message: error.message };
        }
      };
      const expected = failure(() => reference(store));
      expect(expected).not.toBeNull();
      expect(failure(() => aggregateTrades(store))).toEqual(expected);
    });
});
