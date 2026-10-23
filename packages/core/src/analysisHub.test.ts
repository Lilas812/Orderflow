import { describe, expect, it, vi } from "vitest";
import {
  F01_BOOK as F01, F02_TWO_TICKS as F02, F04_TRADES as F04,
  F05_TRADES as F05, F07_SEQUENCE_GAP as F07,
  UNIFIED_MOCK_STREAM as unified,
} from "../../fixtures/src/index";
import {
  createAnalysisHub, analysisInputBytes, type AnalysisScope, type AnalysisInput,
  type AnalysisBudget,
} from "./analysisHub";
import { validateMarketEvent, type MarketEvent, type DataQualityInterval } from "./events";
import {
  createMarketQualityState, ingestMarketEvent, ingestMbpBatch, currentQuality, currentMbpBook,
} from "./qualityTimeline";
import { createTradeStore, ingestTrade } from "./tradeStore";
import { calculateTimeWeightedDepth } from "./timeWeightedDepth";
import { aggregateTrades } from "./bubbleAggregate";
import { VolumeProfileAccumulator } from "./volumeProfile";
import * as sharedBubbleModule from "./bubbleFinality";
import * as sharedDeltaModule from "./deltaTimeline";
import { type AnalysisScope as SharedScope } from "./analysisHub";
import { VolumeProfileAccumulator as ProfileOracle } from "./volumeProfile";
import * as twaModule from "./timeWeightedDepth";

const alignment = "MOCK-only explicit event/quality axis alignment; not vendor evidence";
const limits: AnalysisBudget = {
  inputs: 100, normalizedBytes: 200_000, depthRecords: 100, depthEvents: 100,
  trades: 100, rawDeliveries: 100, qualityNotifications: 100,
  qualityIntervals: 300, dedupEntries: 200, bookLevels: 100,
};

