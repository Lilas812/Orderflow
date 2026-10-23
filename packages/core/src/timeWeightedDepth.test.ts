import { describe, expect, it, vi } from "vitest";
import * as mbpModule from "./mbpBook";
import { F01_BOOK as F01, F02_TWO_TICKS as F02, F03_GAP_TWA as F03 } from "../../fixtures/src/index";
import { validateMarketEvent, type L2Snapshot } from "./events";
import {
  createMarketQualityState, ingestMarketEvent, ingestMbpBatch, markChannelCondition,
  transitionQuality, type MarketQualityState,
} from "./qualityTimeline";
import {
  calculateTimeWeightedDepth, calculateTimeWeightedDepthCells,
  type DepthHistory, type DepthQuery, type DepthRecord,
} from "./timeWeightedDepth";

// Compatibility cases first passed on the original per-cell path.
const runCells = calculateTimeWeightedDepthCells;

const origin = BigInt(F01.expected.startNs);
const at = (seconds: number) => (origin + BigInt(seconds) * 1_000_000_000n).toString();
const alignment = "MOCK only: exchange and receive times coincide; quality boundaries are explicitly aligned";
const diagnostic = (globalThis as unknown as { console: { info(message: string): void } }).console;

function initialState(snapshot: L2Snapshot): MarketQualityState {
  const h = snapshot.header;
  const rule = { scope: h.sequenceScope, continuity: {
    contiguous: true, evidence: "MOCK guarantees +1 per normalized event in each exact channel partition",
  } } as const;
  return createMarketQualityState({
    identity: { environment: h.environment, source: h.source, sourceId: h.sourceId,
      canonicalInstrumentId: h.canonicalInstrumentId, sessionId: h.sessionId },
    depthScope: snapshot.depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
    snapshotAlignmentEvidence: "MOCK only: snapshot header sequence equals snapshotCoversSequence",
  }, h.exchangeTimeNs!);
}

function depth(input: unknown): DepthRecord {
  const event = validateMarketEvent(input);
  if (event.kind === "L1_QUOTE" || event.kind.startsWith("TRADE")) throw new Error("Expected L2 record");
  return event as DepthRecord;
}

function history(events: readonly DepthRecord[] = F01.events): DepthHistory {
  const first = events[0];
  if (!first || "batch" in first || first.kind !== "L2_SNAPSHOT") throw new Error("Test needs initial snapshot");
  let state = initialState(first);
  for (const record of events) {
    const result = "batch" in record ? ingestMbpBatch(state, record.batch) : ingestMarketEvent(state, record);
    if (!result.applied) throw new Error(`Unexpected MOCK replay rejection: ${result.reason}`);
    state = result.state;
  }
  return { events, qualityState: state, qualityTimeAlignmentEvidence: alignment };
}

function query(start = 0, end = 10, patch: Partial<DepthQuery> = {}): DepthQuery {
  return { side: "BID", priceTicks: 80000, width: 1, startNs: at(start), endNs: at(end), ...patch };
}

function gapHistory(): DepthHistory {
  let state = initialState(F03.events[0]);
  state = ingestMarketEvent(state, F03.events[0]).state;
  state = markChannelCondition(state, "L2_MBP", "GAP", F03.gap.startNs,
    "MOCK declares exact missing interval [9,11)");
  state = ingestMarketEvent(state, F03.events[1]).state;
  return { events: F03.events, qualityState: state, qualityTimeAlignmentEvidence: F03.timeAlignmentEvidence };
}

describe("R04 F-01 exact event-time integral", () => {
  it("TWA[0,10)=38 exactly, from five unchanged events rather than frame samples", () => {
    const result = calculateTimeWeightedDepth(history(), query());
    expect(result).toMatchObject({
      status: "VALID", twa: 38, partialTWA: 38,
      coverageRatio: 1, coveredDuration: "10000000000", integralQuantityNs: "380000000000",
    });
    diagnostic.info(`MOCK F-01: ${JSON.stringify(result)}`);
  });

  it.each([[0, 2, 60], [2, 4, 40], [4, 6, 30], [6, 8, 60], [8, 10, 0]])(
    "TWA[%i,%i)=%i exactly", (start, end, expected) => {
      const result = calculateTimeWeightedDepth(history(), query(start, end));
      expect(result.status).toBe("VALID");
      expect(result.twa).toBe(expected);
      expect(result.partialTWA).toBe(expected);
      expect(result.coveredDuration).toBe("2000000000");
    },
  );

  it.each([[0, 1, 40], [1, 3, 80], [3, 5, 0], [5, 8, 60], [8, 10, 0]])(
    "uses left-closed/right-open event boundaries [%i,%i)=%i", (start, end, expected) => {
      expect(calculateTimeWeightedDepth(history(), query(start, end)).twa).toBe(expected);
    },
  );

  it("carries the established quantity through a known interval without events", () => {
    const result = calculateTimeWeightedDepth(history(), query(6, 7));
    expect(result).toMatchObject({ status: "VALID", twa: 60, coverageRatio: 1 });
  });

  it("does not count an update at the right endpoint", () => {
    expect(calculateTimeWeightedDepth(history(), query(0, 1)).integralQuantityNs).toBe("40000000000");
  });

  it("clips the initial state at the query start and excludes pre-snapshot time", () => {
    const result = calculateTimeWeightedDepth(history(), query(-1, 1));
    expect(result).toMatchObject({
      status: "NO DATA", twa: null, partialTWA: 40, coverageRatio: 0.5, coveredDuration: "1000000000",
    });
  });

  it("does not mutate raw fixture, R03 timeline, guard maps, or existing book maps", () => {
    const input = history();
    const raw = JSON.stringify(F01);
    const timeline = JSON.stringify(input.qualityState.timeline);
    const book = [...input.qualityState.lastGoodBook.bids];
    const seen = [...input.qualityState.guard.seen];
    calculateTimeWeightedDepth(input, query());
    expect(JSON.stringify(F01)).toBe(raw);
    expect(JSON.stringify(input.qualityState.timeline)).toBe(timeline);
    expect([...input.qualityState.lastGoodBook.bids]).toEqual(book);
    expect([...input.qualityState.guard.seen]).toEqual(seen);
    expect(F01.events).toHaveLength(5);
  });
});

