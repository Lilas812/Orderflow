import { describe, expect, it } from "vitest";
import { F01_BOOK, F04_TRADES } from "../../fixtures/src/index";
import { applyMbpBatch, applyMbpEvent, createMbpBook, readMbpLevel } from "./mbpBook";
import type { MbpBook, SnapshotSemantics } from "./mbpBook";
import { restingQuantity, type BookSide, type L2Snapshot } from "./events";

// The core targets pure ES2022 (no DOM/Node globals); only this test harness logs.
const diagnostic = (globalThis as unknown as {
  console: { info(message: string): void };
}).console;

const initial = F01_BOOK.events[0];
const set = F01_BOOK.events[1];
const zeroEvidence: SnapshotSemantics = {
  unlistedLevels: "ZERO",
  evidence: "MOCK test explicitly guarantees absent levels are zero within scope; not a vendor rule",
};

function snapshot(scope: L2Snapshot["depthScope"] = { type: "FULL" }): L2Snapshot {
  return {
    ...initial, depthScope: scope,
    bids: [
      { priceTicks: 80000, qty: restingQuantity(40) },
      { priceTicks: 79998, qty: restingQuantity(10) },
    ],
    asks: [
      { priceTicks: 80001, qty: restingQuantity(20) },
      { priceTicks: 80003, qty: restingQuantity(30) },
    ],
  };
}

function level(book: MbpBook, side: BookSide = "BID", tick = 80000) {
  return readMbpLevel(book, side, tick);
}

function values(book: MbpBook) {
  return { ...book, bids: [...book.bids], asks: [...book.asks] };
}

describe("R02 F-01 and F-06 delete/re-add (MOCK only)", () => {
  it("reconstructs 40 -> 80 -> 0 -> 60 -> 0 without altering the input or earlier states", () => {
    const rawBefore = JSON.stringify(F01_BOOK);
    let book = createMbpBook();
    const states: MbpBook[] = [];
    const observations = [];
    for (const event of F01_BOOK.events) {
      const previous = values(book);
      const next = applyMbpEvent(book, event);
      expect(values(book)).toEqual(previous);
      states.push(next);
      observations.push(level(next).qty);
      book = next;
    }
    expect(observations).toEqual([40, 80, 0, 60, 0]);
    expect(states.map((state) => level(state).qty)).toEqual([40, 80, 0, 60, 0]);
    expect(JSON.stringify(F01_BOOK)).toBe(rawBefore);
    diagnostic.info("MOCK F-01 @80000 Tick: t=0:40, t=1:80, t=3:0, t=5:60, t=8:0");
  });

  it.each([[4, 0], [6, 60], [9, 0]])("holds known quantity at t=%is: %i", (seconds, expected) => {
    // Test-only replay, not a history store or a time-weighted calculation.
    const targetNs = BigInt(F01_BOOK.expected.startNs) + BigInt(seconds) * 1_000_000_000n;
    let book = createMbpBook();
    for (const event of F01_BOOK.events) {
      if (BigInt(event.header.exchangeTimeNs!) <= targetNs) book = applyMbpEvent(book, event);
    }
    expect(level(book)).toEqual({ status: "KNOWN", qty: expected });
    diagnostic.info(`MOCK F-01 t=${seconds}s @80000 Tick: ${level(book).qty}`);
  });

  it("F-06: re-adds after DELETE without changing the earlier zero state", () => {
    let book = createMbpBook();
    for (const event of F01_BOOK.events.slice(0, 3)) book = applyMbpEvent(book, event);
    const deleted = book;
    const readded = applyMbpEvent(deleted, F01_BOOK.events[3]);
    expect(level(deleted)).toEqual({ status: "KNOWN", qty: 0 });
    expect(level(readded)).toEqual({ status: "KNOWN", qty: 60 });
    expect(deleted.bids).not.toBe(readded.bids);
  });
});

