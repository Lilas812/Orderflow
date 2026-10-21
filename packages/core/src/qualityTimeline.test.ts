import { describe, expect, it } from "vitest";
import { F07_SEQUENCE_GAP as F07, F16_NO_L1 as F16 } from "../../fixtures/src/index";
import {
  createMarketQualityState, createQualityTimeline, currentMbpBook, currentQuality,
  ingestMarketEvent, ingestMbpBatch, markChannelCondition, readCurrentMbpLevel,
  resynchronizeMbp, transitionQuality,
  type MarketQualityConfig, type MarketQualityState, type QualityChannel, type QualityStatus,
} from "./qualityTimeline";
import { readMbpLevel } from "./mbpBook";
import { validateMarketEvent } from "./events";

const diagnostic = (globalThis as unknown as { console: { info(message: string): void } }).console;
function config(fixture = F07 as typeof F07 | typeof F16): MarketQualityConfig {
  const header = fixture.events[0].header;
  const rule = { scope: "CHANNEL", continuity: {
    contiguous: true, evidence: fixture.assumptions.continuityEvidence,
  } } as const;
  return {
    identity: { environment: header.environment, source: header.source, sourceId: header.sourceId,
      canonicalInstrumentId: header.canonicalInstrumentId, sessionId: header.sessionId },
    depthScope: { ...fixture.events[0].depthScope },
    rules: { L1: rule, L2_MBP: rule, TRADES: rule },
    snapshotAlignmentEvidence: fixture.assumptions.snapshotAlignmentEvidence,
  };
}
function fresh(fixture = F07 as typeof F07 | typeof F16) {
  return createMarketQualityState(config(fixture), fixture.startNs);
}
function statuses(state: MarketQualityState) {
  return {
    L1: currentQuality(state.timeline, "L1").status,
    L2_MBP: currentQuality(state.timeline, "L2_MBP").status,
    TRADES: currentQuality(state.timeline, "TRADES").status,
  };
}
function valid() { return ingestMarketEvent(fresh(), F07.events[0]).state; }
function gapped() {
  let state = fresh();
  for (const event of F07.events) state = ingestMarketEvent(state, event).state;
  return state;
}