describe("R04 F-02 price aggregation", () => {
  it("2 Tick: 38 + 20 = 58, with both ticks continuously known", () => {
    const result = calculateTimeWeightedDepth(history(F02.events), query(0, 10, { width: 2 }));
    expect(result).toMatchObject({ status: "VALID", twa: 58, partialTWA: 58, coverageRatio: 1 });
    diagnostic.info(`MOCK F-02: ${JSON.stringify(result)}`);
  });

  it.each([[80000, 38], [80001, 20]])("1 Tick keeps price %i at TWA %i", (priceTicks, expected) => {
    expect(calculateTimeWeightedDepth(history(F02.events), query(0, 10, { priceTicks })).twa).toBe(expected);
  });

  it("either representative Tick selects the same 2-Tick price cell", () => {
    const a = calculateTimeWeightedDepth(history(F02.events), query(0, 10, { width: 2, priceTicks: 80000 }));
    const b = calculateTimeWeightedDepth(history(F02.events), query(0, 10, { width: 2, priceTicks: 80001 }));
    expect(a).toEqual(b);
    expect(a.binId).toBe(40000);
  });

  it("does not pretend width4 is complete when two ticks are outside depth", () => {
    const result = calculateTimeWeightedDepth(history(F02.events), query(0, 10, { width: 4 }));
    expect(result).toMatchObject({
      status: "NO DATA", twa: null, partialTWA: null, coveredDuration: "0", coverageRatio: 0,
    });
  });
});

describe("R04 F-03 quality-aware partial integral", () => {
  it("covers 2 seconds, ratio 0.5, partial35, and refuses a final numeric value", () => {
    const result = calculateTimeWeightedDepth(gapHistory(), query(8, 12));
    expect(result).toMatchObject(F03.expected);
    expect(result.integralQuantityNs).toBe("70000000000");
    diagnostic.info(`MOCK F-03: ${JSON.stringify(result)}`);
  });

  it("known zero before the gap counts as covered time", () => {
    expect(calculateTimeWeightedDepth(gapHistory(), query(8, 9))).toMatchObject({
      status: "VALID", twa: 0, partialTWA: 0, coveredDuration: "1000000000", coverageRatio: 1,
    });
  });

  it("GAP itself is not a zero-valued observation", () => {
    expect(calculateTimeWeightedDepth(gapHistory(), query(9, 11))).toMatchObject({
      status: "NO DATA", twa: null, partialTWA: null, coveredDuration: "0", coverageRatio: 0,
    });
  });

  it("new snapshot at 11 is included only from its own left boundary", () => {
    expect(calculateTimeWeightedDepth(gapHistory(), query(11, 12))).toMatchObject({
      status: "VALID", twa: 70, coveredDuration: "1000000000", coverageRatio: 1,
    });
  });

  it("a quality VALID notification without a new snapshot cannot restore the old book", () => {
    const input = gapHistory();
    const timeline = transitionQuality(
      input.qualityState.timeline, "L2_MBP", "VALID", F03.gap.endNs,
      "MOCK notification without the required snapshot", "CONTIGUOUS",
    );
    const result = calculateTimeWeightedDepth({
      ...input, events: [F03.events[0]],
      qualityState: { ...input.qualityState, timeline },
    }, query(8, 12));
    expect(result).toMatchObject({
      status: "NO DATA", twa: null, coveredDuration: "1000000000", coverageRatio: 0.25, partialTWA: 0,
    });
  });

  it("an update without a recovery snapshot cannot establish quantities after a gap", () => {
    const input = gapHistory();
    const update = depth({
      ...F01.events[1], qty: 70,
      header: { ...F03.events[1].header, eventId: "MOCK-NO-RECOVERY-SNAPSHOT" },
    });
    const result = calculateTimeWeightedDepth({ ...input, events: [F03.events[0], update] }, query(8, 12));
    expect(result.coveredDuration).toBe("1000000000");
    expect(result.status).toBe("NO DATA");
  });
});

