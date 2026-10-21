import { describe, expect, it } from "vitest";
import { R11_DELTA_CASES, R11_DELTA_EXPECTED, F04_TRADES, F05_TRADES } from "../../fixtures/src/index";
import { executedVolume, type Trade, type DataQualityInterval } from "./events";
import { aggregateTrades, evaluateBubbleFilter, DEFAULT_BUBBLE_FILTERS, type BubbleFilters } from "./bubbleAggregate";
import { createViewport, resizeViewport, zoomTime, panTime, timeToX, type Viewport } from "./viewport";
import {
  createDeltaTimeline, ingestDeltaTrade, advanceDeltaWatermark, setDeltaCondition,
  queryDeltaBin, queryDeltaTimeline, projectDeltaTimeline, type DeltaTimeline,
} from "./deltaTimeline";

const T0 = 1767261600000000000n, S = 1_000_000_000n, at = (offset = 0n) => (T0 + offset).toString();
const pair = R11_DELTA_CASES.find(c => c.id === "PAIR")!;
const source = pair.sources[0], snapshot = (s: unknown) => JSON.stringify(s, (_, n) => typeof n === "bigint" ? `${n}n` : n);
function empty(): DeltaTimeline { return createDeltaTimeline(source.header, source.quality, source.alignment); }
function replay(id = "PAIR", count = 1): readonly DeltaTimeline[] {
  const fixture = R11_DELTA_CASES.find(c => c.id === id)!;
  return fixture.sources.map((s, index) => {
    let state = createDeltaTimeline(s.header, s.quality, s.alignment), ingested = 0;
    for (const step of fixture.steps.slice(0, count)) {
      while (ingested < step.counts[index]) state = ingestDeltaTrade(state, s.events[ingested++]);
      const cond = step.conditions?.[index], progress = step.progressNs?.[index];
      if (cond) state = setDeltaCondition(state, cond);
      if (progress) state = advanceDeltaWatermark(state, { exchangeTimeNs: progress, trusted: true,
        scope: state.tradeState.store.scope, evidence: "Explicit MOCK progress in independent source scope" });
    }
    return state;
  });
}
function progress(state: DeltaTimeline, offset = 5n * S) {
  return advanceDeltaWatermark(state, { exchangeTimeNs: at(offset), trusted: true,
    scope: state.tradeState.store.scope, evidence: "Explicit same-scope MOCK progress" });
}
function trade(index: number, time: bigint, qty = 1, aggressor: Trade["aggressor"] = "BUY", priceTicks = 80000): Trade {
  return { ...F04_TRADES.events[0], tradeId: `R11-UNIT-T${index}`, qty: executedVolume(qty), aggressor, priceTicks,
    header: { ...source.header, eventId: `R11-UNIT-E${index}`, sequence: String(index + 1),
      exchangeTimeNs: at(time), receiveTimeNs: at(time + 8n * S) } };
}
function viewport(dpr = 1): Viewport {
  const v = createViewport({ bounds: { left: 20, top: 10, width: 1000, height: 400 }, dpr,
    latestNs: at(10n * S), price: { minTick: 79980, maxTick: 80020 } });
  return { ...v, time: { minNs: at(-10n * S), maxNs: at(10n * S) }, timeMode: "HISTORY" };
}
describe("R11 all-price Delta from R08 independent normalized stores", () => {
  it("keeps original F04/F05 raw objects, timestamps and separate sessions (+19/-2)", () => {
    const [f04, f05] = replay();
    expect(pair.sources[0].events).toBe(F04_TRADES.events);
    expect(pair.sources[1].events).toBe(F05_TRADES.events);
    const a = queryDeltaBin(f04, at()), b = queryDeltaBin(f05, at(2n * S));
    expect([a.B, a.S, a.U, a.V, a.delta]).toEqual([23n, 4n, 0n, 27n, 19n]);
    expect([b.B, b.S, b.U, b.V, b.delta]).toEqual([12n, 14n, 0n, 26n, -2n]);
    expect(a.scope.sessionId).not.toBe(b.scope.sessionId);
    expect(a.id).not.toBe(b.id);
    expect(a.quality).toBe("VALID"); expect(b.quality).toBe("VALID");
    expect(a.status).toBe("PROVISIONAL"); expect(b.status).toBe("PROVISIONAL");
    expect(R11_DELTA_EXPECTED.pair.scopes).toBe(2);
  });
  it("aggregates three distinct price bins even though every individual bubble is filtered out", () => {
    const s = replay("MULTIPRICE")[0], b = queryDeltaBin(s, at());
    expect(new Set(s.tradeState.store.trades.map(t => t.priceTicks)).size).toBe(3);
    expect(aggregateTrades(s.tradeState.store)).toHaveLength(3);
    expect(aggregateTrades(s.tradeState.store).filter(b => evaluateBubbleFilter(b).pass)).toHaveLength(0);
    expect([b.B, b.S, b.V, b.delta]).toEqual([23n, 4n, 27n, 19n]);
  });
  it("F05 remains -2 while rejected by the unchanged default bubble filter", () => {
    const s = replay()[1];
    expect(aggregateTrades(s.tradeState.store).every(b => !evaluateBubbleFilter(b).pass)).toBe(true);
    expect(queryDeltaBin(s, at(2n * S)).delta).toBe(-2n);
  });
  it.each(["volume", "absoluteDelta", "imbalancePercent"] as const)("is independent of %s filter changes", key => {
    const s = replay()[0], before = snapshot(s), bins = aggregateTrades(s.tradeState.store);
    const f: BubbleFilters = { ...DEFAULT_BUBBLE_FILTERS, [key]: { enabled: true, minimum: key === "imbalancePercent" ? 100 : 1000 } };
    expect(bins.filter(b => evaluateBubbleFilter(b, f).pass)).toHaveLength(0);
    expect(queryDeltaBin(s, at()).delta).toBe(19n);
    expect(snapshot(s)).toBe(before);
  });
  it("uses neither displayed bubbles nor cluster state, even when the bubble getter throws", () => {
    const s = replay()[1], guarded = Object.create(s.tradeState);
    Object.defineProperty(guarded, "bubbles", { get() { throw new Error("Delta must not read display buckets"); } });
    const noView: DeltaTimeline = { ...s, bins: [], tradeState: guarded };
    expect(queryDeltaBin(noView, at(2n * S)).delta).toBe(-2n);
  });
  it.each(["canonicalInstrumentId", "sourceId", "sessionId", "source", "environment"] as const)("rejects mixing %s into an existing Store", key => {
    const t = trade(1, 0n), changed = key === "source" ? "VERIFIED_VENDOR" : key === "environment" ? "REPLAY" : "DIFFERENT";
    expect(() => ingestDeltaTrade(empty(), { ...t, header: { ...t.header, [key]: changed } })).toThrow();
  });
  it("deduplicates deliveries without changing totals or final revision", () => {
    let s = replay("PAIR", 2)[0];
    s = ingestDeltaTrade(s, { ...F04_TRADES.events[0], header: { ...F04_TRADES.events[0].header,
      eventId: "DUPLICATE-DELIVERY", receiveTimeNs: at(8n * S), sequence: "10" } });
    const b = queryDeltaBin(s, at());
    expect(s.tradeState.store.rawEvents).toHaveLength(4);
    expect(s.tradeState.store.trades).toHaveLength(3);
    expect([b.tradesCount, b.delta, b.revision, b.status]).toEqual([3, 19n, 0, "FINAL"]);
  });
  it("handles 2s boundary -1ns/exact/+1ns without floating epoch conversion", () => {
    let s = empty();
    for (const [i, offset] of [2n * S - 1n, 2n * S, 2n * S + 1n].entries()) s = ingestDeltaTrade(s, trade(i, offset));
    expect(queryDeltaBin(s, at()).delta).toBe(1n);
    expect(queryDeltaBin(s, at(2n * S)).delta).toBe(2n);
    expect(s.tradeState.store.trades[0].header.exchangeTimeNs).toBe("1767261601999999999");
  });
  it("keeps prices as exact safe integer Ticks and sums quantities above Number.MAX_SAFE_INTEGER using BigInt", () => {
    let s = empty();
    s = ingestDeltaTrade(s, trade(0, 1n, Number.MAX_SAFE_INTEGER, "BUY", Number.MAX_SAFE_INTEGER));
    s = ingestDeltaTrade(s, trade(1, 2n, Number.MAX_SAFE_INTEGER, "BUY", 80000));
    const b = queryDeltaBin(s, at());
    expect(b.delta).toBe(18_014_398_509_481_982n); expect(b.V).toBe(18_014_398_509_481_982n);
    expect(s.tradeState.store.trades[0].priceTicks).toBe(Number.MAX_SAFE_INTEGER);
    const f = projectDeltaTimeline([b], viewport());
    expect(f.bars[0].top).toBeCloseTo(63 - 63 / 1.1, 12);
    expect(Number.isFinite(f.bars[0].top!)).toBe(true);
  });
  it.each([-1, .5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects invalid quantity %s", qty => {
    const s = empty(), t = trade(0, 1n);
    expect(() => ingestDeltaTrade(s, { ...t, qty })).toThrow();
    expect(s.tradeState.store.rawEvents).toHaveLength(0);
  });
  it.each(["1.5", "001", "-1", "", "NaN"])("rejects noncanonical ns %s", invalid => {
    expect(() => queryDeltaBin(empty(), invalid)).toThrow();
  });
});
describe("R11 coverage, classification, temporal finality and revisions", () => {
  it("distinguishes VALID arithmetic from PROVISIONAL then FINAL event-time sealing", () => {
    const a = queryDeltaBin(replay()[0], at()), b = queryDeltaBin(replay("PAIR", 2)[0], at());
    expect(a.quality).toBe("VALID"); expect(b.quality).toBe("VALID");
    expect(a.status).toBe("PROVISIONAL"); expect(b.status).toBe("FINAL");
    expect(b.finalized).toBe(true); expect(b.revision).toBe(0);
  });
  it("seals exactly at end <= watermark, including a one-nanosecond boundary", () => {
    let s = replay()[0];
    s = progress(s, 5n * S - 1n); expect(queryDeltaBin(s, at()).status).toBe("PROVISIONAL");
    s = progress(s, 5n * S); expect(queryDeltaBin(s, at()).status).toBe("FINAL");
  });
  it("UNKNOWN retains observed B/S/U/Vraw while withholding V and Delta", () => {
    const b = queryDeltaBin(replay("UNKNOWN")[0], at());
    expect([b.B, b.S, b.U, b.V_raw, b.V, b.delta]).toEqual([23n, 4n, 5n, 32n, null, null]);
    expect(b.quality).toBe("INCOMPLETE"); expect(b.status).toBe("INCOMPLETE");
  });
  it("UNKNOWN qty0 does not become a valid zero classification", () => {
    let s = ingestDeltaTrade(empty(), { ...trade(1, 1n, 0, "UNKNOWN"), classification: "UNKNOWN" });
    const b = queryDeltaBin(s, at()); expect(b.U).toBe(0n); expect(b.delta).toBeNull();
    expect(b.issues).toContain("INCOMPLETE_CLASSIFICATION");
  });
  it("GAP is NO DATA, never Delta0, even with observed Trades", () => {
    const b = queryDeltaBin(replay("GAP")[0], at());
    expect(b.quality).toBe("NO DATA"); expect(b.delta).toBeNull(); expect(b.status).toBe("INCOMPLETE");
    expect(b.V_raw).toBe(27n);
  });
  it("distinguishes observed empty zero, explicit GAP and unobserved time", () => {
    const s = replay("ZERO")[0];
    expect([0n, 2n, 8n].map(i => queryDeltaBin(s, at(i * S)).delta)).toEqual([0n, 0n, 0n]);
    expect(queryDeltaBin(s, at()).status).toBe("FINAL");
    expect(queryDeltaBin(s, at(8n * S)).status).toBe("PROVISIONAL");
    for (const n of [4n, 6n, 10n]) {
      const b = queryDeltaBin(s, at(n * S));
      expect(b.delta).toBeNull(); expect(b.quality).toBe("NO DATA");
    }
  });
  it("requires explicit same-scope event-time alignment, not absence of activity", () => {
    const unaligned = createDeltaTimeline(source.header, source.quality);
    expect(queryDeltaBin(unaligned, at()).delta).toBeNull();
    expect(queryDeltaBin(unaligned, at()).issues).toContain("NO_ALIGNED_COVERAGE");
    expect(() => createDeltaTimeline(source.header, source.quality,
      { ...source.alignment, evidence: "" })).toThrow(/alignment/);
    expect(() => createDeltaTimeline(source.header, source.quality, { ...source.alignment,
      scope: { ...source.alignment.scope, sessionId: "other" } })).toThrow(/alignment/);
  });
  it("does not bridge a 1ns observation hole", () => {
    const quality: readonly DataQualityInterval[] = [
      { channel: "TRADES", startNs: at(), endNs: at(S), status: "VALID", reason: "Before" },
      { channel: "TRADES", startNs: at(S + 1n), endNs: at(2n * S), status: "VALID", reason: "After hole" },
    ];
    expect(queryDeltaBin(createDeltaTimeline(source.header, quality, source.alignment), at()).delta).toBeNull();
  });
  it("preserves R01's rejection of zero-duration quality intervals", () => {
    expect(() => createDeltaTimeline(source.header, [
      { channel: "TRADES", startNs: at(S), endNs: at(S), status: "GAP", reason: "Invalid empty interval" },
    ], source.alignment)).toThrow(/quality interval bounds/);
  });
  it("late new-ID Trade revises the original exchange-time bin, never the receive-time bin", () => {
    const before = replay("LATE", 2)[0], after = replay("LATE", 3)[0];
    expect(queryDeltaBin(before, at()).status).toBe("FINAL");
    const revised = queryDeltaBin(after, at());
    expect([revised.B, revised.S, revised.V, revised.delta, revised.revision, revised.status])
      .toEqual([23n, 64n, 87n, -41n, 1, "REVISED"]);
    expect(queryDeltaBin(after, at(6n * S)).delta).toBe(0n);
    expect(after.tradeState.store.trades).toHaveLength(4);
    expect(queryDeltaBin(replay("LATE", 4)[0], at()).revision).toBe(1);
  });
  it("revises a formerly observed-and-sealed empty time bucket on first late Trade", () => {
    const s = progress(empty());
    expect(queryDeltaBin(s, at()).status).toBe("FINAL");
    const revised = queryDeltaBin(ingestDeltaTrade(s, trade(1, 1n, 5)), at());
    expect([revised.delta, revised.status, revised.revision]).toEqual([5n, "REVISED", 1]);
  });
  it("late arrivals at a new PRICE bucket still revise the already-sealed TIME bucket", () => {
    const s = replay("PAIR", 2)[0], next = ingestDeltaTrade(s, trade(1, S, 7, "SELL", 80020));
    expect(queryDeltaBin(next, at()).delta).toBe(12n);
    expect(queryDeltaBin(next, at()).status).toBe("REVISED");
    expect(queryDeltaBin(next, at()).revision).toBe(1);
  });
  it.each(["GAP", "RESYNCING"] as const)("holds pending revision and watermark during %s, then revises exactly once", gate => {
    const initial = replay("PAIR", 2)[0], wm = initial.tradeState.watermarkNs;
    const blocked = ingestDeltaTrade(setDeltaCondition(initial, gate), trade(1, S, 7));
    expect(blocked.tradeState.watermarkNs).toBe(wm);
    expect(queryDeltaBin(blocked, at()).delta).toBeNull();
    expect(queryDeltaBin(blocked, at()).revision).toBe(0);
    const restored = setDeltaCondition(blocked, "VALID");
    expect(queryDeltaBin(restored, at()).revision).toBe(1);
    expect(queryDeltaBin(setDeltaCondition(restored, "VALID"), at()).revision).toBe(1);
  });
  it.each(["CORRECTION", "CANCEL"] as const)("%s remains unsupported, scope-wide INCOMPLETE and never applied", id => {
    const fixture = R11_DELTA_CASES.find(c => c.id === id)!;
    const s = replay(id, fixture.steps.length)[0], b = queryDeltaBin(s, at());
    expect(s.tradeState.store.trades).toHaveLength(3);
    expect([b.B, b.S, b.V_raw, b.delta, b.status]).toEqual([23n, 4n, 27n, null, "INCOMPLETE"]);
    expect(b.issues).toContain("UNSUPPORTED_REVISION");
    expect(queryDeltaBin(s, at(6n * S)).delta).toBeNull();
  });
  it("requires same-scope trusted event-time progress and ignores wallclock (not an API input)", () => {
    expect(() => advanceDeltaWatermark(empty(), { exchangeTimeNs: at(5n * S), trusted: true,
      evidence: "MOCK", scope: { ...source.alignment.scope, sessionId: "other" } })).toThrow();
    expect(() => advanceDeltaWatermark(empty(), { exchangeTimeNs: at(5n * S), trusted: true,
      evidence: "", scope: source.alignment.scope })).toThrow();
  });
  it("leaves original Trades, prior Delta state, and R09 BubbleState untouched", () => {
    const s = replay("PAIR", 2)[0], before = snapshot(s), fixture = snapshot(F04_TRADES);
    const next = ingestDeltaTrade(s, trade(1, S, 7));
    projectDeltaTimeline(queryDeltaTimeline(next, at(), at(10n * S)), viewport());
    expect(snapshot(s)).toBe(before); expect(snapshot(F04_TRADES)).toBe(fixture);
  });
});
describe("R11 histogram geometry over the single shared R05 viewport", () => {
  const bins = () => replay("PAIR", 2).map((s, i) => queryDeltaBin(s, at(BigInt(i * 2) * S)));
  it("has a centered zero line, symmetric +-20.9 scale and correct positive/negative directions", () => {
    const f = projectDeltaTimeline(bins(), viewport());
    expect(f.zeroY).toBe(63); expect(f.maxAbsDelta).toBe(19n);
    expect([f.scaleLimitNumerator, f.scaleLimitDenominator]).toEqual([209n, 10n]);
    expect(f.bars.map(b => b.direction)).toEqual(["UP", "DOWN"]);
    expect(f.bars[0].top).toBeCloseTo(63 - 19 / 20.9 * 63, 12);
    expect(f.bars[0].bottom).toBe(63);
    expect(f.bars[1].top).toBe(63);
    expect(f.bars[1].bottom).toBeCloseTo(63 + 2 / 20.9 * 63, 12);
  });
  it("uses +-1 when all valid values are zero; missing data has no numerical bar geometry", () => {
    const s = replay("ZERO")[0], f = projectDeltaTimeline(queryDeltaTimeline(s, at(), at(10n * S)), viewport());
    expect([f.scaleLimitNumerator, f.scaleLimitDenominator]).toEqual([1n, 1n]);
    expect(f.bars[0].direction).toBe("ZERO"); expect(f.bars[0].top).toBe(63);
    for (const i of [2, 3]) {
      expect(f.bars[i].direction).toBe("NO DATA");
      expect(f.bars[i].top).toBeNull(); expect(f.bars[i].bottom).toBeNull();
    }
  });
  it("gives UNKNOWN a nonnumerical INCOMPLETE representation", () => {
    const f = projectDeltaTimeline([queryDeltaBin(replay("UNKNOWN")[0], at())], viewport());
    expect(f.bars[0].direction).toBe("INCOMPLETE"); expect(f.bars[0].top).toBeNull();
  });
  it("renders provisional at .45 and FINAL/REVISED at .92", () => {
    expect(projectDeltaTimeline([queryDeltaBin(replay()[0], at())], viewport()).bars[0].opacity).toBe(.45);
    expect(projectDeltaTimeline(bins(), viewport()).bars.every(b => b.opacity === .92)).toBe(true);
    expect(projectDeltaTimeline([queryDeltaBin(replay("LATE", 3)[0], at())], viewport()).bars[0].opacity).toBe(.92);
  });
  it.each([1, 2])("shares exact start/end X coordinates, CSS origin and widths at DPR%i", dpr => {
    const v = viewport(dpr), f = projectDeltaTimeline(bins(), v);
    for (const b of f.bars) {
      expect(b.x0).toBe(timeToX(v, b.bin.startNs)); expect(b.x1).toBe(timeToX(v, b.bin.endNs));
    }
    expect(f.bars[0].x1).toBe(f.bars[1].x0);
    expect(f.plot).toEqual({ left: 20, width: 1000 });
  });
  it("reprojects on zoom/HISTORY/resize without changing source values or creating a time axis", () => {
    const v = viewport(), b = bins(), before = snapshot(b);
    for (const next of [zoomTime(v, 800, .5), panTime(v, 50), resizeViewport(v, { ...v.bounds, width: 1500 }, 2)]) {
      const f = projectDeltaTimeline(b, next);
      for (const p of f.bars) expect(p.x0).toBe(timeToX(next, p.bin.startNs));
    }
    expect(projectDeltaTimeline(b, viewport(2))).toEqual(projectDeltaTimeline(b, viewport(1)));
    expect(snapshot(b)).toBe(before);
  });
  it("scales using only visible values and preserves partial bin time boundaries", () => {
    const v = viewport(), narrow = { ...v, time: { minNs: at(2n * S + 1n), maxNs: at(4n * S) } };
    const f = projectDeltaTimeline(bins(), narrow);
    expect(f.maxAbsDelta).toBe(2n); expect(f.bars).toHaveLength(1);
    expect(f.bars[0].x0).toBeLessThan(v.bounds.left);
  });
  it("queries [start,end) with exact epoch bins, no zero-filled session stitching", () => {
    const [a, b] = replay();
    expect(queryDeltaTimeline(a, at(), at(2n * S))).toHaveLength(1);
    expect(queryDeltaTimeline(b, at(2n * S), at(4n * S))).toHaveLength(1);
    expect(queryDeltaTimeline(a, at(1n), at(2n * S + 1n))).toHaveLength(2);
    expect(queryDeltaTimeline(a, at(), at())).toHaveLength(0);
    expect(() => queryDeltaTimeline(a, at(S), at())).toThrow();
  });
});