describe("R03 immutable quality timeline", () => {
  it("starts with independent NOT_INITIALIZED lanes and no implicit zero quantity", () => {
    const state = fresh();
    expect(statuses(state)).toEqual({
      L1: "NOT_INITIALIZED", L2_MBP: "NOT_INITIALIZED", TRADES: "NOT_INITIALIZED",
    });
    expect(readCurrentMbpLevel(state, "BID", 80000)).toEqual({ status: "NOT_INITIALIZED", qty: null });
    expect(state.timeline.L1).not.toBe(state.timeline.L2_MBP);
  });

  it("retains precise half-open intervals and never rewrites a historical GAP", () => {
    const initial = createQualityTimeline("1767225600000000000");
    const gap = transitionQuality(initial, "L2_MBP", "GAP", "1767225600000000001", "Gap detected");
    const recovered = transitionQuality(gap, "L2_MBP", "VALID", "1767225600000000002", "Proof received");
    expect(recovered.L2_MBP.map((q) => [q.startNs, q.endNs, q.status])).toEqual([
      ["1767225600000000000", "1767225600000000001", "NOT_INITIALIZED"],
      ["1767225600000000001", "1767225600000000002", "GAP"],
      ["1767225600000000002", null, "VALID"],
    ]);
    expect(gap.L2_MBP[1].endNs).toBeNull();
    expect(initial.L2_MBP).toHaveLength(1);
    expect(recovered.L1).toBe(initial.L1);
  });

  it.each(["NOT_INITIALIZED", "VALID", "GAP", "STALE", "RESYNCING", "CLOSED", "OUTSIDE_DEPTH"] as const)(
    "supports explicit quality state %s", (status) => {
      const timeline = transitionQuality(createQualityTimeline("0"), "L1", status, "1", "MOCK condition");
      expect(currentQuality(timeline, "L1")).toMatchObject({ status, reason: "MOCK condition" });
    },
  );

  it("preserves simultaneous gap/recovery markers rather than deleting the gap", () => {
    const start = createQualityTimeline("0");
    const gap = transitionQuality(start, "L2_MBP", "GAP", "1", "Detected");
    const sync = transitionQuality(gap, "L2_MBP", "RESYNCING", "1", "Requested");
    expect(sync.L2_MBP[1]).toMatchObject({ status: "GAP", startNs: "1", endNs: "1" });
  });

  it("does not append an identical quality transition repeatedly", () => {
    const timeline = transitionQuality(createQualityTimeline("0"), "L1", "VALID", "1", "Ready");
    expect(transitionQuality(timeline, "L1", "VALID", "2", "Ready")).toBe(timeline);
  });

  it.each(["1.5", "1e18", "", " 1 ", "NaN"])("rejects invalid time %s", (time) => {
    expect(() => createQualityTimeline(time)).toThrow();
    expect(() => transitionQuality(createQualityTimeline("0"), "L1", "GAP", time, "Detected")).toThrow();
  });

  it("rejects backwards intervals, unknown channels/statuses, and missing reasons", () => {
    const timeline = createQualityTimeline("2");
    expect(() => transitionQuality(timeline, "L1", "GAP", "1", "Detected")).toThrow();
    expect(() => transitionQuality(timeline, "MBO" as QualityChannel, "GAP", "3", "Detected")).toThrow();
    expect(() => transitionQuality(timeline, "L1", "ZERO" as QualityStatus, "3", "Detected")).toThrow();
    expect(() => transitionQuality(timeline, "L1", "GAP", "3", "")).toThrow();
    expect(timeline.L1).toHaveLength(1);
  });
});

describe("R03 F-07 and F-16 diagnostic scenarios", () => {
  it("F-07: 10 valid -> 12 GAP affects L2 only, reconnect is insufficient, new snapshot recovers", () => {
    let state = fresh();
    const raw = JSON.stringify(F07);
    const table = [];
    for (const event of F07.events) {
      const outcome = ingestMarketEvent(state, event);
      state = outcome.state;
      table.push(statuses(state));
    }
    expect(table).toEqual(F07.expected);
    expect(currentMbpBook(state)).toBeNull();
    expect(readCurrentMbpLevel(state, "BID", 80000)).toEqual({ status: "GAP", qty: null });
    expect(readMbpLevel(state.lastGoodBook, "BID", 80000).qty).toBe(40);
    const beforeReconnect = state;
    state = markChannelCondition(state, "L2_MBP", "RESYNCING", F07.reconnectAtNs,
      "MOCK reconnect notification only; no transport connection");
    expect(statuses(state)).toEqual(F07.expectedAfterReconnect);
    expect(currentMbpBook(state)).toBeNull();
    const sync = resynchronizeMbp(state, F07.recovery);
    expect(sync.applied).toBe(true);
    expect(statuses(sync.state)).toEqual(F07.expectedAfterRecovery);
    expect(readCurrentMbpLevel(sync.state, "BID", 80000)).toEqual({ status: "KNOWN", qty: 40 });
    expect(sync.state.timeline.L2_MBP.find((q) => q.status === "GAP")).toMatchObject({
      startNs: "1767225603000000000", endNs: "1767225604000000000",
    });
    expect(beforeReconnect.timeline.L2_MBP.find((q) => q.status === "GAP")?.endNs).toBeNull();
    expect(JSON.stringify(F07)).toBe(raw);
    diagnostic.info(`MOCK F-07 event rows=${JSON.stringify(table)}; reconnect=${JSON.stringify(statuses(state))}; recovery=${JSON.stringify(statuses(sync.state))}`);
  });

  it("F-16: absent L1 is NO DATA, not zero, while L2 and TRADES remain independent", () => {
    let state = fresh(F16);
    const raw = JSON.stringify(F16);
    const table = [];
    for (const event of F16.events) {
      validateMarketEvent(event);
      state = ingestMarketEvent(state, event).state;
      table.push(statuses(state));
    }
    expect(table).toEqual(F16.expected);
    expect(state.timeline.L1).toHaveLength(1);
    expect(currentQuality(state.timeline, "L1").reason).toBe("No valid initial event");
    expect(currentMbpBook(state)).not.toBeNull();
    expect(JSON.stringify(F16)).toBe(raw);
    diagnostic.info(`MOCK F-16 event rows=${JSON.stringify(table)}; L1=NO DATA (not zero)`);
  });

  it.each([F07, F16])("has permanent JSON-compatible MOCK fixture metadata for $fixtureId", (fixture) => {
    expect(fixture.environment).toBe("MOCK");
    expect(fixture.seed).toBe(fixture.fixtureId === "F-07" ? 7 : 16);
    expect(fixture.expectedResultSchemaVersion).toBe(1);
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
    expect(fixture.events.map((e) => e.header.eventId)).toEqual(fixture.fixtureId === "F-07"
      ? ["MOCK-F-07-S10", "MOCK-F-07-T1", "MOCK-F-07-U12"] : ["MOCK-F-16-S10", "MOCK-F-16-T1"]);
    expect(fixture.events.every((e) => e.header.environment === "MOCK")).toBe(true);
  });
});