describe("R04 side, price, and channel separation", () => {
  it("does not confuse unknown ASK with the known BID", () => {
    expect(calculateTimeWeightedDepth(history(), query(0, 10, { side: "ASK" }))).toMatchObject({
      status: "NO DATA", coveredDuration: "0", partialTWA: null, twa: null,
    });
  });

  it("computes independent known ASK quantities without subtracting executions", () => {
    const first = depth({ ...F01.events[0], asks: [{ priceTicks: 80000, qty: 3 }] });
    const input = history([first, ...F01.events.slice(1)]);
    expect(calculateTimeWeightedDepth(input, query()).twa).toBe(38);
    expect(calculateTimeWeightedDepth(input, query(0, 10, { side: "ASK" })).twa).toBe(3);
  });

  it.each([[1, 1, 10], [2, 3, 30], [4, 10, 100], [8, 36, 360]] as const)(
    "aggregates width %i independently: BID%i ASK%i", (width, bid, ask) => {
      const first = depth({
        ...F01.events[0], depthScope: { type: "PRICE_RANGE", minTick: 80000, maxTick: 80007 },
        bids: Array.from({ length: 8 }, (_, i) => ({ priceTicks: 80000 + i, qty: i + 1 })),
        asks: Array.from({ length: 8 }, (_, i) => ({ priceTicks: 80000 + i, qty: (i + 1) * 10 })),
      });
      const input = history([first]);
      expect(calculateTimeWeightedDepth(input, query(0, 10, { width })).twa).toBe(bid);
      expect(calculateTimeWeightedDepth(input, query(0, 10, { width, side: "ASK" })).twa).toBe(ask);
    },
  );

  it("keeps negative Tick price cells mathematically floor-aligned", () => {
    const first = depth({
      ...F01.events[0], depthScope: { type: "PRICE_RANGE", minTick: -2, maxTick: -1 },
      bids: [{ priceTicks: -2, qty: 40 }, { priceTicks: -1, qty: 20 }],
    });
    expect(calculateTimeWeightedDepth(history([first]), query(0, 10, { priceTicks: -1, width: 2 })))
      .toMatchObject({ status: "VALID", twa: 60, binId: -1 });
  });

  it("L1/TRADES gaps do not invalidate L2 coverage", () => {
    const input = history();
    let state = markChannelCondition(input.qualityState, "L1", "GAP", at(9), "MOCK L1 missing");
    state = markChannelCondition(state, "TRADES", "GAP", at(9), "MOCK trades missing");
    expect(calculateTimeWeightedDepth({ ...input, qualityState: state }, query()).twa).toBe(38);
  });

  it.each(["NOT_INITIALIZED", "GAP", "STALE", "RESYNCING", "CLOSED", "OUTSIDE_DEPTH"] as const)(
    "does not cover intervals in quality state %s", (status) => {
      const input = history([F01.events[0]]);
      const timeline = transitionQuality(input.qualityState.timeline, "L2_MBP", status, at(1), "MOCK quality interval");
      expect(calculateTimeWeightedDepth({
        ...input, qualityState: { ...input.qualityState, timeline },
      }, query(1, 2))).toMatchObject({ status: "NO DATA", coveredDuration: "0", partialTWA: null });
    },
  );

  it("does not certify an R03 interval with unverifiable sequencing", () => {
    const input = history();
    const timeline = transitionQuality(input.qualityState.timeline, "L2_MBP", "VALID",
      at(9), "MOCK sequence unavailable", "UNVERIFIABLE");
    const result = calculateTimeWeightedDepth({ ...input,
      qualityState: { ...input.qualityState, timeline } }, query(9, 10));
    expect(result.status).toBe("NO DATA");
    expect(result.coveredDuration).toBe("0");
  });

  it("an unknown component makes the entire price cell incomplete", () => {
    const first = depth({
      ...F01.events[0], depthScope: { type: "PRICE_RANGE", minTick: 80000, maxTick: 80001 },
    });
    const input = history([first]);
    expect(calculateTimeWeightedDepth(input, query(0, 10, { width: 2 })).status).toBe("NO DATA");
    expect(calculateTimeWeightedDepth({
      ...input, snapshotSemantics: { unlistedLevels: "ZERO", evidence: "MOCK omissions explicitly mean zero" },
    }, query(0, 10, { width: 2 })).twa).toBe(40);
  });

  it("no snapshot at all produces NOT_INITIALIZED/NO DATA, never a zero average", () => {
    const state = initialState(F01.events[0]);
    const result = calculateTimeWeightedDepth({
      events: [], qualityState: state, qualityTimeAlignmentEvidence: alignment,
    }, query());
    expect(result).toMatchObject({ status: "NO DATA", twa: null, partialTWA: null, coveredDuration: "0" });
  });
});

describe("R04 nanosecond and same-time boundaries", () => {
  it.each([
    ["750000000", "1000000000", 40],
    ["1000000000", "1250000000", 80],
    ["875000000", "1125000000", 60],
  ])("integrates 250ms [%s,%s) as %i without frame sampling", (left, right, expected) => {
    const result = calculateTimeWeightedDepth(history(), query(0, 10, {
      startNs: (origin + BigInt(left)).toString(), endNs: (origin + BigInt(right)).toString(),
    }));
    expect(result.twa).toBe(expected);
    expect(result.coveredDuration).toBe("250000000");
  });

  it("keeps equal-time event order and assigns no duration to intermediate states", () => {
    const updates = [80, 60].map((qty, i) => depth({
      ...F01.events[1], qty,
      header: { ...F01.events[1].header, sequence: String(i + 2), eventId: `MOCK-SAME-TIME-${i}` },
    }));
    const input = history([F01.events[0], ...updates]);
    expect(calculateTimeWeightedDepth(input, query(0, 2)).twa).toBe(50);
    expect(calculateTimeWeightedDepth(input, query(1, 2)).twa).toBe(60);
  });

  it("uses only the final state of an explicit complete same-time batch", () => {
    const updates = [80, 60].map((qty, i) => validateMarketEvent({
      ...F01.events[1], qty, updateBatchId: "MOCK-TWA-BATCH",
      header: { ...F01.events[1].header, sequence: String(i + 2), eventId: `MOCK-BATCH-${i}` },
    }));
    const batch = { batch: updates } as DepthRecord;
    const input = history([F01.events[0], batch]);
    expect(calculateTimeWeightedDepth(input, query(0, 2)).twa).toBe(50);
  });

  it("retains adjacent nanoseconds even at an epoch far beyond Number precision", () => {
    const huge = 99999999999999999999999999999999999999991n;
    const first = depth({ ...F01.events[0], header: { ...F01.events[0].header,
      exchangeTimeNs: huge.toString(), receiveTimeNs: huge.toString() } });
    const second = depth({ ...F01.events[1], header: { ...F01.events[1].header,
      exchangeTimeNs: (huge + 1n).toString(), receiveTimeNs: (huge + 1n).toString() } });
    const result = calculateTimeWeightedDepth(history([first, second]), query(0, 10, {
      startNs: huge.toString(), endNs: (huge + 2n).toString(),
    }));
    expect(result).toMatchObject({
      status: "VALID", twa: 60, coveredDuration: "2", integralQuantityNs: "120",
    });
  });

  it("uses exact duration equality, not rounded coverage, to decide finality", () => {
    const huge = 10n ** 22n;
    const first = depth({ ...F01.events[0], header: { ...F01.events[0].header,
      exchangeTimeNs: "0", receiveTimeNs: "0" } });
    const input = history([first]);
    const state = markChannelCondition(input.qualityState, "L2_MBP", "GAP", huge.toString(), "MOCK 1ns missing");
    const result = calculateTimeWeightedDepth({ ...input, qualityState: state }, query(0, 1, {
      startNs: "0", endNs: (huge + 1n).toString(),
    }));
    expect(result.status).toBe("NO DATA");
    expect(result.twa).toBeNull();
    expect(result.coverageRatio).toBeLessThan(1);
    expect(result.coveredDuration).toBe(huge.toString());
    expect(result.partialTWA).toBe(40);
  });
});