describe("single-stream lightweight projection boundary", () => {
  const create = (patch: Partial<SharedScope> = {}, clock = () => 0) =>
    createAnalysisHub({ ...unified.scope, ...patch }, clock);
  const run = (hub: ReturnType<typeof create>) => unified.inputs.forEach(input =>
    expect(hub.ingest(input).disposition).toBe("ACCEPTED"));
  const assertNoHistory = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    expect(value).not.toBeInstanceOf(Map);
    expect(value).not.toHaveProperty("rawEvents");
    expect(value).not.toHaveProperty("trades");
    expect(value).not.toHaveProperty("kind", "TRADE");
    for (const [key, child] of Object.entries(value)) {
      // usage.trades is a bounded scalar count, never a retained Trade array.
      if (key === "usage") continue;
      assertNoHistory(child);
    }
  };
  it("uses one scope/session/time axis and reproduces all independent expected values", () => {
    const hub = create(); run(hub);
    const frame = hub.readRenderFrame(unified.query), expected = unified.expected;
    expect(frame.counts).toEqual({ inputs: 13, accepted: 13, duplicate: 0, rejected: 0 });
    expect(frame.usage.trades).toBe(expected.acceptedTrades);
    expect(frame.volumeProfile.value).toMatchObject({ pocTick: expected.pocTick,
      totals: { buyVolume: expected.B, sellVolume: expected.S, unknownVolume: expected.U, totalVolume: expected.volume },
      valueArea: { valTick: expected.valTick, vahTick: expected.vahTick, includedVolume: expected.valueAreaVolume } });
    expect(frame.heatmap.cells.map(cell => cell.twa)).toEqual(expected.bidTwa);
    expect(frame.heatmap.cells.map(cell => cell.coverageRatio)).toEqual(expected.coverage);
    expect(frame.delta.items.map(bin => bin.delta)).toEqual(expected.delta);
    expect(frame.bubbles.items.every(b => b.bucket.scope.sessionId === frame.scope.sessionId)).toBe(true);
    expect(frame.delta.items.every(b => b.scope.sessionId === frame.scope.sessionId)).toBe(true);
    assertNoHistory(frame);
  });
  it("shares the exact authoritative Store with BOTH sequential projections", () => {
    const bubbleSpy = vi.spyOn(sharedBubbleModule, "projectAcceptedBubbleState");
    const deltaSpy = vi.spyOn(sharedDeltaModule, "projectAcceptedDeltaState");
    try {
      const hub = create(); run(hub);
      expect(bubbleSpy).toHaveBeenCalledTimes(unified.inputs.length);
      expect(deltaSpy).toHaveBeenCalledTimes(unified.inputs.length);
      for (let i = 0; i < bubbleSpy.mock.calls.length; i++) {
        const store = bubbleSpy.mock.calls[i][1];
        expect(deltaSpy.mock.calls[i][1].store).toBe(store);
      }
    } finally { bubbleSpy.mockRestore(); deltaSpy.mockRestore(); }
  });
  it("continues Trades during L2 GAP and Snapshot recovers L2 only", () => {
    const hub = create();
    unified.inputs.slice(0, 7).forEach(input => hub.ingest(input));
    expect(hub.readRenderFrame(unified.query).quality.channels.L2_MBP.status).toBe("GAP");
    expect(hub.ingest(unified.inputs[7]).tradeDisposition).toBe("ACCEPTED");
    const gap = hub.readRenderFrame(unified.query);
    expect(gap.volumeProfile.value!.totals.totalVolume).toBe(27n);
    expect(gap.quality.channels.TRADES.status).toBe("VALID");
    hub.ingest(unified.inputs[8]);
    const recovered = hub.readRenderFrame(unified.query);
    expect(recovered.quality.channels.L2_MBP.status).toBe("VALID");
    expect(recovered.quality.channels.TRADES).toEqual(gap.quality.channels.TRADES);
    expect(recovered.volumeProfile.value!.totals).toEqual(gap.volumeProfile.value!.totals);
  });
  it("an L2 Snapshot cannot recover an invalid TRADES channel", () => {
    const hub = create();
    unified.inputs.slice(0, 9).forEach(input => hub.ingest(input));
    const at = (BigInt(unified.scope.startNs) + 8_000_000_000n).toString();
    hub.ingest({ type: "CONDITION", channel: "TRADES", atNs: at, status: "GAP", reason: "Artificial Trade interruption" });
    const before = hub.readRenderFrame(unified.query);
    const snap = unified.inputs[8].event;
    expect(hub.ingest({ type: "EVENT", event: { ...snap, snapshotCoversSequence: "5",
      header: { ...snap.header, sequence: "5", eventId: "MOCK-UNIFIED-RECOVERY-5",
        exchangeTimeNs: at, receiveTimeNs: at } } }).disposition).toBe("ACCEPTED");
    const after = hub.readRenderFrame(unified.query);
    expect(after.quality.channels.L2_MBP.status).toBe("VALID");
    expect(after.quality.channels.TRADES.status).toBe("GAP");
    expect(after.volumeProfile.value!.totals).toEqual(before.volumeProfile.value!.totals);
    expect(after.delta.items.every(bin => bin.delta === null)).toBe(true);
  });
  it("does not double count a duplicate Trade or reinterpret UNKNOWN Delta as zero", () => {
    const hub = create();
    unified.inputs.forEach((input, i) => {
      hub.ingest(input);
      if (i === 2) expect(hub.ingest(input).disposition).toBe("DUPLICATE");
    });
    const frame = hub.readRenderFrame(unified.query);
    expect(frame.volumeProfile.value!.totals.totalVolume).toBe(43n);
    expect(frame.counts.duplicate).toBe(1);
    expect(frame.delta.items[4]).toMatchObject({ delta: null, U: 3n, quality: "INCOMPLETE" });
  });
  it("keeps a known zero interval distinct from an adjacent L2 GAP", () => {
    const hub = create(); run(hub);
    const at = (s: number) => (BigInt(unified.scope.startNs) + BigInt(s) * 1_000_000_000n).toString();
    const frame = hub.readRenderFrame({ ...unified.query, cells: [4, 5].map(s => ({
      side: "BID", priceTicks: 80000, width: 1, startNs: at(s), endNs: at(s + 1),
    })) });
    expect(frame.heatmap.cells[0]).toMatchObject({ status: "VALID", twa: 0, coverageRatio: 1 });
    expect(frame.heatmap.cells[1]).toMatchObject({ status: "NO DATA", twa: null, coverageRatio: 0 });
  });
  it("matches existing R08/R09/R11/VP computations, not a second acceptance path", () => {
    const hub = create(); run(hub);
    const legacy = hub.read(), frame = hub.readRenderFrame(unified.query);
    expect(frame.bubbles.items.map(b => b.bucket)).toEqual(aggregateTrades(legacy.tradeStore));
    const vp = new ProfileOracle(unified.scope.config.identity, { maxPriceLevels: 64 });
    legacy.tradeStore.trades.forEach(t => vp.prepareAccepted(t)());
    expect(frame.volumeProfile.value!.valueArea).toEqual(vp.read().valueArea);
    const bubble = sharedBubbleModule.projectAcceptedBubbleState(null, legacy.tradeStore, "VALID");
    const delta = sharedDeltaModule.projectAcceptedDeltaState(null, bubble, {
      scope: legacy.tradeStore.scope, timeAxis: "EXCHANGE_TIME_NS", evidence: alignment,
    });
    expect(frame.delta.items.map(b => [b.B, b.S, b.U, b.delta]))
      .toEqual(sharedDeltaModule.queryDeltaTimeline(delta, unified.query.startNs, unified.query.endNs)
        .map(b => [b.B, b.S, b.U, b.delta]));
  });
  it("publishes at most once per 250ms without affecting final accepted results", () => {
    let clock = 0;
    const a = create({}, () => clock), b = create();
    const revisions: number[] = [];
    unified.inputs.forEach((input, i) => {
      expect(a.ingest(input)).toEqual(b.ingest(input));
      clock = i * 25;
      const n = a.pollNotice();
      if (n) revisions.push(n.revision);
    });
    expect(revisions).toEqual([1, 11]);
    clock += 250;
    expect(a.pollNotice()!.revision).toBe(13);
    expect(a.readRenderFrame(unified.query)).toEqual(b.readRenderFrame(unified.query));
  });
  it("keeps the legacy full notification cursor independent and unchanged", () => {
    const hub = create(); hub.ingest(unified.inputs[0]);
    expect(hub.pollNotice()!.revision).toBe(1);
    expect(hub.pollNotification()!.revision).toBe(1);
    expect(hub.pollNotice()).toBeNull();
    expect(hub.pollNotification()).toBeNull();
  });
  it("never replays shared Trade aggregation or finality during reads/notifications", () => {
    const hub = create(); run(hub);
    const bubbles = vi.spyOn(sharedBubbleModule, "projectAcceptedBubbleState");
    const delta = vi.spyOn(sharedDeltaModule, "projectAcceptedDeltaState");
    const query = vi.spyOn(sharedDeltaModule, "queryDeltaTimeline");
    try {
      hub.pollNotice();
      hub.readRenderFrame(unified.query);
      hub.readRenderFrame({ ...unified.query, cells: [] });
      expect(bubbles).not.toHaveBeenCalled();
      expect(delta).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    } finally { bubbles.mockRestore(); delta.mockRestore(); query.mockRestore(); }
  });
  it("does not clone historical Trade Maps when lightweight notification/frame is requested", () => {
    const hub = createAnalysisHub(definition(F04.events[0], {
      volumeProfile: { maxPriceLevels: 64 }, derivedViews: unified.scope.derivedViews,
    }), () => 0);
    F04.events.forEach(t => hub.ingest(envelope(t)));
    const iterator = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(() => {
      throw new Error("Artificial historical Map copy trap");
    });
    try {
      expect(hub.pollNotice()!.revision).toBe(3);
      const frame = hub.readRenderFrame({ startNs: F04.expected.startNs, endNs: F04.expected.endNs, cells: [] });
      expect(frame.volumeProfile.value!.totals.totalVolume).toBe(27n);
      expect(() => hub.read()).toThrow("Artificial historical Map copy trap");
    } finally { iterator.mockRestore(); }
  });
  it("caches one immutable revision/query result and reprojects a new range without input", () => {
    const hub = create(); run(hub);
    const before = hub.readRenderFrame(unified.query);
    expect(hub.readRenderFrame(unified.query)).toBe(before);
    const changed = hub.readRenderFrame({ ...unified.query, cells: [] });
    expect(changed.revision).toBe(before.revision);
    expect(changed.heatmap.cells).toEqual([]);
    for (const part of [before.book, before.heatmap, before.bubbles, before.delta, before.volumeProfile, before.quality]) {
      expect(part.revision).toBe(before.revision);
    }
    expect(Object.isFrozen(before)).toBe(true);
    expect(() => { (before.bubbles.items as unknown[]).push({}); }).toThrow();
    expect(hub.readRenderFrame(unified.query)).toEqual(before);
  });
  it("a TWA projection exception publishes no partial frame or cache entry", () => {
    const hub = create(); run(hub);
    const before = hub.readRenderFrame(unified.query);
    const spy = vi.spyOn(twaModule, "calculateTimeWeightedDepth").mockImplementationOnce(() => {
      throw new Error("Artificial TWA failure");
    });
    try {
      expect(() => hub.readRenderFrame({ ...unified.query, cells: [unified.query.cells[0]] })).toThrow("Artificial TWA failure");
    } finally { spy.mockRestore(); }
    expect(hub.readRenderFrame(unified.query)).toBe(before);
  });
  it("rejects a reentrant revision change rather than publishing mixed derived results", () => {
    const hub = create();
    unified.inputs.slice(0, 3).forEach(input => hub.ingest(input));
    const original = twaModule.calculateTimeWeightedDepth;
    const spy = vi.spyOn(twaModule, "calculateTimeWeightedDepth").mockImplementationOnce((...args) => {
      hub.ingest(unified.inputs[3]);
      return original(...args);
    });
    try {
      expect(() => hub.readRenderFrame(unified.query)).toThrow("Analysis revision changed");
    } finally { spy.mockRestore(); }
    expect(hub.readRenderFrame(unified.query).revision).toBe(4);
  });
  it("VP commit failure cannot publish already prepared bubble/Delta candidates", () => {
    const hub = create();
    unified.inputs.slice(0, 2).forEach(input => hub.ingest(input));
    const before = hub.readRenderFrame(unified.query);
    const spy = vi.spyOn(VolumeProfileAccumulator.prototype, "prepareAccepted")
      .mockImplementationOnce(() => () => { throw new Error("Artificial VP commit failure"); });
    try { expect(hub.ingest(unified.inputs[2]).outcome).toBe("INVALID_INPUT"); }
    finally { spy.mockRestore(); }
    const after = hub.readRenderFrame(unified.query);
    expect(after.stateRevision).toBe(before.stateRevision);
    expect(after.bubbles.items).toEqual(before.bubbles.items);
    expect(after.delta.items).toEqual(before.delta.items);
    expect(after.volumeProfile.value!.totals).toEqual(before.volumeProfile.value!.totals);
    expect(hub.ingest(unified.inputs[2]).disposition).toBe("ACCEPTED");
  });
  it.each(["projectAcceptedBubbleState", "projectAcceptedDeltaState"] as const)(
    "%s failure publishes no partial Store, VP, quality or derived result", method => {
      const hub = create();
      unified.inputs.slice(0, 3).forEach(input => hub.ingest(input));
      const legacy = hub.read(), frame = hub.readRenderFrame(unified.query);
      const fail = () => { throw new Error("Artificial shared projection failure"); };
      const spy = method === "projectAcceptedBubbleState" ?
        vi.spyOn(sharedBubbleModule, "projectAcceptedBubbleState").mockImplementationOnce(fail) :
        vi.spyOn(sharedDeltaModule, "projectAcceptedDeltaState").mockImplementationOnce(fail);
      try {
        expect(hub.ingest(unified.inputs[3])).toMatchObject({ disposition: "REJECTED", outcome: "PROJECTION_FAILED" });
      } finally { spy.mockRestore(); }
      const failed = hub.readRenderFrame(unified.query);
      expect(failed.status).toBe("STOPPED");
      expect(failed.stateRevision).toBe(frame.stateRevision);
      expect(failed.bubbles.items).toEqual(frame.bubbles.items);
      expect(failed.delta.items).toEqual(frame.delta.items);
      expect(failed.volumeProfile.value!.totals).toEqual(frame.volumeProfile.value!.totals);
      expect(hub.read().tradeStore).toEqual(legacy.tradeStore);
      expect(hub.read().qualityState).toEqual(legacy.qualityState);
    },
  );
  it.each(["maxBubbles", "maxDeltaBins"] as const)("bounds %s before publishing candidates", key => {
    const hub = create({ derivedViews: { ...unified.scope.derivedViews!, [key]: 0 } });
    hub.ingest(unified.inputs[0]); hub.ingest(unified.inputs[1]);
    const before = hub.read();
    expect(hub.ingest(unified.inputs[2]).outcome).toBe("BUDGET_EXCEEDED");
    expect(hub.read().tradeStore).toEqual(before.tradeStore);
    expect(hub.readVolumeProfile()!.totals.totalVolume).toBe(0n);
  });
  it("bounds read queries before allocating, without advancing input state", () => {
    const hub = create(); run(hub);
    const before = hub.readRenderFrame(unified.query);
    expect(() => hub.readRenderFrame({ ...unified.query, cells: Array(513).fill(unified.query.cells[0]) })).toThrow();
    expect(() => hub.readRenderFrame({ startNs: unified.query.startNs,
      endNs: (BigInt(unified.query.startNs) + 61_000_000_000n).toString(), cells: [] })).toThrow();
    expect(hub.readRenderFrame(unified.query)).toBe(before);
  });
  it("does not turn unobserved future depth/Delta into held liquidity or zeros", () => {
    const hub = create(); hub.ingest(unified.inputs[0]);
    const frame = hub.readRenderFrame(unified.query);
    expect(frame.heatmap.cells.every(cell => cell.status === "NO DATA")).toBe(true);
    expect(frame.delta.items).toEqual([]);
  });
  it("exposes unknown alignment conservatively without reusing another fixture's clock", () => {
    const hub = create({ depthTimeAlignmentEvidence: null, tradeTimeAlignmentEvidence: null });
    run(hub);
    const frame = hub.readRenderFrame(unified.query);
    expect(frame.heatmap).toMatchObject({ status: "ALIGNMENT_UNKNOWN", cells: [] });
    expect(frame.delta.items.every(bin => bin.delta === null)).toBe(true);
    expect(frame.volumeProfile.value!.marketCompleteness).toBe("NOT_ASSERTED");
  });
  it("legacy disabled-derived scopes keep acceptance and VP quantities unchanged", () => {
    const a = create(), b = create({ derivedViews: undefined });
    unified.inputs.forEach(input => expect(a.ingest(input)).toEqual(b.ingest(input)));
    expect(a.read()).toMatchObject({ tradeStore: b.read().tradeStore, qualityState: b.read().qualityState });
    expect(a.readVolumeProfile()).toEqual(b.readVolumeProfile());
    expect(() => b.readRenderFrame(unified.query)).toThrow("Derived views are not enabled");
  });
});