describe("R03 publication safety and independent channel conditions", () => {
  it("does not apply a duplicate twice, including a repeated gap event", () => {
    const state = valid();
    const duplicate = ingestMarketEvent(state, F07.events[0]);
    expect(duplicate.applied).toBe(false);
    expect(duplicate.outcome).toBe("DUPLICATE");
    expect(statuses(duplicate.state).L2_MBP).toBe("VALID");
    const gap = ingestMarketEvent(state, F07.events[2]);
    const again = ingestMarketEvent(gap.state, F07.events[2]);
    expect(again.outcome).toBe("DUPLICATE");
    expect(again.state.timeline).toBe(gap.state.timeline);
    expect(currentMbpBook(again.state)).toBeNull();
  });

  it("conflicting content for one ID invalidates the affected channel", () => {
    const state = ingestMarketEvent(valid(), F07.events[1]).state;
    const conflict = ingestMarketEvent(state, { ...F07.events[1], qty: 99 });
    expect(conflict.outcome).toBe("CONFLICT");
    expect(statuses(conflict.state)).toEqual({ L1: "NOT_INITIALIZED", L2_MBP: "VALID", TRADES: "GAP" });
    expect(currentMbpBook(conflict.state)).not.toBeNull();
  });

  it("late seq11 cannot automatically fill a gap or make the previous board current", () => {
    const state = gapped();
    const late = ingestMarketEvent(state, {
      ...F07.events[2], header: { ...F07.events[2].header, sequence: "11", eventId: "MOCK-LATE-11" },
    });
    expect(late.applied).toBe(false);
    expect(late.outcome).toBe("OLD");
    expect(statuses(late.state).L2_MBP).toBe("GAP");
    expect(readCurrentMbpLevel(late.state, "BID", 80000).qty).toBeNull();
  });

  it.each(["GAP", "STALE", "RESYNCING", "CLOSED", "OUTSIDE_DEPTH"] as const)(
    "does not publish a previous board during %s", (status) => {
      const state = markChannelCondition(valid(), "L2_MBP", status, "1767225602000000000", "MOCK notification");
      expect(currentMbpBook(state)).toBeNull();
      expect(readCurrentMbpLevel(state, "BID", 80000)).toEqual({ status, qty: null });
      expect(statuses(state).TRADES).toBe("NOT_INITIALIZED");
    },
  );

  it("notifications cannot directly restore VALID", () => {
    expect(() => markChannelCondition(gapped(), "L2_MBP",
      "VALID" as "RESYNCING", F07.reconnectAtNs, "Connected")).toThrow();
  });

  it("ordinary L2 updates before snapshot do not initialize a book", () => {
    const update = { ...F07.events[2], header: { ...F07.events[2].header, sequence: "1" } };
    const result = ingestMarketEvent(fresh(), update);
    expect(result.applied).toBe(false);
    expect(statuses(result.state).L2_MBP).toBe("NOT_INITIALIZED");
    expect(currentMbpBook(result.state)).toBeNull();
  });

  it("a genuine zero remains known before a gap, while GAP returns null not zero", () => {
    const start = valid();
    const zero = ingestMarketEvent(start, { ...F07.events[2], qty: 0,
      header: { ...F07.events[2].header, sequence: "11" } }).state;
    expect(readCurrentMbpLevel(zero, "BID", 80000)).toEqual({ status: "KNOWN", qty: 0 });
    const gap = ingestMarketEvent(zero, { ...F07.events[2],
      header: { ...F07.events[2].header, sequence: "13", eventId: "MOCK-GAP-13",
        receiveTimeNs: "1767225604000000000" } }).state;
    expect(readCurrentMbpLevel(gap, "BID", 80000)).toEqual({ status: "GAP", qty: null });
    expect(readMbpLevel(gap.lastGoodBook, "BID", 80000)).toEqual({ status: "KNOWN", qty: 0 });
  });

  it("records unverifiable sequencing in quality without claiming continuity", () => {
    const cfg = config();
    const unverified = createMarketQualityState({
      ...cfg, rules: { ...cfg.rules, TRADES: { scope: "NONE", continuity: { contiguous: false } } },
    }, F07.startNs);
    const trade = { ...F07.events[1], header: {
      ...F07.events[1].header, sequenceScope: "NONE", sequence: null,
    } };
    const outcome = ingestMarketEvent(unverified, trade);
    expect(outcome.applied).toBe(true);
    expect(currentQuality(outcome.state.timeline, "TRADES")).toMatchObject({
      status: "VALID", sequenceVerification: "UNVERIFIABLE", reason: "Sequence verification is unavailable",
    });
  });

  it("cannot certify an unsequenced L2 snapshot, and retains the failed-verification fact", () => {
    const cfg = config();
    const state = createMarketQualityState({
      ...cfg, rules: { ...cfg.rules, L2_MBP: { scope: "NONE", continuity: { contiguous: false } } },
    }, F07.startNs);
    const snapshot = { ...F07.events[0], snapshotCoversSequence: null,
      header: { ...F07.events[0].header, sequenceScope: "NONE", sequence: null } };
    const result = resynchronizeMbp(state, snapshot);
    expect(result.applied).toBe(false);
    expect(currentMbpBook(result.state)).toBeNull();
    expect(currentQuality(result.state.timeline, "L2_MBP")).toMatchObject({
      status: "RESYNCING", sequenceVerification: "UNVERIFIABLE",
    });
  });

  it("can initialize L1 independently and does not invalidate it when L2 gaps", () => {
    const l1 = {
      kind: "L1_QUOTE", header: { ...F07.events[0].header, channel: "L1",
        eventId: "MOCK-L1-1", sequence: "1" },
      bestBidTick: 80000, bestAskTick: 80001, bidQty: 0, askQty: null,
    };
    let state = ingestMarketEvent(fresh(), l1).state;
    state = ingestMarketEvent(state, F07.events[0]).state;
    state = ingestMarketEvent(state, F07.events[2]).state;
    expect(statuses(state)).toEqual({ L1: "VALID", L2_MBP: "GAP", TRADES: "NOT_INITIALIZED" });
  });
});