describe("R04 input validation, not silent repair", () => {
  it.each([
    { startNs: at(1), endNs: at(1) }, { startNs: at(2), endNs: at(1) },
    { startNs: "1.5" }, { endNs: "1e18" }, { startNs: 1 },
    { side: "BUY" }, { priceTicks: 80000.25 }, { width: 3 },
  ])("rejects malformed query %j", (patch) => {
    expect(() => calculateTimeWeightedDepth(history(), { ...query(), ...patch } as DepthQuery)).toThrow();
  });

  it("does not silently align quality detection clocks to exchange clocks", () => {
    expect(() => calculateTimeWeightedDepth({
      ...history(), qualityTimeAlignmentEvidence: "",
    }, query())).toThrow("alignment");
  });

  it("rejects event-time reversal instead of sorting the source", () => {
    const input = history();
    expect(() => calculateTimeWeightedDepth({
      ...input, events: [F01.events[0], F01.events[2], F01.events[1]],
    }, query())).toThrow("order");
  });

  it.each([
    { canonicalInstrumentId: "CME:NQ:2026-06" },
    { sessionId: "MOCK-OTHER" }, { sourceId: "MOCK-OTHER-SOURCE" },
  ])("rejects mixed identity %j instead of joining histories", (patch) => {
    const foreign = depth({
      ...F01.events[1], header: { ...F01.events[1].header, ...patch },
    });
    expect(() => calculateTimeWeightedDepth({ ...history(), events: [F01.events[0], foreign] }, query()))
      .toThrow("identity");
  });

  it.each([
    { exchangeTimeNs: null }, { sourceTimePrecision: "unknown" }, { quality: "SUSPECT" },
  ])("rejects insufficient event-time/quality proof %j", (patch) => {
    const event = depth({ ...F01.events[0], header: { ...F01.events[0].header, ...patch } });
    expect(() => calculateTimeWeightedDepth({ ...history(), events: [event] }, query())).toThrow();
  });

  it("requires an explicit batch envelope for tagged updates", () => {
    const event = depth({ ...F01.events[1], updateBatchId: "MOCK-INCOMPLETE" });
    expect(() => calculateTimeWeightedDepth({ ...history(), events: [F01.events[0], event] }, query()))
      .toThrow("batch envelope");
  });

  it("rejects unsafe derived Number output rather than silently losing quantity precision", () => {
    const first = depth({ ...F02.events[0], bids: [
      { priceTicks: 80000, qty: Number.MAX_SAFE_INTEGER },
      { priceTicks: 80001, qty: Number.MAX_SAFE_INTEGER },
    ] });
    expect(() => calculateTimeWeightedDepth(history([first]), query(0, 10, { width: 2 }))).toThrow("safe Number");
  });

  it("also rejects an exact mean just one half above MAX_SAFE_INTEGER", () => {
    const first = depth({ ...F02.events[0], bids: [
      { priceTicks: 80000, qty: Number.MAX_SAFE_INTEGER }, { priceTicks: 80001, qty: 0 },
    ] });
    const second = depth({
      ...F01.events[1], priceTicks: 80001, qty: 1,
      header: { ...F02.events[1].header },
    });
    expect(() => calculateTimeWeightedDepth(history([first, second]), query(0, 2, { width: 2 })))
      .toThrow("safe Number");
  });

  it.each([F02, F03])("retains deterministic MOCK metadata for $fixtureId", (fixture) => {
    expect(fixture.environment).toBe("MOCK");
    expect(fixture.seed).toBe(fixture.fixtureId === "F-02" ? 2 : 3);
    expect(fixture.expectedResultSchemaVersion).toBe(1);
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
    expect(fixture.events.map((event) => event.header.sequence)).toEqual(
      fixture.fixtureId === "F-02" ? ["1", "2", "3", "4", "5"] : ["1", "2"],
    );
  });
});