describe("read-time Value Area through the analysis hub", () => {
  it("exposes F04 VA through the existing API and preserves observed-only quality", () => {
    const hub = createAnalysisHub(definition(F04.events[0],
      { volumeProfile: { maxPriceLevels: 4 } }), () => 0);
    F04.events.forEach(t => hub.ingest(envelope(t)));
    expect(hub.readVolumeProfile()).toMatchObject({
      revision: 3, marketCompleteness: "NOT_ASSERTED",
      valueArea: { ratioNumerator: 7n, ratioDenominator: 10n,
        valTick: 80000, vahTick: 80000, includedVolume: 27n },
    });
    const before = hub.read(), first = hub.readVolumeProfile()!, next = hub.readVolumeProfile()!;
    expect(hub.read()).toEqual(before);
    expect(first).toEqual(next);
    expect(first.valueArea).not.toBe(next.valueArea);
    expect(Object.isFrozen(first.valueArea)).toBe(true);
  });
  it("does not include a Trade rejected by the price-level budget in VA", () => {
    const hub = createAnalysisHub(definition(F04.events[0],
      { volumeProfile: { maxPriceLevels: 1 } }), () => 0);
    hub.ingest(envelope(F04.events[0]));
    const before = hub.readVolumeProfile()!;
    expect(hub.ingest(envelope({ ...F04.events[1], priceTicks: 80001 })).outcome)
      .toBe("BUDGET_EXCEEDED");
    const after = hub.readVolumeProfile()!;
    expect(after.valueArea).toEqual(before.valueArea);
    expect(after.totals).toEqual(before.totals);
    expect(after.status).toBe("STOPPED");
  });
  it("does not include a Trade rejected by the existing Trade budget in VA", () => {
    const hub = createAnalysisHub(definition(F04.events[0], {
      volumeProfile: { maxPriceLevels: 4 }, budget: { ...limits, trades: 1 },
    }), () => 0);
    hub.ingest(envelope(F04.events[0]));
    const before = hub.readVolumeProfile()!;
    expect(hub.ingest(envelope({ ...F04.events[1], priceTicks: 80001 })).stop?.limit).toBe("trades");
    expect(hub.readVolumeProfile()!.valueArea).toEqual(before.valueArea);
  });
  it("keeps disabled VP null before and after all normal hub inputs", () => {
    const hub = createAnalysisHub(definition(F04.events[0]), () => 0);
    expect(hub.readVolumeProfile()).toBeNull();
    F04.events.forEach(t => {
      expect(hub.ingest(envelope(t)).disposition).toBe("ACCEPTED");
      expect(hub.readVolumeProfile()).toBeNull();
    });
    expect(hub.read().scope.volumeProfile).toBeUndefined();
  });
});