describe("R03 snapshot validation and recovery", () => {
  it("accepts an ordinary consecutive update after a successful recovery", () => {
    const sync = resynchronizeMbp(gapped(), F07.recovery);
    const next = ingestMarketEvent(sync.state, {
      ...F07.events[2], qty: 25, header: { ...F07.events[2].header,
        sequence: "14", eventId: "MOCK-POST-RECOVERY-14",
        exchangeTimeNs: "1767225606000000000", receiveTimeNs: "1767225606000000000" },
    });
    expect(next.applied).toBe(true);
    expect(readCurrentMbpLevel(next.state, "BID", 80000)).toEqual({ status: "KNOWN", qty: 25 });
    expect(next.state.timeline.L2_MBP.some((q) => q.status === "GAP")).toBe(true);
  });

  it("a structurally inconsistent matching snapshot suspends publication even from VALID", () => {
    const state = valid();
    const rejected = resynchronizeMbp(state, {
      ...F07.recovery, bids: [...F07.recovery.bids, ...F07.recovery.bids],
    });
    expect(rejected.applied).toBe(false);
    expect(statuses(rejected.state).L2_MBP).toBe("RESYNCING");
    expect(currentMbpBook(rejected.state)).toBeNull();
    expect(readMbpLevel(rejected.state.lastGoodBook, "BID", 80000).qty).toBe(40);
    expect(currentMbpBook(state)).not.toBeNull();
  });

  it.each([
    { canonicalInstrumentId: "CME:NQ:2026-06" },
    { sourceId: "MOCK-OTHER-SOURCE" }, { sessionId: "MOCK-OTHER-SESSION" },
    { sequenceScope: "INSTRUMENT" },
  ])("rejects a snapshot from a different identity/scope %j", (patch) => {
    const state = gapped();
    const result = resynchronizeMbp(state, { ...F07.recovery,
      header: { ...F07.recovery.header, ...patch } });
    expect(result.applied).toBe(false);
    expect(statuses(result.state).L2_MBP).toBe("GAP");
    expect(currentMbpBook(result.state)).toBeNull();
  });

  it.each([
    { depthScope: { type: "FULL" } }, { depthScope: { type: "TOP_N", n: 10 } },
    { depthScope: { type: "PRICE_RANGE", minTick: 79999, maxTick: 80000 } },
    { snapshotCoversSequence: null }, { snapshotCoversSequence: "12" },
    { header: { ...F07.recovery.header, sequence: "11" }, snapshotCoversSequence: "11" },
    { header: { ...F07.recovery.header, quality: "SUSPECT" } },
    { bids: [...F07.recovery.bids, ...F07.recovery.bids] },
    { bids: [{ priceTicks: 80001, qty: 10 }] },
  ])("does not restore from invalid/insufficient snapshot proof %#", (patch) => {
    const state = gapped();
    const result = resynchronizeMbp(state, { ...F07.recovery, ...patch });
    expect(result.applied).toBe(false);
    expect(["GAP", "RESYNCING"]).toContain(statuses(result.state).L2_MBP);
    expect(currentMbpBook(result.state)).toBeNull();
  });

  it("rejects malformed snapshot input without altering the old immutable state", () => {
    const state = gapped();
    const timeline = JSON.stringify(state.timeline);
    expect(() => resynchronizeMbp(state, { ...F07.recovery, bids: [{ priceTicks: 80000, qty: -1 }] })).toThrow();
    expect(JSON.stringify(state.timeline)).toBe(timeline);
    expect(currentMbpBook(state)).toBeNull();
  });

  it("a conflicting recovery snapshot ID cannot leave the channel VALID", () => {
    const state = valid();
    const result = resynchronizeMbp(state, { ...F07.recovery,
      header: { ...F07.recovery.header, eventId: F07.events[0].header.eventId } });
    expect(result.applied).toBe(false);
    expect(currentMbpBook(result.state)).toBeNull();
  });

  it("different contracts cannot be mixed into a current board", () => {
    const state = valid();
    const result = ingestMarketEvent(state, { ...F07.events[2],
      header: { ...F07.events[2].header, canonicalInstrumentId: "CME:NQ:2026-06" } });
    expect(result.outcome).toBe("IDENTITY_MISMATCH");
    expect(result.state).toBe(state);
    expect(readCurrentMbpLevel(result.state, "BID", 80000).qty).toBe(40);
  });

  it("an unexpected sequenceScope is rejected and makes verification failure visible", () => {
    const state = valid();
    const result = ingestMarketEvent(state, { ...F07.events[2],
      header: { ...F07.events[2].header, sequenceScope: "INSTRUMENT" } });
    expect(result.applied).toBe(false);
    expect(currentQuality(result.state.timeline, "L2_MBP")).toMatchObject({
      status: "GAP", sequenceVerification: "UNVERIFIABLE",
    });
  });
});