describe("28-C3 frame-local preparation compatibility", () => {
  function outcome(run: () => unknown): unknown {
    try { return { value: run() }; }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      return { name: error.name, message: error.message };
    }
  }
  it.each([["F01", () => history()], ["F02", () => history(F02.events)], ["F03", gapHistory]] as const)(
    "%s matches every scalar field over deterministic overlapping ranges", (_, make) => {
      const h = make();
      const cells = Array.from({ length: 96 }, (_, i) => query(0, 10, {
        startNs: (origin + BigInt(i % 13) * 750_000_000n).toString(),
        endNs: (origin + BigInt(i % 13) * 750_000_000n + 1_250_000_001n).toString(),
        side: i % 3 ? "BID" : "ASK", width: [1, 2, 4, 8][i % 4] as 1 | 2 | 4 | 8,
      }));
      const before = JSON.stringify(h), bids = [...h.qualityState.lastGoodBook.bids];
      expect(runCells(h, cells)).toEqual(cells.map(cell => calculateTimeWeightedDepth(h, cell)));
      expect(JSON.stringify(h)).toBe(before);
      expect([...h.qualityState.lastGoodBook.bids]).toEqual(bids);
    },
  );
  it("retains fixed F01 and F03 exact integral goldens", () => {
    const one = runCells(history(), [query()])[0];
    expect(one).toMatchObject({ status: "VALID", twa: 38, partialTWA: 38,
      coverageRatio: 1, coveredDuration: "10000000000", integralQuantityNs: "380000000000" });
    expect(runCells(history(), Array.from({ length: 5 }, (_, i) => query(i * 2, i * 2 + 2)))
      .map(cell => cell.twa)).toEqual([60, 40, 30, 60, 0]);
    expect(runCells(gapHistory(), [query(8, 12)])[0]).toMatchObject({
      status: "NO DATA", twa: null, partialTWA: 35, coverageRatio: .5,
      coveredDuration: "2000000000", integralQuantityNs: "70000000000",
    });
  });
  it.each([1, 2, 4, 8] as const)("preserves negative ticks and width %i", width => {
    const snapshot = depth({ ...F01.events[0],
      depthScope: { type: "PRICE_RANGE", minTick: -8, maxTick: 0 },
      bids: Array.from({ length: 8 }, (_, i) => ({ priceTicks: -8 + i, qty: 1 })), asks: [],
    });
    const cells = [query(0, 10, { priceTicks: -1, width })];
    expect(runCells(history([snapshot]), cells)[0]).toMatchObject({ status: "VALID", twa: width });
  });
  it("retains adjacent nanoseconds, endpoint exclusion and original output order", () => {
    const cells = [query(1, 2), query(0, 1), query(0, 10, {
      startNs: (BigInt(at(1)) - 1n).toString(), endNs: (BigInt(at(1)) + 1n).toString(),
    })];
    expect(runCells(history(), cells).map(c => c.twa)).toEqual([80, 40, 60]);
  });
  it("retains exact large integrals without converting epoch nanoseconds", () => {
    const snap = depth({ ...F01.events[0], bids: [{ priceTicks: 80000, qty: Number.MAX_SAFE_INTEGER }] });
    expect(runCells(history([snap]), [query()])[0]).toMatchObject({
      twa: Number.MAX_SAFE_INTEGER,
      integralQuantityNs: (BigInt(Number.MAX_SAFE_INTEGER) * 10_000_000_000n).toString(),
    });
  });
  it("does not inspect any history for an empty cell list", () => {
    expect(runCells({} as DepthHistory, [])).toEqual([]);
  });
  it.each([
    { side: "BUY" }, { width: 3 }, { startNs: "1.5" }, { endNs: at(0) },
  ])("validates the first query before malformed history: %j", patch => {
    const cells = [{ ...query(), ...patch } as DepthQuery];
    expect(outcome(() => runCells({} as DepthHistory, cells))).toEqual(
      outcome(() => cells.map(c => calculateTimeWeightedDepth({} as DepthHistory, c))));
  });
  it("rejects malformed history before inspecting a later invalid query", () => {
    const h = { ...history(), qualityTimeAlignmentEvidence: "" };
    expect(() => runCells(h, [query(), { ...query(), side: "BUY" } as unknown as DepthQuery]))
      .toThrow("Event/quality time alignment evidence is required");
  });
  it("does not inspect later cells after an intermediate failure", () => {
    const cells = [query(), { ...query(), side: "BUY" } as unknown as DepthQuery];
    Object.defineProperty(cells, 2, { get() { throw new Error("Later cell inspected"); } });
    expect(() => runCells(history(), cells)).toThrow("Side must be BID or ASK");
  });
  it("validates future raw events even when every query ends earlier", () => {
    const bad = depth({ ...F01.events[0],
      header: { ...F01.events[0].header, exchangeTimeNs: at(20), quality: "SUSPECT" },
    });
    expect(() => runCells({ ...history(), events: [F01.events[0], bad] }, [query(0, 1)]))
      .toThrow("Non-VALID raw events cannot establish depth");
  });
  it("rejects reversed raw event order rather than sorting it", () => {
    expect(() => runCells({ ...history(), events: [F01.events[0], F01.events[2], F01.events[1]] },
      [query(0, 1)])).toThrow("Depth events are out of order");
  });
  it("retains first-cell derived-quantity rejection before a later bad query", () => {
    const snap = depth({ ...F02.events[0], bids: [
      { priceTicks: 80000, qty: Number.MAX_SAFE_INTEGER },
      { priceTicks: 80001, qty: Number.MAX_SAFE_INTEGER },
    ] });
    expect(() => runCells(history([snap]), [query(0, 1, { width: 2 }),
      { ...query(), side: "BUY" } as unknown as DepthQuery])).toThrow("Derived quantity exceeds safe Number output");
  });
  it("retains zero-length GAP transitions and same-time Snapshot/SET/DELETE ordering", () => {
    const h = history([F01.events[0]]), intervals = h.qualityState.timeline.L2_MBP;
    const valid = intervals.at(-1)!;
    const qualityState = { ...h.qualityState, timeline: { ...h.qualityState.timeline, L2_MBP: [
      ...intervals.slice(0, -1), { ...valid, endNs: at(1) },
      { ...valid, status: "GAP" as const, startNs: at(1), endNs: at(1) },
      { ...valid, startNs: at(1) },
    ] } };
    const missing = { ...h, qualityState };
    expect(runCells(missing, [query(0, 2), query(1, 2)]).map(c => [c.twa, c.coverageRatio, c.partialTWA]))
      .toEqual([[null, .5, 40], [null, 0, null]]);
    const snapshot = depth({ ...F01.events[0], snapshotCoversSequence: "2",
      header: { ...F01.events[0].header, eventId: "MOCK-C3-SNAP", sequence: "2", exchangeTimeNs: at(1) } });
    const updates = [depth({ ...F01.events[1],
      header: { ...F01.events[1].header, eventId: "MOCK-C3-SET", sequence: "3" } }),
    depth({ ...F01.events[1], kind: "L2_DELETE_LEVEL", qty: 0,
      header: { ...F01.events[1].header, eventId: "MOCK-C3-DELETE", sequence: "4" } })];
    const recovered = { ...missing, events: [F01.events[0], snapshot, ...updates] };
    expect(runCells(recovered, [query(0, 2), query(1, 2)]).map(c => [c.twa, c.coverageRatio]))
      .toEqual([[20, 1], [0, 1]]);
  });
  it("keeps explicit batch intermediate states durationless and rejects incomplete envelopes", () => {
    const updates = [80, 60].map((qty, i) => validateMarketEvent({
      ...F01.events[1], qty, updateBatchId: "MOCK-C3-BATCH",
      header: { ...F01.events[1].header, sequence: String(i + 2), eventId: `MOCK-C3-BATCH-${i}` },
    }));
    const h = history([F01.events[0], { batch: updates } as DepthRecord]);
    expect(runCells(h, [query(0, 2), query(1, 2)]).map(c => c.twa)).toEqual([50, 60]);
    expect(() => runCells({ ...h, events: [F01.events[0], updates[0] as DepthRecord] }, [query(0, 1)]))
      .toThrow("Tagged updates require an explicit complete batch envelope");
  });
  it("shares preparation, sorting and first-bucket replay only within this call", () => {
    const base = history(), cells = [query(0, 2), query(2, 4), query(4, 6)];
    let reads = 0;
    const h = { ...base, get events() { reads++; return base.events; } };
    const apply = vi.spyOn(mbpModule, "applyMbpEvent");
    const sort = vi.spyOn(Array.prototype, "sort");
    try {
      const results = runCells(h, cells);
      expect(results.map(c => c.twa)).toEqual([60, 40, 30]);
      expect(reads).toBe(1);
      expect(sort).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls.filter(([, event]) => (event as L2Snapshot).kind === "L2_SNAPSHOT")).toHaveLength(1);
      runCells(h, cells);
      expect(reads).toBe(2);
      expect(sort).toHaveBeenCalledTimes(2);
      expect(apply.mock.calls.filter(([, event]) => (event as L2Snapshot).kind === "L2_SNAPSHOT")).toHaveLength(2);
    } finally { apply.mockRestore(); sort.mockRestore(); }
  });
});