describe("R02 scope and omission semantics", () => {
  it("distinguishes NOT_INITIALIZED from zero and rejects updates before snapshot", () => {
    const book = createMbpBook();
    expect(level(book)).toEqual({ status: "NOT_INITIALIZED", qty: null });
    expect(book.bids.size).toBe(0);
    expect(book.asks.size).toBe(0);
    expect(() => applyMbpEvent(book, set)).toThrow("snapshot");
    expect(book.status).toBe("NOT_INITIALIZED");
  });

  it("does not assume FULL snapshot omissions mean zero without evidence", () => {
    const book = applyMbpEvent(createMbpBook(), snapshot());
    expect(level(book)).toEqual({ status: "KNOWN", qty: 40 });
    expect(level(book, "BID", 79999)).toEqual({ status: "UNKNOWN", qty: null });
    expect(level(book, "ASK", 80000)).toEqual({ status: "UNKNOWN", qty: null });
    const knownZero = applyMbpEvent(book, { ...set, priceTicks: 79999, qty: 0 });
    expect(level(knownZero, "BID", 79999)).toEqual({ status: "KNOWN", qty: 0 });
  });

  it("allows FULL omission zero only with explicit evidence and keeps the maps sparse", () => {
    const book = applyMbpEvent(createMbpBook(), snapshot(), zeroEvidence);
    expect(level(book, "BID", 79999)).toEqual({ status: "KNOWN", qty: 0 });
    expect(book.bids.has(79999)).toBe(false);
  });

  it("PRICE_RANGE keeps inclusive boundaries and OUTSIDE_DEPTH separate from zero", () => {
    const book = applyMbpEvent(createMbpBook(),
      snapshot({ type: "PRICE_RANGE", minTick: 79998, maxTick: 80003 }), zeroEvidence);
    expect(level(book, "BID", 79998)).toEqual({ status: "KNOWN", qty: 10 });
    expect(level(book, "ASK", 80003)).toEqual({ status: "KNOWN", qty: 30 });
    expect(level(book, "BID", 79999)).toEqual({ status: "KNOWN", qty: 0 });
    expect(level(book, "BID", 79997)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
    expect(level(book, "ASK", 80004)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
    expect(() => applyMbpEvent(book, { ...set, priceTicks: 80004 })).toThrow("outside");
  });

  it("PRICE_RANGE returns UNKNOWN for unlisted in-range prices by default", () => {
    const book = applyMbpEvent(createMbpBook(), snapshot({
      type: "PRICE_RANGE", minTick: 79998, maxTick: 80003,
    }));
    expect(level(book, "BID", 79999)).toEqual({ status: "UNKNOWN", qty: null });
    expect(level(book, "ASK", 80000)).toEqual({ status: "UNKNOWN", qty: null });
  });

  it("TOP_N preserves separate side bounds and does not extrapolate depth", () => {
    const book = applyMbpEvent(createMbpBook(), snapshot({ type: "TOP_N", n: 2 }));
    expect(book.depthScope).toEqual({ type: "TOP_N", n: 2 });
    expect(level(book, "BID", 79999)).toEqual({ status: "UNKNOWN", qty: null });
    expect(level(book, "ASK", 80002)).toEqual({ status: "UNKNOWN", qty: null });
    expect(level(book, "BID", 80001)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
    expect(level(book, "ASK", 80000)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
    expect(level(book, "BID", 79997)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
    expect(level(book, "ASK", 80004)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
    expect(() => applyMbpEvent(book, { ...set, priceTicks: 79997 })).toThrow("snapshot");
  });

  it("TOP_N omission evidence applies only inside observed side envelopes", () => {
    const book = applyMbpEvent(createMbpBook(), snapshot({ type: "TOP_N", n: 2 }), zeroEvidence);
    expect(level(book, "BID", 79999)).toEqual({ status: "KNOWN", qty: 0 });
    expect(level(book, "ASK", 80002)).toEqual({ status: "KNOWN", qty: 0 });
    expect(level(book, "BID", 79997)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
  });

  it("does not turn an empty TOP_N side into known zeros", () => {
    const book = applyMbpEvent(createMbpBook(), {
      ...snapshot({ type: "TOP_N", n: 2 }), asks: [],
    }, zeroEvidence);
    expect(level(book, "ASK", 80001)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
    expect(book.asks.size).toBe(0);
  });

  it("requires nonempty evidence for zero omission semantics", () => {
    expect(() => applyMbpEvent(createMbpBook(), snapshot(), {
      unlistedLevels: "ZERO", evidence: " ",
    })).toThrow("evidence");
  });

  it("a later snapshot replaces both maps and resets omission semantics conservatively", () => {
    const first = applyMbpEvent(createMbpBook(), snapshot(), zeroEvidence);
    const next = applyMbpEvent(first, {
      ...initial, bids: [{ priceTicks: 80000, qty: restingQuantity(15) }], asks: [],
    });
    expect(next.bids.size).toBe(1);
    expect(next.asks.size).toBe(0);
    expect(level(next)).toEqual({ status: "KNOWN", qty: 15 });
    expect(level(next, "ASK", 80000)).toEqual({ status: "UNKNOWN", qty: null });
    expect(level(first, "BID", 79999)).toEqual({ status: "KNOWN", qty: 0 });
    expect(first.asks.size).toBe(2);
  });
});

describe("R02 side separation and pure absolute updates", () => {
  it("updates BID and ASK independently even at exactly the same price", () => {
    let book = applyMbpEvent(createMbpBook(), initial);
    book = applyMbpEvent(book, { ...set, side: "ASK", qty: 25 });
    expect(level(book, "BID")).toEqual({ status: "KNOWN", qty: 40 });
    expect(level(book, "ASK")).toEqual({ status: "KNOWN", qty: 25 });
    book = applyMbpEvent(book, { ...set, kind: "L2_DELETE_LEVEL", side: "ASK", qty: 0 });
    expect(level(book, "BID")).toEqual({ status: "KNOWN", qty: 40 });
    expect(level(book, "ASK")).toEqual({ status: "KNOWN", qty: 0 });
    book = applyMbpEvent(book, { ...set, side: "ASK", qty: 9 });
    expect(level(book, "ASK")).toEqual({ status: "KNOWN", qty: 9 });
    expect(level(book, "BID")).toEqual({ status: "KNOWN", qty: 40 });
  });

  it("uses absolute SET, never accumulates, and preserves explicit zero", () => {
    const first = applyMbpEvent(createMbpBook(), initial);
    const second = applyMbpEvent(first, set);
    const third = applyMbpEvent(second, { ...set, qty: 10 });
    expect(level(second).qty).toBe(80);
    expect(level(third).qty).toBe(10);
    expect(level(applyMbpEvent(third, { ...set, qty: 0 }))).toEqual({ status: "KNOWN", qty: 0 });
    expect(level(first).qty).toBe(40);
  });

  it("DELETE establishes known zero even for an unlisted, in-scope level", () => {
    const book = applyMbpEvent(createMbpBook(), snapshot());
    const next = applyMbpEvent(book, { ...set, kind: "L2_DELETE_LEVEL", priceTicks: 79999, qty: 0 });
    expect(level(book, "BID", 79999)).toEqual({ status: "UNKNOWN", qty: null });
    expect(level(next, "BID", 79999)).toEqual({ status: "KNOWN", qty: 0 });
  });

  it("does not retain mutable references to raw snapshot metadata", () => {
    const raw = JSON.parse(JSON.stringify(initial));
    const book = applyMbpEvent(createMbpBook(), raw, zeroEvidence);
    raw.bids[0].qty = 999;
    raw.header.eventId = "changed";
    raw.depthScope.minTick = 1;
    expect(level(book).qty).toBe(40);
    expect(book.lastHeader?.eventId).toBe("MOCK-F-01-1");
    expect(book.depthScope).toEqual({ type: "PRICE_RANGE", minTick: 80000, maxTick: 80000 });
  });

  it("preserves exact nanosecond metadata and source sequence without arithmetic", () => {
    const book = applyMbpEvent(createMbpBook(), {
      ...initial, header: { ...initial.header,
        exchangeTimeNs: "1767225600000000001", sequence: "900719925474099312345" },
    });
    expect(book.lastHeader?.exchangeTimeNs).toBe("1767225600000000001");
    expect(book.lastHeader?.sequence).toBe("900719925474099312345");
  });
});

describe("R02 complete atomic update batches", () => {
  const book = applyMbpEvent(createMbpBook(), initial);
  const batch = [
    { ...set, qty: 70, updateBatchId: "MOCK-BATCH-1" },
    { ...set, kind: "L2_DELETE_LEVEL", qty: 0, updateBatchId: "MOCK-BATCH-1",
      header: { ...set.header, eventId: "MOCK-BATCH-EVENT-2", sequence: "3" } },
    { ...set, qty: 12, updateBatchId: "MOCK-BATCH-1",
      header: { ...set.header, eventId: "MOCK-BATCH-EVENT-3", sequence: "4" } },
    { ...set, side: "ASK", qty: 8, updateBatchId: "MOCK-BATCH-1",
      header: { ...set.header, eventId: "MOCK-BATCH-EVENT-4", sequence: "5" } },
  ];

  it("applies a full logical batch in input order with no intermediate state mutation", () => {
    const originalBook = values(book);
    const originalBatch = JSON.stringify(batch);
    const next = applyMbpBatch(book, batch);
    expect(level(next, "BID").qty).toBe(12);
    expect(level(next, "ASK").qty).toBe(8);
    expect(next.lastHeader?.eventId).toBe("MOCK-BATCH-EVENT-4");
    expect(values(book)).toEqual(originalBook);
    expect(JSON.stringify(batch)).toBe(originalBatch);
  });

  it("never sorts by time or sequence behind the caller's back", () => {
    const ordered = [
      { ...set, qty: 90, header: { ...set.header, sequence: "99" } },
      { ...set, qty: 5, header: { ...set.header, sequence: "2" } },
    ];
    expect(level(applyMbpBatch(book, ordered)).qty).toBe(5);
  });

  it("rejects an individual batch-tagged update to avoid exposing partial batches", () => {
    expect(() => applyMbpEvent(book, batch[0])).toThrow("complete");
    expect(level(book).qty).toBe(40);
  });

  it.each([
    [],
    [batch[0], { ...batch[1], qty: -1 }],
    [batch[0], { ...batch[1], priceTicks: 80000.1 }],
    [batch[0], { ...batch[1], updateBatchId: "OTHER" }],
    [batch[0], { ...batch[1], updateBatchId: undefined }],
    [batch[0], { ...batch[1], header: { ...set.header, exchangeTimeNs: "1767225602000000000" } }],
    [batch[0], { ...batch[1], header: { ...set.header, canonicalInstrumentId: "CME:NQ:2026-06" } }],
    [batch[0], initial],
    [batch[0], F04_TRADES.events[0]],
  ].map((events) => ({ events })))(
    "rejects the entire invalid batch %# without changing the existing book", ({ events }) => {
    const before = values(book);
    expect(() => applyMbpBatch(book, events)).toThrow();
    expect(values(book)).toEqual(before);
  });
});

describe("R02 validation and isolation", () => {
  const book = applyMbpEvent(createMbpBook(), initial);
  it.each([-1, 0.25, NaN, Infinity, "40", null, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid qty %s and preserves the current book", (qty) => {
      expect(() => applyMbpEvent(book, { ...set, qty })).toThrow();
      expect(level(book).qty).toBe(40);
    },
  );

  it.each([80000.25, NaN, Infinity, "80000", null, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid priceTicks %s in updates, snapshots and reads", (priceTicks) => {
      expect(() => applyMbpEvent(book, { ...set, priceTicks })).toThrow();
      expect(() => applyMbpEvent(book, { ...initial, bids: [{ priceTicks, qty: 1 }] })).toThrow();
      expect(() => readMbpLevel(book, "BID", priceTicks as number)).toThrow();
      expect(level(book).qty).toBe(40);
    },
  );

  it.each([
    { canonicalInstrumentId: "CME:NQ:2026-06" }, { sessionId: "OTHER" },
    { sourceId: "OTHER-MOCK-SOURCE" }, { environment: "REPLAY_FROM_SAVED_DATA" },
    { quality: "SUSPECT" }, { quality: "GAP" },
  ])("rejects incompatible/invalid identity or quality %j", (headerPatch) => {
    const before = values(book);
    expect(() => applyMbpEvent(book, { ...set, header: { ...set.header, ...headerPatch } })).toThrow();
    expect(() => applyMbpEvent(book, { ...initial, header: { ...initial.header, ...headerPatch } })).toThrow();
    expect(values(book)).toEqual(before);
  });

  it("creates separate books for separate contracts instead of merging them", () => {
    const june = applyMbpEvent(createMbpBook(), {
      ...initial, header: { ...initial.header, canonicalInstrumentId: "CME:NQ:2026-06" },
      bids: [{ priceTicks: 80000, qty: restingQuantity(7) }],
    });
    expect(june.identity?.canonicalInstrumentId).toBe("CME:NQ:2026-06");
    expect(level(june).qty).toBe(7);
    expect(book.identity?.canonicalInstrumentId).toBe("CME:NQ:2026-03");
    expect(level(book).qty).toBe(40);
  });

  it.each([
    F04_TRADES.events[0],
    { kind: "L1_QUOTE", header: { ...initial.header, channel: "L1" },
      bestBidTick: 80000, bestAskTick: 80001, bidQty: 1, askQty: 2 },
    { ...set, side: "BUY" },
    { ...initial, bids: [...initial.bids, ...initial.bids] },
    { ...initial, asks: [{ priceTicks: 80001, qty: 1 }] },
    { ...snapshot({ type: "TOP_N", n: 1 }) },
  ])("rejects incompatible or inconsistent payload %# without state corruption", (event) => {
    const before = values(book);
    expect(() => applyMbpEvent(book, event)).toThrow();
    expect(values(book)).toEqual(before);
  });

  it("supports safe negative Tick keys and does not interpret price as quantity", () => {
    const negative = applyMbpEvent(createMbpBook(), {
      ...initial, depthScope: { type: "FULL" },
      bids: [{ priceTicks: -1, qty: restingQuantity(3) }],
    });
    expect(level(negative, "BID", -1)).toEqual({ status: "KNOWN", qty: 3 });
  });
});
