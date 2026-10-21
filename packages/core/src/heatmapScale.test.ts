import { describe, expect, it } from "vitest";
import { F01_BOOK as F01, F02_TWO_TICKS as F02, F03_GAP_TWA as F03 } from "../../fixtures/src/index";
import type { L2Snapshot } from "./events";
import { createMarketQualityState, ingestMarketEvent, markChannelCondition } from "./qualityTimeline";
import { calculateTimeWeightedDepth, type DepthHistory, type DepthRecord } from "./timeWeightedDepth";
import {
  DEFAULT_SCALE, RELATIVE_WINDOW_NS, validateScale, scaleQuantity, collectQuantityStages, relativeP95,
  captureBaseline, resolveReference, type QuantityStage, type ReferenceQuery, type ScaleSettings,
} from "./heatmapScale";

const origin = BigInt(F01.expected.startNs);
const at = (s: number) => (origin + BigInt(s) * 1_000_000_000n).toString();
function history(events: readonly DepthRecord[], gap = false): DepthHistory {
  const snap = events[0] as L2Snapshot, h = snap.header;
  const rule = { scope: h.sequenceScope, continuity: { contiguous: true, evidence: "Fixed MOCK +1" } } as const;
  let state = createMarketQualityState({
    identity: { environment: h.environment, source: h.source, sourceId: h.sourceId,
      canonicalInstrumentId: h.canonicalInstrumentId, sessionId: h.sessionId },
    depthScope: snap.depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
    snapshotAlignmentEvidence: "MOCK header sequence equals covered sequence",
  }, h.exchangeTimeNs!);
  for (let i = 0; i < events.length; i++) {
    if (gap && i === 1) state = markChannelCondition(state, "L2_MBP", "GAP", F03.gap.startNs, "MOCK [9,11) gap");
    const applied = ingestMarketEvent(state, events[i]);
    if (!applied.applied) throw new Error("Fixture rejected");
    state = applied.state;
  }
  return { events, qualityState: state, qualityTimeAlignmentEvidence: "MOCK receive == exchange time" };
}
const h1 = history(F01.events), h2 = history(F02.events), h3 = history(F03.events, true);
const settings = (patch: Partial<ScaleSettings> = {}): ScaleSettings => ({ ...DEFAULT_SCALE, ...patch });
const cell = (twa: number) => ({ twa, status: "VALID" as const, coverageRatio: 1 });
const twa = (h: DepthHistory, start: number, end: number, priceTicks = 80000, width: 1 | 2 | 4 | 8 = 1) =>
  calculateTimeWeightedDepth(h, { side: "BID", priceTicks, width, startNs: at(start), endNs: at(end) });
const query = (patch: Partial<ReferenceQuery> = {}): ReferenceQuery => ({
  side: "BID", width: 1, priceTicks: [80000], asOfNs: at(300), ...patch,
});
const stage = (a: number, b: number, quantity: number | null, patch: Partial<QuantityStage> = {}): QuantityStage => ({
  side: "BID", width: 1, binId: 80000, startNs: at(a), endNs: at(b),
  quantity, status: quantity === null ? "NO DATA" : "VALID", ...patch,
});