describe("opt-in incremental Volume Profile connection", () => {
  const create = (patch: Partial<AnalysisScope> = {}) => createAnalysisHub(
    definition(F04.events[0], { volumeProfile: { maxPriceLevels: 4 }, ...patch }), () => 0);
  it("publishes F04 volume exactly once at the hub's accepted revision", () => {
    const hub = create();
    F04.events.forEach(t => expect(hub.ingest(envelope(t)).disposition).toBe("ACCEPTED"));
    expect(hub.readVolumeProfile()).toMatchObject({
      label: "MOCK / SIMULATED", revision: 3, status: "RUNNING", pocTick: 80000,
      totals: { buyVolume: 23n, sellVolume: 4n, unknownVolume: 0n, totalVolume: 27n, tradeCount: 3 },
    });
  });
  it("neither event retransmissions nor economic retransmissions are counted again", () => {
    const hub = create(), first = F04.events[0];
    hub.ingest(envelope(first));
    expect(hub.ingest(envelope(first)).disposition).toBe("DUPLICATE");
    expect(hub.ingest(envelope({ ...first,
      header: { ...first.header, eventId: "vp-resend", sequence: "2" } })).disposition).toBe("DUPLICATE");
    expect(hub.readVolumeProfile()!.totals).toMatchObject({ totalVolume: 12n, tradeCount: 1 });
  });
  it("uses existing conflict rejection and exposes its quality without adding volume", () => {
    const hub = create(), first = F04.events[0];
    hub.ingest(envelope(first));
    expect(hub.ingest(envelope({ ...first, qty: F04.events[1].qty,
      header: { ...first.header, eventId: "vp-conflict", sequence: "2" } })).tradeDisposition)
      .toBe("CONFLICTING_TRADE_ID");
    expect(hub.readVolumeProfile()).toMatchObject({ totals: { totalVolume: 12n },
      quality: { channel: { status: "GAP" }, issues: [{ code: "CONFLICTING_TRADE_ID" }] } });
  });
  it.each(["TRADE_CORRECTION", "TRADE_CANCEL"] as const)("audits %s without replacing/subtracting", kind => {
    const hub = create(), first = F04.events[0];
    hub.ingest(envelope(first));
    const revision = { ...first, kind, originalTradeId: first.tradeId,
      header: { ...first.header, eventId: `vp-${kind}`, sequence: "2" } };
    expect(hub.ingest(envelope(revision)).outcome).toBe("UNSUPPORTED_REVISION");
    expect(hub.readVolumeProfile()).toMatchObject({ totals: { totalVolume: 12n, tradeCount: 1 },
      quality: { channel: { status: "GAP" }, issues: [{ code: "UNSUPPORTED_REVISION" }] } });
  });
  it("keeps independent source/contract/session scopes separate", () => {
    const hub = create(), other = createAnalysisHub(
      definition(F05.events[0], { volumeProfile: { maxPriceLevels: 4 } }), () => 0);
    F04.events.forEach(t => hub.ingest(envelope(t)));
    F05.events.forEach(t => other.ingest(envelope(t)));
    const before = hub.readVolumeProfile()!;
    expect(hub.ingest(envelope(F05.events[0])).disposition).toBe("REJECTED");
    expect(hub.readVolumeProfile()!.totals).toEqual(before.totals);
    expect(other.readVolumeProfile()!.scope.sessionId).not.toBe(before.scope.sessionId);
    expect(other.readVolumeProfile()!.totals.totalVolume).toBe(BigInt(F05.expected.totalVolume));
  });
  it("increments UNKNOWN volume and does not label unknown coverage as complete", () => {
    const hub = create({ tradeTimeAlignmentEvidence: null });
    const first = F04.events[0];
    hub.ingest(envelope({ ...first, aggressor: "UNKNOWN", classification: "UNKNOWN" }));
    expect(hub.readVolumeProfile()).toMatchObject({ marketCompleteness: "NOT_ASSERTED",
      totals: { unknownVolume: 12n, totalVolume: 12n },
      classificationComplete: false, quality: { timeAlignmentEvidence: null, intervals: [] } });
  });
  it("distinguishes zero observed volume from verified absence of market Trades", () => {
    const hub = create({ tradeTimeAlignmentEvidence: null });
    expect(hub.readVolumeProfile()).toMatchObject({ pocTick: null, marketCompleteness: "NOT_ASSERTED",
      totals: { totalVolume: 0n }, quality: { channel: { status: "NOT_INITIALIZED" } } });
  });
  it("includes delayed deliveries and is independent of equal-time Trade arrival order", () => {
    const results = [];
    for (const ordered of [F04.events, [...F04.events].reverse()]) {
      const hub = create();
      ordered.forEach((t, i) => {
        const event = { ...t, priceTicks: i % 2 ? 80001 : 80000,
          header: { ...t.header, sequence: String(i + 1),
            exchangeTimeNs: F04.events[0].header.exchangeTimeNs,
            receiveTimeNs: (BigInt(F04.events[2].header.receiveTimeNs) + BigInt(i)).toString() } };
        expect(hub.ingest(envelope(event)).disposition).toBe("ACCEPTED");
      });
      results.push(hub.readVolumeProfile()!.totals);
      expect(hub.readVolumeProfile()!.pocTick).toBe(80000);
    }
    expect(results[0]).toEqual(results[1]);
  });
  it("preserves the existing OLD rejection for backwards event time without adding VP volume", () => {
    const hub = create();
    const later = { ...F04.events[2], header: { ...F04.events[2].header, sequence: "1" } };
    expect(hub.ingest(envelope(later)).disposition).toBe("ACCEPTED");
    const before = hub.readVolumeProfile()!;
    const older = { ...F04.events[0], header: { ...F04.events[0].header, sequence: "2",
      receiveTimeNs: F04.events[2].header.receiveTimeNs } };
    expect(hub.ingest(envelope(older))).toMatchObject({ disposition: "REJECTED", outcome: "OLD" });
    expect(hub.readVolumeProfile()!.totals).toEqual(before.totals);
  });
  it("VP price-cap overflow atomically leaves guard, Trade state and VP unchanged and stops", () => {
    const hub = create({ volumeProfile: { maxPriceLevels: 1 } });
    hub.ingest(envelope(F04.events[0]));
    const before = hub.read(), vpBefore = hub.readVolumeProfile()!;
    const result = hub.ingest(envelope({ ...F04.events[1], priceTicks: 80001 }));
    expect(result).toMatchObject({ disposition: "REJECTED", outcome: "BUDGET_EXCEEDED",
      stop: { limit: "volumeProfilePriceLevels", maximum: 1, attempted: 2 } });
    expect(hub.read().tradeStore).toEqual(before.tradeStore);
    expect(hub.read().qualityState).toEqual(before.qualityState);
    expect(hub.readVolumeProfile()!.totals).toEqual(vpBefore.totals);
    expect(hub.readVolumeProfile()!.status).toBe("STOPPED");
    expect(hub.ingest(envelope(F04.events[1])).outcome).toBe("STOPPED");
  });
  it("an existing Trade budget failure never commits a VP candidate", () => {
    const hub = create({ budget: { ...limits, trades: 1 } });
    hub.ingest(envelope(F04.events[0]));
    const before = hub.read(), vpBefore = hub.readVolumeProfile()!;
    expect(hub.ingest(envelope(F04.events[1])).stop?.limit).toBe("trades");
    expect(hub.read().tradeStore).toEqual(before.tradeStore);
    expect(hub.read().qualityState).toEqual(before.qualityState);
    expect(hub.readVolumeProfile()!.totals).toEqual(vpBefore.totals);
  });
  it.each(["prepare", "commit"] as const)("a VP %s failure cannot advance Trade/guard state", phase => {
    const hub = create(), before = hub.read(), vpBefore = hub.readVolumeProfile()!;
    const spy = vi.spyOn(VolumeProfileAccumulator.prototype, "prepareAccepted")
      .mockImplementationOnce(() => {
        if (phase === "prepare") throw new Error("Artificial VP preparation failure");
        return () => { throw new Error("Artificial VP commit failure"); };
      });
    try {
      expect(hub.ingest(envelope(F04.events[0])).outcome).toBe("INVALID_INPUT");
      expect(hub.read().tradeStore).toEqual(before.tradeStore);
      expect(hub.read().qualityState).toEqual(before.qualityState);
      expect(hub.readVolumeProfile()!.totals).toEqual(vpBefore.totals);
    } finally { spy.mockRestore(); }
    expect(hub.ingest(envelope(F04.events[0])).disposition).toBe("ACCEPTED");
    expect(hub.readVolumeProfile()!.totals.totalVolume).toBe(12n);
  });
  it("a real VP Map write exception cannot publish only the hub's Trade candidate", () => {
    const hub = create(), before = hub.read(), vpBefore = hub.readVolumeProfile()!;
    const original = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function(
      this: Map<unknown, unknown>, key: unknown, value: unknown,
    ) {
      if (key === 80000) throw new Error("Artificial VP Map allocation failure");
      return original.call(this, key, value);
    });
    let result;
    try { result = hub.ingest(envelope(F04.events[0])); } finally { spy.mockRestore(); }
    expect(result).toMatchObject({ disposition: "REJECTED", outcome: "INVALID_INPUT" });
    expect(hub.read().tradeStore).toEqual(before.tradeStore);
    expect(hub.read().qualityState).toEqual(before.qualityState);
    expect(hub.readVolumeProfile()!.totals).toEqual(vpBefore.totals);
    expect(hub.ingest(envelope(F04.events[0])).disposition).toBe("ACCEPTED");
  });
  it("returns defensive copies without invoking the full hub read/Trade scan", () => {
    const hub = create();
    hub.ingest(envelope(F04.events[0]));
    const before = hub.readVolumeProfile()!, again = hub.readVolumeProfile()!;
    expect(before.quality.intervals).not.toBe(again.quality.intervals);
    expect(before.levels).not.toBe(again.levels);
    expect(Object.isFrozen(before)).toBe(true);
    hub.ingest(envelope(F04.events[1]));
    expect(before.totals.totalVolume).toBe(12n);
  });
  it("does not reinterpret missing exchange time or an L2 update as VP volume", () => {
    const hub = create();
    expect(hub.ingest(envelope({ ...F04.events[0],
      header: { ...F04.events[0].header, exchangeTimeNs: null } })).disposition).toBe("REJECTED");
    expect(hub.readVolumeProfile()!.totals.totalVolume).toBe(0n);
    const depth = createAnalysisHub(definition(F01.events[0],
      { volumeProfile: { maxPriceLevels: 1 } }), () => 0);
    depth.ingest(envelope(F01.events[0]));
    expect(depth.readVolumeProfile()!.totals.totalVolume).toBe(0n);
  });
  it("preserves disabled hub decisions, views and notifications exactly", () => {
    const a = createAnalysisHub(definition(F04.events[0]), () => 0);
    const b = create();
    expect(a.readVolumeProfile()).toBeNull();
    F04.events.forEach(t => expect(a.ingest(envelope(t))).toEqual(b.ingest(envelope(t))));
    const enabled = b.read();
    const { volumeProfile: _option, ...definitionWithoutVp } = enabled.scope;
    expect(a.read()).toEqual({ ...enabled, scope: definitionWithoutVp });
    expect(a.pollNotification()!.tradeStore).toEqual(b.pollNotification()!.tradeStore);
  });
});
function definition(first: MarketEvent = F01.events[0], patch: Partial<AnalysisScope> = {}): AnalysisScope {
  const h = first.header;
  const rule = { scope: "CHANNEL", continuity: { contiguous: true, evidence: "MOCK +1 channel order" } } as const;
  return {
    config: {
      identity: { environment: h.environment, source: h.source, sourceId: h.sourceId,
        canonicalInstrumentId: h.canonicalInstrumentId, sessionId: h.sessionId },
      depthScope: first.kind === "L2_SNAPSHOT" ? first.depthScope : { type: "FULL" },
      rules: { L1: rule, L2_MBP: rule, TRADES: rule },
      snapshotAlignmentEvidence: "MOCK header sequence == coverage sequence",
    },
    startNs: first.header.exchangeTimeNs!, budget: limits,
    depthTimeAlignmentEvidence: alignment, tradeTimeAlignmentEvidence: alignment, ...patch,
  };
}
const envelope = (event: MarketEvent): AnalysisInput => ({ type: "EVENT", event });
const parsed = (event: unknown) => validateMarketEvent(event);
const origin = BigInt(F01.expected.startNs);
const at = (s: number) => (origin + BigInt(s) * 1_000_000_000n).toString();
function coverage(first: MarketEvent = F04.events[0]): AnalysisInput {
  return { type: "QUALITY_INTERVAL", observedAtNs: first.header.receiveTimeNs, interval: {
    channel: "TRADES", startNs: F04.expected.startNs, endNs: F04.expected.endNs,
    status: "VALID", reason: "Explicit finite MOCK observation",
  } };
}
function query(start = 0, end = 10, width: 1 | 2 = 1) {
  return { side: "BID" as const, priceTicks: 80000, width, startNs: at(start), endNs: at(end) };
}
function balanced(hub: ReturnType<typeof createAnalysisHub>) {
  const c = hub.read().counts;
  expect(c.inputs).toBe(c.accepted + c.duplicate + c.rejected);
  expect(hub.read().inputCursor).toBe(c.inputs);
}