describe("28-C4-B first-bucket lazy prefix compatibility", () => {
  function compare(h: DepthHistory, cells: readonly DepthQuery[]) {
    const expected = cells.map(cell => calculateTimeWeightedDepth(h, cell));
    expect(runCells(h, cells)).toEqual(expected);
    return expected;
  }
  function outcome(run: () => unknown) {
    try { return { value: run() }; }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      return { name: error.name, message: error.message };
    }
  }
  function update(offset: bigint, qty: number, patch: Record<string, unknown> = {}): DepthRecord {
    return depth({ ...F01.events[1], qty,
      header: { ...F01.events[1].header, eventId: `MOCK-C4-${offset}`,
        sequence: (offset + 1n).toString(), exchangeTimeNs: (origin + offset).toString(),
        receiveTimeNs: (origin + offset).toString() }, ...patch });
  }
  function wideHistory() {
    const snapshot = depth({ ...F01.events[0],
      depthScope: { type: "PRICE_RANGE", minTick: 40000, maxTick: 80007 },
      bids: Array.from({ length: 8 }, (_, i) => ({ priceTicks: 80000 + i, qty: i + 1 })),
      asks: Array.from({ length: 8 }, (_, i) => ({ priceTicks: 80000 + i, qty: (i + 1) * 10 })),
    });
    return history([snapshot, ...F01.events.slice(1)]);
  }
  const cases = (["BID", "ASK"] as const).flatMap(side =>
    ([1, 2, 4, 8] as const).map(width => ({ side, width })));

  it.each(cases)("matches every scalar field for $side width $width, including representative ticks", ({ side, width }) => {
    const h = wideHistory();
    const cells = [query(0, 10, { side, width }),
      ...Array.from({ length: 64 }, (_, i) => {
        const start = origin + BigInt((i * 17) % 53 - 8) * 250_000_000n;
        return query(0, 10, { side, width, priceTicks: 80000 + i % width,
          startNs: start.toString(), endNs: (start + BigInt(i % 9 + 1) * 750_000_000n + 1n).toString() });
      })];
    const before = JSON.stringify(h), bids = [...h.qualityState.lastGoodBook.bids];
    compare(h, cells);
    expect(JSON.stringify(h)).toBe(before);
    expect([...h.qualityState.lastGoodBook.bids]).toEqual(bids);
  });

  it.each([["F01", () => history()], ["F03", gapHistory]] as const)(
    "%s retains golden fields for duplicate, adjacent, reversed and overlapping windows", (_, make) => {
      const h = make();
      const cells = [query(0, 12), query(8, 10), query(0, 2), query(0, 2),
        query(2, 4), query(4, 6), query(3, 9), query(-2, 0), query(-1, 1)];
      compare(h, cells);
    },
  );

  it("reuses only the first side/width/binId key and keeps other buckets scalar", () => {
    const h = wideHistory();
    const cells = [query(0, 1, { width: 2 }), query(0, 1, { width: 2, side: "ASK" }),
      query(0, 1, { width: 2, priceTicks: 80001 }),
      // Same numeric binId=40000, but a different width must not reuse BID width 2.
      query(0, 1, { priceTicks: 40000 }), query(0, 1, { width: 2, priceTicks: 80002 }),
      query(0, 1, { width: 2 })];
    const expected = cells.map(cell => calculateTimeWeightedDepth(h, cell));
    const apply = vi.spyOn(mbpModule, "applyMbpEvent");
    try {
      expect(runCells(h, cells)).toEqual(expected);
      expect(expected.map(result => result.twa)).toEqual([3, 30, 3, null, 7, 3]);
      expect(apply.mock.calls.filter(([, event]) => (event as L2Snapshot).kind === "L2_SNAPSHOT")).toHaveLength(4);
    } finally { apply.mockRestore(); }
  });

  it("keeps exact nanosecond endpoints on both sides of every event boundary", () => {
    const cells = F01.events.flatMap(event => {
      const t = BigInt(event.header.exchangeTimeNs!);
      return [-1n, 0n, 1n].flatMap(offset => [
        query(0, 10, { startNs: (t + offset).toString(), endNs: (t + offset + 1n).toString() }),
        query(0, 10, { startNs: (t - 2n).toString(), endNs: (t + offset + 1n).toString() }),
      ]);
    });
    compare(history(), cells);
  });

  it("keeps GAP/RESYNCING unknown until a same-time recovery snapshot, SET and DELETE", () => {
    const base = history([F01.events[0]]);
    let timeline = transitionQuality(base.qualityState.timeline, "L2_MBP", "GAP", at(1), "MOCK gap");
    timeline = transitionQuality(timeline, "L2_MBP", "VALID", at(2), "MOCK transport only", "CONTIGUOUS");
    timeline = transitionQuality(timeline, "L2_MBP", "RESYNCING", at(3), "MOCK resync");
    timeline = transitionQuality(timeline, "L2_MBP", "GAP", at(4), "MOCK zero-length gap");
    timeline = transitionQuality(timeline, "L2_MBP", "VALID", at(4), "MOCK snapshot alignment", "CONTIGUOUS");
    const snapshot = depth({ ...F01.events[0], header: { ...F01.events[0].header,
      eventId: "MOCK-C4-RECOVERY", exchangeTimeNs: at(4), receiveTimeNs: at(4) } });
    const deleted = update(4_000_000_000n, 0, { kind: "L2_DELETE_LEVEL" });
    const events = [F01.events[0], update(2_000_000_000n, 70), snapshot, update(4_000_000_000n, 80), deleted]
      .map((record, i) => {
        if ("batch" in record) throw new Error("This test uses unbatched records");
        const sequence = String(i + 1);
        return depth({ ...record, header: { ...record.header, sequence, eventId: `MOCK-C4-QUALITY-${i}` },
          ...(record.kind === "L2_SNAPSHOT" ? { snapshotCoversSequence: sequence } : {}) });
      });
    const h = { ...base, qualityState: { ...base.qualityState, timeline }, events };
    const expected = compare(h, [query(0, 6), query(2, 3), query(4, 5), query(0, 1), query(1, 4)]);
    expect(expected[0]).toMatchObject({ status: "NO DATA", coverageRatio: .5,
      coveredDuration: "3000000000", integralQuantityNs: "40000000000" });
    expect(expected[1]).toMatchObject({ partialTWA: null, coveredDuration: "0" });
    expect(expected[2]).toMatchObject({ status: "VALID", twa: 0 });
  });

  it.each(["UNKNOWN", "ZERO"] as const)("retains omitted-level semantics %s without conflating zero and unknown", unlistedLevels => {
    const h = { ...wideHistory(), snapshotSemantics: { unlistedLevels, evidence: "MOCK explicit omission policy" } };
    const expected = compare(h, [query(0, 10, { priceTicks: 40000 }),
      query(3, 5, { priceTicks: 40000 }), query(3, 5)]);
    expect(expected[0].twa).toBe(unlistedLevels === "ZERO" ? 0 : null);
    expect(expected[2].twa).toBe(0);
  });

  it("keeps rounded partial coverage below one and exact huge BigInt prefixes", () => {
    const snapshot = depth({ ...F01.events[0], bids: [{ priceTicks: 80000, qty: Number.MAX_SAFE_INTEGER }] });
    const base = history([snapshot]), huge = 10n ** 30n;
    const timeline = transitionQuality(base.qualityState.timeline, "L2_MBP", "GAP",
      (origin + huge).toString(), "MOCK one-nanosecond final gap");
    const h = { ...base, qualityState: { ...base.qualityState, timeline } };
    const expected = compare(h, [query(0, 1, { endNs: (origin + huge + 1n).toString() }),
      query(0, 1, { startNs: (origin + huge - 1n).toString(), endNs: (origin + huge).toString() })]);
    expect(expected[0]).toMatchObject({ status: "NO DATA", coverageRatio: 1 - Number.EPSILON,
      partialTWA: Number.MAX_SAFE_INTEGER, coveredDuration: huge.toString(),
      integralQuantityNs: (huge * BigInt(Number.MAX_SAFE_INTEGER)).toString() });
    expect(expected[1]).toMatchObject({ status: "VALID", twa: Number.MAX_SAFE_INTEGER, coveredDuration: "1" });
  });

  it("does not apply or swallow a future out-of-depth update at the right endpoint", () => {
    const h = { ...history([F01.events[0]]), events: [F01.events[0],
      update(1_000_000_000n, 80, { priceTicks: 80001 })] };
    compare(h, [query(0, 1), query(0, 1, { endNs: (origin + 999_999_999n).toString() }), query(0, 1)]);
    const cells = [query(0, 1), query(0, 1, { endNs: (origin + 1_000_000_001n).toString() })];
    Object.defineProperty(cells, 2, { get() { throw new Error("Later query must not be read"); } });
    const expected = outcome(() => cells.map(cell => calculateTimeWeightedDepth(h, cell)));
    expect(outcome(() => runCells(h, cells))).toEqual(expected);
    expect(expected).toMatchObject({ message: "Update outside snapshot scope requires a new snapshot" });
  });

  it("does not replace a prefix overflow with a later invalid query or inspect subsequent cells", () => {
    const snapshot = depth({ ...F01.events[0],
      depthScope: { type: "PRICE_RANGE", minTick: 80000, maxTick: 80001 },
      bids: [{ priceTicks: 80000, qty: 1 }, { priceTicks: 80001, qty: 1 }] });
    const changes = [80000, 80001].map(priceTicks => update(1_000_000_000n, Number.MAX_SAFE_INTEGER,
      { priceTicks }));
    const h = { ...history([snapshot]), events: [snapshot, ...changes] };
    const cells = [query(0, 1, { width: 2 }), query(1, 2, { width: 2 })];
    Object.defineProperty(cells, 2, { get() { throw new Error("Later query must not be read"); } });
    const expected = outcome(() => cells.map(cell => calculateTimeWeightedDepth(h, cell)));
    expect(outcome(() => runCells(h, cells))).toEqual(expected);
    expect(expected).toMatchObject({ name: "RangeError", message: "Derived quantity exceeds safe Number output" });
  });

  it("validates a later cell even after a long cached prefix exists", () => {
    const cells = [query(), { ...query(0, 1), side: "BUY" } as unknown as DepthQuery];
    Object.defineProperty(cells, 2, { get() { throw new Error("Unreached cell"); } });
    expect(outcome(() => runCells(history(), cells)))
      .toEqual(outcome(() => cells.map(cell => calculateTimeWeightedDepth(history(), cell))));
  });

  it("keeps queries entirely before history unknown and does not inspect empty histories for []", () => {
    compare(history(), [query(-10, -5), query(-9, -8), query(0, 2)]);
    expect(runCells({} as DepthHistory, [])).toEqual([]);
  });

  it("does not share a prior call's quantity, quality or snapshot semantics", () => {
    const a = wideHistory(), b = history([depth({ ...F01.events[0], bids: [{ priceTicks: 80000, qty: 9 }] })]);
    const cells = [query(0, 1), query(0, 1)];
    expect(runCells(a, cells).map(result => result.twa)).toEqual([1, 1]);
    expect(runCells(b, cells).map(result => result.twa)).toEqual([9, 9]);
    expect(runCells(a, cells).map(result => result.twa)).toEqual([1, 1]);
  });

  it("keeps an uninitialized book unknown across several shared cells", () => {
    const h = { events: [], qualityState: initialState(F01.events[0]), qualityTimeAlignmentEvidence: alignment };
    const expected = compare(h, [query(0, 10), query(-1, 1), query(4, 5)]);
    for (const result of expected) {
      expect(result).toMatchObject({ status: "NO DATA", twa: null, partialTWA: null, coveredDuration: "0" });
    }
  });

  it("preserves negative floor-aligned buckets with a known zero component", () => {
    const snapshot = depth({ ...F01.events[0],
      depthScope: { type: "PRICE_RANGE", minTick: -2, maxTick: -1 },
      bids: [{ priceTicks: -2, qty: 40 }, { priceTicks: -1, qty: 0 }] });
    const h = history([snapshot]);
    const expected = compare(h, [query(0, 10, { width: 2, priceTicks: -1 }),
      query(2, 3, { width: 2, priceTicks: -2 }), query(-1, 1, { width: 2, priceTicks: -1 })]);
    expect(expected[0]).toMatchObject({ binId: -1, twa: 40 });
    expect(expected[1]).toMatchObject({ binId: -1, twa: 40 });
    expect(expected[2]).toMatchObject({ coverageRatio: .5, partialTWA: 40 });
  });

  function manyBoundaries(): DepthHistory {
    // Artificial records only; do not involve the ingestion guard's unrelated
    // immutable-history costs in this finite prefix-cap unit test.
    return { ...history([F01.events[0]]),
      events: [F01.events[0], ...Array.from({ length: 4096 }, (_, i) => update(BigInt(i + 1), i % 7))] };
  }

  it("falls back at 4096 boundaries, recomputes the whole cell, and never resumes that call's prefix", () => {
    const h = manyBoundaries();
    const cells = [4095n, 4096n, 4095n, 4097n].map(end =>
      query(0, 1, { endNs: (origin + end).toString() }));
    const expected = cells.map(cell => calculateTimeWeightedDepth(h, cell));
    const apply = vi.spyOn(mbpModule, "applyMbpEvent");
    try {
      expect(runCells(h, cells)).toEqual(expected);
      expect(apply.mock.calls.filter(([, event]) => (event as L2Snapshot).kind === "L2_SNAPSHOT")).toHaveLength(4);
    } finally { apply.mockRestore(); }
  });

  it("falls back even when the first cell reaches the ceiling and a later cell is tiny", () => {
    const h = manyBoundaries();
    const cells = [4096n, 1n].map(end => query(0, 1, { endNs: (origin + end).toString() }));
    const expected = cells.map(cell => calculateTimeWeightedDepth(h, cell));
    const apply = vi.spyOn(mbpModule, "applyMbpEvent");
    try {
      expect(runCells(h, cells)).toEqual(expected);
      expect(apply.mock.calls.filter(([, event]) => (event as L2Snapshot).kind === "L2_SNAPSHOT")).toHaveLength(2);
    } finally { apply.mockRestore(); }
  });

  it("does not swallow or transform an apply exception in the ceiling fallback", () => {
    const base = manyBoundaries();
    const h = { ...base, events: [base.events[0], update(1n, 80, { priceTicks: 80001 }), ...base.events.slice(2)] };
    const cells = [1n, 4096n].map(end => query(0, 1, { endNs: (origin + end).toString() }));
    const expected = outcome(() => cells.map(cell => calculateTimeWeightedDepth(h, cell)));
    expect(outcome(() => runCells(h, cells))).toEqual(expected);
    expect(expected).toMatchObject({ message: "Update outside snapshot scope requires a new snapshot" });
  });
});