describe("R07 immutable post-aggregation quantity filtering", () => {
  it("keeps F01 10s TWA38 but threshold50 hides it, zero restores it", () => {
    const c = twa(h1, 0, 10); expect(c.twa).toBe(38);
    expect(scaleQuantity(c, settings(), 200).visible).toBe(false);
    expect(scaleQuantity(c, settings({ minimumVolume: 0 }), 200).visible).toBe(true);
  });
  it("keeps exact 2s values and shows only the two 60s at threshold50", () => {
    const rows = [0, 2, 4, 6, 8].map(a => twa(h1, a, a + 2));
    expect(rows.map(r => r.twa)).toEqual([60, 40, 30, 60, 0]);
    expect(rows.map(r => scaleQuantity(r, settings(), 200).visible)).toEqual([true, false, false, true, false]);
    expect(rows.map(r => scaleQuantity(r, settings({ minimumVolume: 0 }), 200).visible)).toEqual([true, true, true, true, true]);
    expect(rows[4].status).toBe("VALID");
  });
  it("filters F02 after 2Tick aggregation:58 visible, individual20 hidden", () => {
    expect(twa(h2, 0, 10, 80000, 2).twa).toBe(58);
    expect(scaleQuantity(twa(h2, 0, 10, 80000, 2), settings({ width: 2 }), 200).visible).toBe(true);
    expect(twa(h2, 0, 10, 80001).twa).toBe(20);
    expect(scaleQuantity(twa(h2, 0, 10, 80001), settings(), 200).visible).toBe(false);
  });
  it.each([49.999, 49.5, 0])("does not round %s up to threshold50", q => {
    expect(scaleQuantity(cell(q), settings(), 200).visible).toBe(false);
  });
  it.each([50, 50.001, 60])("includes raw TWA %s at threshold50", q => {
    expect(scaleQuantity(cell(q), settings(), 200).visible).toBe(true);
  });
  it("F03 partial35 is never confirmed, irrespective of threshold/reference", () => {
    const c = twa(h3, 8, 12);
    expect(c).toMatchObject({ coverageRatio: .5, twa: null, partialTWA: 35, status: "NO DATA" });
    for (const minimumVolume of [0, 50, 100]) expect(scaleQuantity(c, settings({ minimumVolume }), null)).toMatchObject({
      visible: true, brightness: null, reason: "NO DATA",
    });
  });
  it("0->50->100->0 preserves raw contents, counts and R04 result", () => {
    const raw = JSON.stringify(F01), c = twa(h1, 0, 10), original = JSON.stringify(c);
    expect([0, 50, 100, 0].map(minimumVolume => scaleQuantity(c, settings({ minimumVolume }), 200).visible))
      .toEqual([true, false, false, true]);
    expect(JSON.stringify(F01)).toBe(raw); expect(F01.events).toHaveLength(5); expect(JSON.stringify(c)).toBe(original);
  });
  it("does not invent unknown ticks for width4/8", () => {
    for (const width of [4, 8] as const) expect(twa(h2, 0, 10, 80000, width).status).toBe("NO DATA");
  });
});
describe("R07 numerical intensity, validation, no palette coupling", () => {
  it.each([[0, 0], [50, .25], [60, .3], [200, 1], [500, 1]])("ABS200 maps %s to %s", (q, r) => {
    expect(scaleQuantity(cell(q), settings({ minimumVolume: 0 }), 200)).toMatchObject({ normalized: r, brightness: r });
  });
  it("min/max intensity rescale separately from TWA", () => {
    expect(scaleQuantity(cell(60), settings({ minIntensity: .2, maxIntensity: .6 }), 200).brightness).toBeCloseTo(.25);
    expect(scaleQuantity(cell(60), settings({ minIntensity: .31 }), 200).reason).toBe("MINIMUM_INTENSITY");
  });
  it("uses both exact contrast formulas", () => {
    const out = scaleQuantity(cell(50), settings({ liquidityContrast: 2, topContrast: 2 }), 200);
    expect(out.normalized).toBe(.25); expect(out.brightness).toBe(.75);
  });
  it("known0 without positive reference stays valid background when filteroff", () => {
    expect(scaleQuantity(cell(0), settings({ minimumVolume: 0 }), null)).toMatchObject({ visible: true, brightness: 0 });
    expect(scaleQuantity(cell(60), settings(), null).reason).toBe("NO_BASELINE");
  });
  it.each([.25, 4])("accepts both contrast boundaries %s", contrast => {
    expect(() => validateScale(settings({ liquidityContrast: contrast, topContrast: contrast }))).not.toThrow();
  });
  it.each([
    { minimumVolume: -1 }, { minimumVolume: 1.5 }, { minimumVolume: NaN }, { minimumVolume: Infinity },
    { absoluteMaxQty: 0 }, { absoluteMaxQty: 1.2 }, { absoluteMaxQty: Number.MAX_SAFE_INTEGER + 1 },
    { minIntensity: -.01 }, { maxIntensity: 1.01 }, { minIntensity: .5, maxIntensity: .5 },
    { minIntensity: .6, maxIntensity: .5 }, { minIntensity: NaN },
    { liquidityContrast: .249 }, { liquidityContrast: 4.001 }, { topContrast: 0 }, { topContrast: Infinity },
  ])("rejects invalid settings %j", patch => { expect(() => validateScale(settings(patch))).toThrow(); });
  it.each([-1, NaN, Infinity, 0])("rejects invalid positive reference %s", ref => {
    expect(() => scaleQuantity(cell(60), settings(), ref)).toThrow();
  });
  it("rejects partial quantity markedVALID", () => {
    expect(() => scaleQuantity({ ...cell(35), coverageRatio: .5 }, settings(), 200)).toThrow();
  });
});
describe("R07 duration-weighted empirical P95 and warm-up evidence", () => {
  it("285s at10 and15s at100 givesP95=10, unlike two equally weighted samples", () => {
    const result = relativeP95([stage(0, 285, 10), stage(285, 300, 100)], query());
    expect(result).toMatchObject({ refQty: 10, status: "READY", positiveWeightNs: RELATIVE_WINDOW_NS.toString() });
  });
  it("284s at10 and16s at100 givesP95=100", () => {
    expect(relativeP95([stage(0, 284, 10), stage(284, 300, 100)], query()).refQty).toBe(100);
  });
  it("computes BID/ASK independently", () => {
    const rows = [stage(0, 300, 20), stage(0, 300, 90, { side: "ASK" })];
    expect(relativeP95(rows, query()).refQty).toBe(20);
    expect(relativeP95(rows, query({ side: "ASK" })).refQty).toBe(90);
  });
  it("computes widths separately", () => {
    const rows = [stage(0, 300, 20), stage(0, 300, 58, { width: 2, binId: 40000 })];
    expect(relativeP95(rows, query({ width: 2 })).refQty).toBe(58);
  });
  it("zeros prove observation coverage but never enter the positive distribution", () => {
    expect(relativeP95([stage(0, 299, 0), stage(299, 300, 60)], query())).toMatchObject({
      status: "READY", coverageRatio: 1, refQty: 60, positiveWeightNs: "1000000000",
    });
  });
  it("allzero300s has no invented positive reference", () => {
    expect(relativeP95([stage(0, 300, 0)], query())).toMatchObject({ status: "WARMING UP", refQty: null, coverageRatio: 1 });
  });
  it("a1ns missing interval cannot be rounded toREADY", () => {
    const row = { ...stage(0, 300, 70), startNs: (origin + 1n).toString() };
    expect(relativeP95([row], query()).status).toBe("WARMING UP");
  });
  it("gaps are not zero samples and partial reference is labelledwarming", () => {
    expect(relativeP95([stage(0, 100, 10), stage(100, 200, null), stage(200, 300, 100)], query())).toMatchObject({
      refQty: 100, status: "WARMING UP", coveredDurationNs: "200000000000", positiveWeightNs: "200000000000",
    });
  });
  it("multiple simultaneous prices cannot fake300s elapsed coverage", () => {
    const rows = Array.from({ length: 50 }, (_, i) => stage(0, 10, i + 1, { binId: 80000 + i }));
    expect(relativeP95(rows, query({ priceTicks: rows.map(r => r.binId) }))).toMatchObject({
      status: "WARMING UP", coveredDurationNs: "10000000000", positiveWeightNs: "500000000000",
    });
  });
  it("clips toexactlast300s, excludingolder andfuturestates", () => {
    const rows = [stage(-100, 0, 9999), stage(0, 300, 60), stage(300, 400, 10000)];
    expect(relativeP95(rows, query())).toMatchObject({ refQty: 60, status: "READY" });
  });
  it("retains nanosecond precision in weights and referencewindow", () => {
    const rows = [stage(0, 300, 60)];
    expect(relativeP95(rows, query()).window).toEqual({ startNs: at(0), endNs: at(300) });
    expect(BigInt(relativeP95(rows, query()).positiveWeightNs)).toBe(300_000_000_000n);
  });
  it("rejects duplicateoverlap instead ofdoubleweighting", () => {
    expect(() => relativeP95([stage(0, 200, 60), stage(100, 300, 60)], query())).toThrow();
  });
  it("rejects averaged TWA as quantitystage", () => {
    expect(() => relativeP95([stage(0, 300, 49.999)], query())).toThrow();
  });
  it("collects actual F01 stages not 2s averages; provisionalP95=80", () => {
    const q = query({ asOfNs: at(10) }), rows = collectQuantityStages(h1, q);
    expect(rows.filter(r => r.status === "VALID").map(r => r.quantity)).toEqual([40, 80, 0, 60, 0]);
    expect(relativeP95(rows, q)).toMatchObject({ refQty: 80, status: "WARMING UP",
      coveredDurationNs: "10000000000", positiveWeightNs: "6000000000" });
  });
  it("collects aggregate F02 stages with correctweights", () => {
    const q = query({ width: 2, asOfNs: at(10), priceTicks: [80000, 80001] }), rows = collectQuantityStages(h2, q);
    expect(rows.filter(r => r.status === "VALID").map(r => r.quantity)).toEqual([60, 100, 20, 80, 20]);
    expect(relativeP95(rows, q)).toMatchObject({ refQty: 100, coveredDurationNs: "10000000000" });
  });
  it("F03 excludes GAP and knownzero, has only1s70 as provisionalpositive", () => {
    const q = query({ asOfNs: at(12) }), rows = collectQuantityStages(h3, q);
    expect(relativeP95(rows, q)).toMatchObject({ refQty: 70, status: "WARMING UP",
      coveredDurationNs: "2000000000", positiveWeightNs: "1000000000" });
  });
  it("unknownextra ticks never warmup a largerbucket", () => {
    const q = query({ width: 4, asOfNs: at(10) });
    expect(relativeP95(collectQuantityStages(h2, q), q)).toMatchObject({ refQty: null, coverageRatio: 0, status: "WARMING UP" });
  });
  it("threshold, contrast and viewport cannot alter P95input or distribution", () => {
    const q = query({ asOfNs: at(10) }), rows = collectQuantityStages(h1, q), original = JSON.stringify(rows);
    for (const minimumVolume of [0, 50, 100, 0]) {
      scaleQuantity(twa(h1, 0, 10), settings({ minimumVolume, topContrast: 4 }), 200);
      expect(relativeP95(rows, q).refQty).toBe(80);
    }
    expect(JSON.stringify(rows)).toBe(original);
  });
});
describe("R07 explicit fixedbaseline and recalibration", () => {
  const first = relativeP95([stage(0, 300, 60)], query());
  const next = relativeP95([stage(300, 600, 120)], query({ asOfNs: at(600) }));
  const s = settings({ mode: "RELATIVE", fixedBaseline: true });
  it("capture includes side,width,quantity,asof,window", () => {
    expect(captureBaseline(s, first)).toMatchObject({ side: "BID", width: 1, refQty: 60, asOfNs: at(300),
      window: { startNs: at(0), endNs: at(300) }, status: "READY" });
  });
  it("new reference/HISTORY movement do not change capturedvalue", () => {
    const fixed = captureBaseline(s, first);
    expect(resolveReference(s, next, fixed)).toBe(60);
    expect(resolveReference({ ...s, fixedBaseline: false }, next, fixed)).toBe(120);
  });
  it("onlyexplicitrecalibration returnsnewimmutablebaseline", () => {
    const fixed = captureBaseline(s, first), updated = captureBaseline(s, next);
    expect(resolveReference(s, next, updated)).toBe(120); expect(fixed?.refQty).toBe(60);
    expect(Object.isFrozen(fixed)).toBe(true);
  });
  it("provisionalfixedrecord remainsWARMINGevenifnewcandidateREADY", () => {
    const partial = relativeP95([stage(290, 300, 80)], query());
    const fixed = captureBaseline(s, partial);
    expect(fixed?.status).toBe("WARMING UP");
    expect(resolveReference(s, next, fixed)).toBe(80);
  });
  it("no positive samples means no inventedcapture", () => {
    expect(captureBaseline(s, relativeP95([], query()))).toBe(null);
    expect(resolveReference(s, first, null)).toBe(null);
  });
  it("different width or side may notreusefixedrecord", () => {
    const fixed = captureBaseline(s, first);
    expect(() => resolveReference(s, { ...next, side: "ASK" }, fixed)).toThrow();
    expect(() => resolveReference({ ...s, width: 2 }, { ...next, width: 2 }, fixed)).toThrow();
  });
  it("ABS200 staysfixed despitecandidate data orpendingabsolute change untilrecalibrate", () => {
    const abs = settings({ fixedBaseline: true }), fixed = captureBaseline(abs, first);
    expect(resolveReference({ ...abs, absoluteMaxQty: 400 }, next, fixed)).toBe(200);
    const updated = captureBaseline({ ...abs, absoluteMaxQty: 400 }, next);
    expect(updated?.refQty).toBe(400);
  });
});