describe("finite MOCK RAM analysis boundary", () => {
  it("reuses R03 once per input with identical sequence, quality, and book decisions", () => {
    const def = definition(F07.events[0]);
    const hub = createAnalysisHub(def, () => 0);
    let oracle = createMarketQualityState(def.config, def.startNs);
    for (const event of [...F07.events, F07.recovery]) {
      const result = ingestMarketEvent(oracle, event);
      const actual = hub.ingest(envelope(event));
      oracle = result.state;
      expect(actual.outcome).toBe(result.outcome);
      expect(actual.disposition === "ACCEPTED").toBe(result.applied);
      expect(hub.read().qualityState).toEqual(oracle);
      expect(hub.read().book).toEqual(currentMbpBook(oracle));
    }
    balanced(hub);
  });

  it.each([F01, F02])("$fixtureId retains every event and reproduces the existing TWA functions", fixture => {
    const hub = createAnalysisHub(definition(fixture.events[0]), () => 0);
    fixture.events.forEach(e => expect(hub.ingest(envelope(e)).disposition).toBe("ACCEPTED"));
    const history = hub.read().depthHistory!;
    expect(history.events).toHaveLength(5);
    expect(calculateTimeWeightedDepth(history, query())).toMatchObject({ status: "VALID", twa: 38 });
    expect([0, 2, 4, 6, 8].map(s => calculateTimeWeightedDepth(history, query(s, s + 2)).twa))
      .toEqual([60, 40, 30, 60, 0]);
    if (fixture.fixtureId === "F-02") {
      expect(calculateTimeWeightedDepth(history, query(0, 10, 2)).twa).toBe(58);
    }
    expect(hub.read().counts).toEqual({ inputs: 5, accepted: 5, duplicate: 0, rejected: 0 });
  });

  it("same identity L2 and Trades share one revision; L2 qty never becomes executed volume", () => {
    const first = F04.events[0];
    // Explicit new synthetic co-scoped connection scenario, not F01/F04 identity rewriting.
    const snapshot = parsed({ ...F01.events[0], header: { ...first.header,
      channel: "L2_MBP", sequence: "1", eventId: "MOCK-HUB-CO-SCOPED-SNAPSHOT",
      exchangeTimeNs: F04.expected.startNs, receiveTimeNs: F04.expected.startNs },
      bids: [{ priceTicks: 80000, qty: 999999 }] });
    const hub = createAnalysisHub(definition(snapshot), () => 0);
    hub.ingest(envelope(snapshot));
    hub.ingest(coverage());
    let oracle = createTradeStore(first.header);
    for (const event of F04.events) {
      oracle = ingestTrade(oracle, event).store;
      expect(hub.ingest(envelope(event)).tradeDisposition).toBe("ACCEPTED");
    }
    const view = hub.read();
    expect(view.revision).toBe(5);
    expect(view.book?.bids.get(80000)).toBe(999999);
    expect(view.tradeStore.trades).toEqual(oracle.trades);
    expect(aggregateTrades(view.tradeStore)[0]).toMatchObject({ B: 23n, S: 4n, V: 27n, delta: 19n });
    expect(view.persistenceCursor).toBeNull();
    balanced(hub);
  });

  it("R08 distinguishes raw retransmission, economic duplicate, conflict and unsupported revisions", () => {
    const first = F04.events[0];
    const hub = createAnalysisHub(definition(first), () => 0);
    const retransmit = parsed({ ...first, header: { ...first.header,
      eventId: "MOCK-retransmit", sequence: "2" } });
    expect(hub.ingest(envelope(first)).disposition).toBe("ACCEPTED");
    expect(hub.ingest(envelope(first)).disposition).toBe("DUPLICATE");
    expect(hub.ingest(envelope(retransmit))).toMatchObject({
      disposition: "DUPLICATE", tradeDisposition: "DUPLICATE",
    });
    const conflict = parsed({ ...first, qty: 77, header: { ...first.header,
      eventId: "MOCK-economic-conflict", sequence: "3" } });
    expect(hub.ingest(envelope(conflict))).toMatchObject({
      disposition: "REJECTED", tradeDisposition: "CONFLICTING_TRADE_ID",
    });
    expect(hub.read().tradeStore.rawEvents).toHaveLength(4);
    expect(hub.read().tradeStore.trades).toHaveLength(1);
    expect(hub.read().counts).toEqual({ inputs: 4, accepted: 1, duplicate: 2, rejected: 1 });
    balanced(hub);
  });

  it.each(["TRADE_CORRECTION", "TRADE_CANCEL"] as const)("audits but never applies %s", kind => {
    const hub = createAnalysisHub(definition(F04.events[0]), () => 0);
    const first = F04.events[0];
    hub.ingest(envelope(first));
    const revision = parsed({ ...first, kind, originalTradeId: first.tradeId,
      header: { ...first.header, eventId: `MOCK-${kind}`, sequence: "2" }, qty: 999 });
    expect(hub.ingest(envelope(revision))).toMatchObject({
      disposition: "REJECTED", outcome: "UNSUPPORTED_REVISION", tradeDisposition: "UNSUPPORTED_REVISION",
    });
    expect(hub.read().tradeStore.trades).toEqual([first]);
    expect(hub.read().tradeStore.rawEvents).toHaveLength(2);
    expect(currentQuality(hub.read().qualityState.timeline, "TRADES").status).toBe("GAP");
  });

  it("rejects same eventId conflicts using the existing guard without a second Trade acceptance", () => {
    const hub = createAnalysisHub(definition(F04.events[0]), () => 0);
    hub.ingest(envelope(F04.events[0]));
    expect(hub.ingest(envelope(parsed({ ...F04.events[0], qty: 100 })))).toMatchObject({
      disposition: "REJECTED", outcome: "CONFLICT", tradeDisposition: null,
    });
    expect(hub.read().tradeStore.rawEvents).toHaveLength(1);
  });

  it("complete batch is atomic, retransmission is duplicate, partial duplicate cannot apply suffix", () => {
    const def = definition(F02.events[0]);
    const hub = createAnalysisHub(def, () => 0);
    hub.ingest(envelope(F02.events[0]));
    const batch = [0, 1].map((offset) => parsed({
      ...F02.events[1], priceTicks: 80000 + offset, qty: 70 + offset, updateBatchId: "MOCK-complete",
      header: { ...F02.events[1].header, sequence: String(2 + offset), eventId: `MOCK-B${offset}` },
    }));
    const oracle = ingestMbpBatch(hub.read().qualityState, batch);
    expect(hub.ingest({ type: "BATCH", events: batch }).disposition).toBe("ACCEPTED");
    expect(hub.read().qualityState).toEqual(oracle.state);
    expect(hub.read().depthRecords).toHaveLength(2);
    expect(hub.read().usage.depthEvents).toBe(3);
    expect(hub.ingest({ type: "BATCH", events: batch }).disposition).toBe("DUPLICATE");
    const mixed = [batch[1], parsed({ ...batch[1], header: { ...batch[1].header,
      sequence: "4", eventId: "MOCK-B4" } })];
    expect(hub.ingest({ type: "BATCH", events: mixed }).outcome).toBe("BATCH_REJECTED");
    expect(hub.read().book).toBeNull();
    expect(hub.read().qualityState.lastGoodBook.bids.get(80000)).toBe(70);
  });

  it("malformed batch and snapshot never expose intermediate quantity", () => {
    const hub = createAnalysisHub(definition(), () => 0);
    hub.ingest(envelope(F01.events[0]));
    const before = hub.read();
    expect(hub.ingest({ type: "BATCH", events: [F01.events[1], {
      ...F01.events[2], qty: -1,
    } as unknown as MarketEvent] }).outcome).toBe("INVALID_INPUT");
    expect(hub.read().qualityState).toEqual(before.qualityState);
    expect(hub.read().depthRecords).toEqual(before.depthRecords);
  });

  it("snapshot structural rejection retains last good book, but suspends current publication", () => {
    const hub = createAnalysisHub(definition(), () => 0);
    hub.ingest(envelope(F01.events[0]));
    const invalid = parsed({ ...F01.events[0], bids: [...F01.events[0].bids, ...F01.events[0].bids],
      header: { ...F01.events[0].header, eventId: "MOCK-invalid-snapshot", sequence: "2" },
      snapshotCoversSequence: "2" });
    expect(hub.ingest(envelope(invalid)).disposition).toBe("REJECTED");
    expect(hub.read().book).toBeNull();
    expect(hub.read().qualityState.lastGoodBook.bids.get(80000)).toBe(40);
    expect(hub.read().depthRecords).toHaveLength(1);
  });

  it("only eligible snapshot recovers L2, and L2 recovery never heals Trade gap", () => {
    const hub = createAnalysisHub(definition(F07.events[0]), () => 0);
    F07.events.forEach(e => hub.ingest(envelope(e)));
    expect(hub.read().book).toBeNull();
    hub.ingest({ type: "CONDITION", channel: "TRADES", status: "GAP",
      atNs: F07.reconnectAtNs, reason: "MOCK missing Trades" });
    hub.ingest({ type: "CONDITION", channel: "L2_MBP", status: "RESYNCING",
      atNs: F07.reconnectAtNs, reason: "MOCK reconnect only" });
    expect(hub.read().book).toBeNull();
    expect(hub.ingest(envelope(F07.recovery)).disposition).toBe("ACCEPTED");
    expect(hub.read().book).not.toBeNull();
    expect(currentQuality(hub.read().qualityState.timeline, "TRADES").status).toBe("GAP");
    expect(hub.ingest({ type: "CONDITION", channel: "L2_MBP", status: "VALID" as "GAP",
      atNs: F07.recovery.header.receiveTimeNs, reason: "not allowed" }).outcome).toBe("INVALID_INPUT");
  });

  it("unknown clock alignment or missing Trade coverage never yields a COMPLETE aggregate", () => {
    const hub = createAnalysisHub(definition(F04.events[0], {
      depthTimeAlignmentEvidence: null, tradeTimeAlignmentEvidence: null,
    }), () => 0);
    hub.ingest(coverage());
    F04.events.forEach(e => hub.ingest(envelope(e)));
    expect(hub.read().depthHistory).toBeNull();
    expect(hub.read().tradeStore.quality).toEqual([]);
    expect(hub.read().tradeQualityEvidence).toHaveLength(1);
    expect(aggregateTrades(hub.read().tradeStore)[0]).toMatchObject({ status: "INCOMPLETE", V: null });
    const known = createAnalysisHub(definition(F04.events[0]), () => 0);
    F04.events.forEach(e => known.ingest(envelope(e)));
    expect(aggregateTrades(known.read().tradeStore)[0].V).toBeNull();
  });

  it("explicit VALID metadata cannot restore a gapped Trade channel or erase quality history", () => {
    const hub = createAnalysisHub(definition(F04.events[0]), () => 0);
    hub.ingest(coverage());
    hub.ingest(envelope(F04.events[0]));
    hub.ingest({ type: "CONDITION", channel: "TRADES", atNs: F04.events[0].header.receiveTimeNs,
      status: "GAP", reason: "MOCK gap" });
    expect(aggregateTrades(hub.read().tradeStore)[0].V).toBeNull();
    const q = coverage();
    if (q.type !== "QUALITY_INTERVAL") throw Error("test contract");
    const later: DataQualityInterval = { ...q.interval, startNs: q.interval.endNs!, endNs: null };
    hub.ingest({ ...q, interval: later, observedAtNs: later.startNs });
    expect(currentQuality(hub.read().qualityState.timeline, "TRADES").status).toBe("GAP");
    expect(aggregateTrades(hub.read().tradeStore)[0].V).toBeNull();
  });

  it.each([
    { sourceId: "MOCK-foreign" }, { canonicalInstrumentId: "CME:NQ:2026-06" },
    { canonicalInstrumentId: "CME:ES:2026-03" }, { sessionId: "MOCK-foreign" },
    { environment: "LIVE", source: "VERIFIED_VENDOR" },
  ])("strictly rejects foreign identity %j", patch => {
    const hub = createAnalysisHub(definition(), () => 0);
    hub.ingest(envelope(F01.events[0]));
    const before = hub.read();
    const event = parsed({ ...F01.events[1], header: { ...F01.events[1].header, ...patch } });
    expect(hub.ingest(envelope(event)).disposition).toBe("REJECTED");
    expect(hub.read().qualityState).toEqual(before.qualityState);
    expect(hub.read().depthRecords).toEqual(before.depthRecords);
  });

  it("independent fixture sessions stay separate without merging F04 and F05", () => {
    const a = createAnalysisHub(definition(F04.events[0]), () => 0);
    const b = createAnalysisHub(definition(F05.events[0]), () => 0);
    F04.events.forEach(e => a.ingest(envelope(e)));
    F05.events.forEach(e => b.ingest(envelope(e)));
    expect(a.read().tradeStore.trades).toHaveLength(3);
    expect(b.read().tradeStore.trades).toHaveLength(2);
    expect(a.ingest(envelope(F05.events[0])).disposition).toBe("REJECTED");
    expect(b.read().counts.inputs).toBe(2);
  });

  it.each([
    ["inputs", 1], ["normalizedBytes", analysisInputBytes(envelope(F01.events[0]))],
    ["depthRecords", 1], ["depthEvents", 1], ["dedupEntries", 1],
  ] as const)("exact %s boundary admits first input, rejects next without installing candidate", (key, maximum) => {
    const hub = createAnalysisHub(definition(F01.events[0], { budget: { ...limits, [key]: maximum } }), () => 0);
    expect(hub.ingest(envelope(F01.events[0])).disposition).toBe("ACCEPTED");
    const before = hub.read();
    expect(hub.ingest(envelope(F01.events[1]))).toMatchObject({
      disposition: "REJECTED", outcome: "BUDGET_EXCEEDED", stop: { limit: key },
    });
    expect(hub.read().qualityState).toEqual(before.qualityState);
    expect(hub.read().usage).toEqual(before.usage);
    expect(hub.read().depthRecords).toEqual(before.depthRecords);
    expect(hub.ingest(envelope(F01.events[0])).outcome).toBe("STOPPED");
    expect(hub.read().counts).toEqual({ inputs: 3, accepted: 1, duplicate: 0, rejected: 2 });
    balanced(hub);
  });

  it.each(["trades", "rawDeliveries", "dedupEntries"] as const)("bounds Trade retention: %s", key => {
    const maximum = key === "dedupEntries" ? 2 : 1;
    const hub = createAnalysisHub(definition(F04.events[0], { budget: { ...limits, [key]: maximum } }), () => 0);
    hub.ingest(envelope(F04.events[0]));
    const before = hub.read();
    expect(hub.ingest(envelope(F04.events[1])).stop?.limit).toBe(key);
    expect(hub.read().tradeStore).toEqual(before.tradeStore);
    expect(hub.read().qualityState).toEqual(before.qualityState);
  });

  it("raw duplicate deliveries remain bounded even though dedup does not grow", () => {
    const hub = createAnalysisHub(definition(F04.events[0], {
      budget: { ...limits, rawDeliveries: 1 },
    }), () => 0);
    hub.ingest(envelope(F04.events[0]));
    expect(hub.ingest(envelope(F04.events[0])).stop?.limit).toBe("rawDeliveries");
    expect(hub.read().tradeStore.rawEvents).toHaveLength(1);
  });

  it.each([
    ["qualityNotifications", 0], ["qualityIntervals", 3], ["bookLevels", 0],
  ] as const)("bounds %s without changing initial reducer state", (key, maximum) => {
    const hub = createAnalysisHub(definition(F01.events[0], { budget: { ...limits, [key]: maximum } }), () => 0);
    const before = hub.read();
    const input: AnalysisInput = key === "bookLevels" ? envelope(F01.events[0]) :
      { type: "CONDITION", channel: "L2_MBP", status: "GAP", atNs: at(0), reason: "MOCK notification" };
    expect(hub.ingest(input).stop?.limit).toBe(key);
    expect(hub.read().qualityState).toEqual(before.qualityState);
  });

  it("applies all events while drawing is stopped; dirty notifications coalesce at >=250ms", () => {
    let now = 0;
    const hub = createAnalysisHub(definition(), () => now);
    expect(hub.pollNotification()).toBeNull();
    hub.ingest(envelope(F01.events[0]));
    const old = hub.pollNotification()!;
    expect(old.revision).toBe(1);
    F01.events.slice(1).forEach(e => hub.ingest(envelope(e)));
    expect(hub.read().depthRecords).toHaveLength(5);
    now = 249; expect(hub.pollNotification()).toBeNull();
    now = 250; expect(hub.pollNotification()?.revision).toBe(5);
    now = 500; expect(hub.pollNotification()).toBeNull();
    expect(old.depthRecords).toHaveLength(1);
    expect(old.book?.bids.get(80000)).toBe(40);
    now = 499; expect(() => hub.pollNotification()).toThrow("monotonic");
  });

  it("cannot mutate internal Maps, input objects or scope through read output", () => {
    const hub = createAnalysisHub(definition(), () => 0);
    hub.ingest(envelope(F01.events[0]));
    const view = hub.read();
    (view.book!.bids as unknown as Map<number, number>).set(80000, 999);
    (view.qualityState.guard.seen as Map<string, string>).clear();
    expect(hub.read().book?.bids.get(80000)).toBe(40);
    expect(hub.ingest(envelope(F01.events[0])).disposition).toBe("DUPLICATE");
    expect(() => { (view.scope.budget as { inputs: number }).inputs = 999; }).toThrow();
  });

  it("requires finite budgets and MOCK provenance; malformed inputs are explicit rejections", () => {
    expect(() => createAnalysisHub(definition(F01.events[0], {
      budget: { ...limits, normalizedBytes: Infinity },
    }), () => 0)).toThrow();
    const def = definition();
    expect(() => createAnalysisHub({ ...def, config: { ...def.config,
      identity: { ...def.config.identity, environment: "LIVE", source: "VERIFIED_VENDOR" } } }, () => 0)).toThrow();
    const hub = createAnalysisHub(def, () => 0);
    const bad = { ...F01.events[1], qty: -1 } as unknown as MarketEvent;
    expect(hub.ingest(envelope(bad)).outcome).toBe("INVALID_INPUT");
    expect(hub.read().depthRecords).toHaveLength(0);
    balanced(hub);
  });

  it("order-only Trade sequencing is not promoted to certified coverage by VALID metadata", () => {
    const def = definition(F04.events[0]);
    const hub = createAnalysisHub({ ...def, config: { ...def.config, rules: {
      ...def.config.rules, TRADES: { scope: "CHANNEL", continuity: { contiguous: false } },
    } } }, () => 0);
    hub.ingest(coverage());
    F04.events.forEach(e => hub.ingest(envelope(e)));
    expect(currentQuality(hub.read().qualityState.timeline, "TRADES").sequenceVerification).toBe("ORDER_ONLY");
    expect(aggregateTrades(hub.read().tradeStore)[0].V).toBeNull();
    expect(hub.read().tradeQualityEvidence[0].status).toBe("VALID");
  });

  it("unknown Trade precision cannot certify aggregate validity, and missing event time is rejected", () => {
    const hub = createAnalysisHub(definition(F04.events[0]), () => 0);
    hub.ingest(coverage());
    const event = parsed({ ...F04.events[0],
      header: { ...F04.events[0].header, sourceTimePrecision: "unknown" } });
    hub.ingest(envelope(event));
    expect(aggregateTrades(hub.read().tradeStore)[0].V).toBeNull();
    const before = hub.read();
    expect(hub.ingest(envelope(parsed({ ...F04.events[1],
      header: { ...F04.events[1].header, exchangeTimeNs: null } }))).outcome).toBe("INVALID_INPUT");
    expect(hub.read().qualityState).toEqual(before.qualityState);
    expect(hub.read().tradeStore).toEqual(before.tradeStore);
  });

  it("unacceptable snapshot proof and VALID quality metadata cannot recover an L2 gap", () => {
    const hub = createAnalysisHub(definition(F07.events[0]), () => 0);
    F07.events.forEach(e => hub.ingest(envelope(e)));
    expect(hub.ingest(envelope(parsed({ ...F07.recovery, snapshotCoversSequence: null }))).disposition)
      .toBe("REJECTED");
    hub.ingest({ type: "QUALITY_INTERVAL", observedAtNs: F07.recovery.header.receiveTimeNs,
      interval: { channel: "L2_MBP", status: "VALID", startNs: F07.recovery.header.receiveTimeNs,
        endNs: null, reason: "Metadata only, not a snapshot" } });
    expect(hub.read().book).toBeNull();
    expect(hub.ingest(envelope(F07.recovery)).disposition).toBe("ACCEPTED");
  });

  it("a late failure in a complete batch publishes neither its prefix nor a depth record", () => {
    const hub = createAnalysisHub(definition(), () => 0);
    hub.ingest(envelope(F01.events[0]));
    const batch = [2, 4].map((sequence) => parsed({ ...F01.events[1], updateBatchId: "MOCK-gap-batch",
      header: { ...F01.events[1].header, eventId: `MOCK-gap-${sequence}`, sequence: String(sequence) } }));
    expect(hub.ingest({ type: "BATCH", events: batch }).outcome).toBe("GAP");
    expect(hub.read().qualityState.lastGoodBook.bids.get(80000)).toBe(40);
    expect(hub.read().book).toBeNull();
    expect(hub.read().depthRecords).toHaveLength(1);
  });

  it("budget rejection of a whole batch preserves guard and book; stop is notified even without data acceptance", () => {
    let clock = 0;
    const hub = createAnalysisHub(definition(F02.events[0], {
      budget: { ...limits, depthEvents: 2 },
    }), () => clock);
    hub.ingest(envelope(F02.events[0]));
    hub.pollNotification();
    const before = hub.read();
    const events = [2, 3].map((sequence) => parsed({ ...F02.events[1], updateBatchId: "MOCK-budget-batch",
      header: { ...F02.events[1].header, eventId: `MOCK-budget-${sequence}`, sequence: String(sequence) } }));
    expect(hub.ingest({ type: "BATCH", events }).stop?.limit).toBe("depthEvents");
    expect(hub.read().qualityState).toEqual(before.qualityState);
    expect(hub.read().depthRecords).toEqual(before.depthRecords);
    clock = 250;
    expect(hub.pollNotification()).toMatchObject({ status: "STOPPED", revision: 2, book: null });
  });
});