describe("R03 preserves R02 atomic batch behavior", () => {
  const update = F07.events[2];
  function batch() {
    return [
      { ...update, qty: 70, updateBatchId: "MOCK-R03-BATCH",
        header: { ...update.header, sequence: "11", eventId: "MOCK-B11" } },
      { ...update, qty: 0, updateBatchId: "MOCK-R03-BATCH",
        header: { ...update.header, sequence: "12", eventId: "MOCK-B12" } },
    ];
  }

  it("applies a complete consecutive batch atomically and skips its full retransmission", () => {
    const initial = valid();
    const input = batch();
    const raw = JSON.stringify(input);
    const result = ingestMbpBatch(initial, input);
    expect(result.applied).toBe(true);
    expect(readCurrentMbpLevel(result.state, "BID", 80000)).toEqual({ status: "KNOWN", qty: 0 });
    expect(readCurrentMbpLevel(initial, "BID", 80000).qty).toBe(40);
    expect(JSON.stringify(input)).toBe(raw);
    expect(ingestMbpBatch(result.state, input).outcome).toBe("DUPLICATE");
  });

  it("a later gap in the batch prevents publication of any intermediate board", () => {
    const initial = valid();
    const [first, second] = batch();
    const result = ingestMbpBatch(initial, [first, {
      ...second, header: { ...second.header, sequence: "13" },
    }]);
    expect(result.applied).toBe(false);
    expect(result.outcome).toBe("GAP");
    expect(currentMbpBook(result.state)).toBeNull();
    expect(readMbpLevel(result.state.lastGoodBook, "BID", 80000).qty).toBe(40);
  });

  it("a partial-duplicate batch cannot publish only a suffix", () => {
    const initial = valid();
    const [first, second] = batch();
    const firstState = ingestMbpBatch(initial, [first]).state;
    const result = ingestMbpBatch(firstState, [first, second]);
    expect(result.applied).toBe(false);
    expect(currentMbpBook(result.state)).toBeNull();
    expect(readMbpLevel(result.state.lastGoodBook, "BID", 80000).qty).toBe(70);
    const staleSnapshot = resynchronizeMbp(result.state, {
      ...F07.recovery, snapshotCoversSequence: "11",
      header: { ...F07.recovery.header, sequence: "11" },
    });
    expect(staleSnapshot.applied).toBe(false);
    expect(currentMbpBook(staleSnapshot.state)).toBeNull();
  });

  it("mixed logical batch IDs and out-of-depth prices are rejected without applying quantities", () => {
    const initial = valid();
    const [first, second] = batch();
    for (const bad of [
      { ...second, updateBatchId: "MOCK-OTHER-BATCH" },
      { ...second, priceTicks: 80001 },
    ]) {
      const result = ingestMbpBatch(initial, [first, bad]);
      expect(result.applied).toBe(false);
      expect(readMbpLevel(result.state.lastGoodBook, "BID", 80000).qty).toBe(40);
      expect(currentMbpBook(result.state)).toBeNull();
    }
  });
});
