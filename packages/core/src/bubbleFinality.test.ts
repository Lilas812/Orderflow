import { describe, expect, it } from "vitest";
import { R09_SCENARIOS, R09_BUBBLE_EXPECTED, F04_TRADES, F05_TRADES } from "../../fixtures/src/index";
import type { BubbleDemoScenario } from "../../fixtures/src/r09-bubbles";
import { executedVolume, type Trade } from "./events";
import { createTradeStore, ingestTrade, withTradeQuality } from "./tradeStore";
import { evaluateBubbleFilter, aggregateTradeBucket } from "./bubbleAggregate";
import {
  createBubbleFinality, ingestBubbleTrade, advanceBubbleWatermark, setBubbleCondition,
  bubbleIdentity, bubbleOpacity, projectAcceptedBubbleState, type BubbleFinality,
} from "./bubbleFinality";

const scenario = (id: string) => R09_SCENARIOS.find(s => s.id === id)!;
describe("projection of an authoritative accepted Store", () => {
  it("shares Store identity and matches the legacy R09 fold after every Trade", () => {
    const spec = scenario("F04");
    let store = withTradeQuality(createTradeStore(spec.events[0].header), spec.quality);
    let shared: BubbleFinality | null = null, legacy = createBubbleFinality(spec.events[0].header, spec.quality);
    for (const event of spec.events) {
      const accepted = ingestTrade(store, event); store = accepted.store;
      shared = projectAcceptedBubbleState(shared, store, "VALID",
        accepted.disposition === "ACCEPTED" ? store.trades.at(-1) : undefined);
      legacy = ingestBubbleTrade(legacy, event);
      expect(shared.store).toBe(store);
      expect(shared).toEqual(legacy);
    }
  });
  it("preserves exact finalization/revision through shared late Trades and trusted progress", () => {
    const spec = scenario("LATE");
    let store = withTradeQuality(createTradeStore(spec.events[0].header), spec.quality);
    let shared = projectAcceptedBubbleState(null, store, "VALID"), legacy = createBubbleFinality(spec.events[0].header, spec.quality);
    let cursor = 0;
    for (const step of spec.steps) {
      while (cursor < step.tradeCount) {
        const event = spec.events[cursor++];
        const next = ingestTrade(store, event); store = next.store;
        shared = projectAcceptedBubbleState(shared, store, "VALID",
          next.disposition === "ACCEPTED" ? store.trades.at(-1) : undefined);
        legacy = ingestBubbleTrade(legacy, event);
      }
      if (step.progressNs) {
        const p = { exchangeTimeNs: step.progressNs, trusted: true as const, scope: store.scope, evidence: "MOCK explicit progress" };
        shared = advanceBubbleWatermark(shared, p); legacy = advanceBubbleWatermark(legacy, p);
      }
      expect(shared).toEqual(legacy);
    }
    expect(shared.bubbles[0]).toMatchObject({ status: "REVISED", revision: 1 });
  });
  it("projects GAP without replacing the Store or mutating the previous candidate", () => {
    const s = replay(scenario("F04")), before = s.bubbles;
    const next = projectAcceptedBubbleState(s, s.store, "GAP");
    expect(next.store).toBe(s.store);
    expect(next.bubbles.every(b => b.status === "INCOMPLETE")).toBe(true);
    expect(s.bubbles).toBe(before);
  });
  it("rejects foreign scopes and unaccepted progress Trades", () => {
    const s = replay(scenario("F04"));
    expect(() => projectAcceptedBubbleState(s, { ...s.store,
      scope: { ...s.store.scope, sessionId: "FOREIGN" } }, "VALID")).toThrow();
    expect(() => projectAcceptedBubbleState(s, s.store, "VALID", { ...F04_TRADES.events[0] })).toThrow();
  });
});
function initial(s = scenario("F04")) { return createBubbleFinality(s.events[0].header, s.quality); }
function trusted(s: BubbleFinality, offset: bigint) {
  return advanceBubbleWatermark(s, { exchangeTimeNs: (1767261600000000000n + offset).toString(),
    trusted: true, evidence: "Explicit R09 MOCK progress, never a wallclock", scope: s.store.scope });
}
function replay(s: BubbleDemoScenario, stage = s.steps.length - 1) {
  let state = initial(s), cursor = 0;
  for (const step of s.steps.slice(0, stage + 1)) {
    for (; cursor < step.tradeCount; cursor++) state = ingestBubbleTrade(state, s.events[cursor]);
    if (step.condition) state = setBubbleCondition(state, step.condition);
    if (step.progressNs) state = advanceBubbleWatermark(state, {
      exchangeTimeNs: step.progressNs, trusted: true, evidence: "R09 MOCK explicit trusted progress",
      scope: state.store.scope,
    });
  }
  return state;
}
describe("R09 event-time finality and original R08 unique Trade aggregation", () => {
  it("starts empty with no synthetic clock or bubble", () => {
    const s = initial();
    expect(s.bubbles).toEqual([]); expect(s.watermarkNs).toBeNull();
    expect(s.maxSeenValidExchangeNs).toBeNull();
  });
  it("F04 remains PROVISIONAL while valid exchange time has not covered end+3s", () => {
    const s = replay(scenario("F04"), 0), b = s.bubbles[0];
    expect([b.bucket.B, b.bucket.S, b.bucket.V, b.bucket.delta]).toEqual([23n, 4n, 27n, 19n]);
    expect(b.bucket.imbalancePercent).toBeCloseTo(70.37037037037037, 12);
    expect(evaluateBubbleFilter(b.bucket).pass).toBe(true);
    expect(b.status).toBe("PROVISIONAL"); expect(b.revision).toBe(0);
    expect(bubbleOpacity(b)).toBe(.45);
    expect(s.watermarkNs).toBe("1767261598700000000");
  });
  it("seals exactly at watermark == bucketEnd with trusted exchange progress", () => {
    let s = replay(scenario("F04"), 0);
    s = trusted(s, 4_999_999_999n);
    expect(s.bubbles[0].status).toBe("PROVISIONAL");
    s = trusted(s, 5_000_000_000n);
    expect(s.bubbles[0].status).toBe("FINAL"); expect(bubbleOpacity(s.bubbles[0])).toBe(.92);
    expect(s.watermarkNs).toBe(F04_TRADES.expected.endNs);
    expect(s.bubbles[0].id).toBe(bubbleIdentity(s.bubbles[0].bucket));
  });
  it("valid new Trade in a later bucket can advance event-time finality", () => {
    const s = replay(scenario("F04"), 0);
    const t: Trade = { ...F04_TRADES.events[0], tradeId: "MOCK-R09-PROGRESS-TRADE",
      header: { ...F04_TRADES.events[0].header, eventId: "MOCK-R09-PROGRESS-E",
        exchangeTimeNs: "1767261605000000000", receiveTimeNs: "1767261606000000000" } };
    const next = ingestBubbleTrade(s, t);
    expect(next.bubbles[0].status).toBe("FINAL");
    expect(next.bubbles[1].status).toBe("PROVISIONAL");
    expect(next.bubbles[0].bucket.V).toBe(27n);
  });
  it("does not use receive-time or wallclock to finalize", () => {
    const s = initial();
    const t = { ...F04_TRADES.events[0], header: { ...F04_TRADES.events[0].header,
      receiveTimeNs: "999999999999999999999999999999999999" } };
    const next = ingestBubbleTrade(s, t);
    expect(next.maxSeenValidExchangeNs).toBe(F04_TRADES.events[0].header.exchangeTimeNs);
    expect(next.bubbles[0].status).toBe("PROVISIONAL");
  });
  it("retains ID and updates BUY→SELL→BUY with each stage passing default filters", () => {
    const s = scenario("FLIP"), ids: string[] = [];
    R09_BUBBLE_EXPECTED.flip.forEach((expected, i) => {
      const b = replay(s, i).bubbles[0]; ids.push(b.id);
      expect([b.bucket.B, b.bucket.S, b.bucket.V, b.bucket.delta])
        .toEqual([expected.buy, expected.sell, expected.volume, expected.delta].map(BigInt));
      expect(b.status).toBe("PROVISIONAL"); expect(b.revision).toBe(0);
      expect(evaluateBubbleFilter(b.bucket).pass).toBe(true);
    });
    expect(new Set(ids).size).toBe(1);
  });
  it("FINAL→REVISED reaggregates late new ID into exchange-time not receive-time", () => {
    const s = scenario("LATE"), before = replay(s, 1), after = replay(s, 2);
    expect(before.bubbles[0].status).toBe("FINAL");
    const b = after.bubbles[0];
    expect(after.bubbles).toHaveLength(1); expect(b.id).toBe(before.bubbles[0].id);
    expect([b.bucket.B, b.bucket.S, b.bucket.V, b.bucket.delta]).toEqual([23n, 64n, 87n, -41n]);
    expect(b.status).toBe("REVISED"); expect(b.revision).toBe(1); expect(bubbleOpacity(b)).toBe(.92);
    expect(b.bucket.startNs).toBe(F04_TRADES.expected.startNs);
    expect(aggregateTradeBucket(after.store, "1767261606000000000", 80000).V).toBe(0n);
    expect(after.watermarkNs).toBe(before.watermarkNs);
    expect(before.bubbles[0].bucket.V).toBe(27n);
  });
  it("retransmission retains raw audit delivery but not volume or revision", () => {
    const s = replay(scenario("LATE"));
    expect(s.store.rawEvents).toHaveLength(5); expect(s.store.trades).toHaveLength(4);
    expect(s.bubbles[0].bucket.V).toBe(87n); expect(s.bubbles[0].revision).toBe(1);
    expect(s.bubbles[0].status).toBe("REVISED");
  });
  it("increments revision for each additional accepted late unique Trade", () => {
    const s = replay(scenario("LATE")), late = scenario("LATE").events[3];
    const next = ingestBubbleTrade(s, { ...late, tradeId: "MOCK-R09-SECOND-LATE",
      header: { ...late.header, eventId: "MOCK-R09-SECOND-LATE-E" } });
    expect(next.bubbles[0].revision).toBe(2); expect(next.bubbles[0].bucket.V).toBe(147n);
  });
  it.each(["CORRECTION", "CANCEL"])("%s stays unsupported and INCOMPLETE, never falsely REVISED", id => {
    const s = replay(scenario(id)), b = s.bubbles[0];
    expect(s.store.issues[0].code).toBe("UNSUPPORTED_REVISION");
    expect(s.store.rawEvents).toHaveLength(4); expect(s.store.trades).toHaveLength(3);
    expect(b.status).toBe("INCOMPLETE"); expect(b.revision).toBe(0);
    expect(b.bucket.V).toBeNull(); expect(b.bucket.delta).toBeNull();
    expect(bubbleOpacity(b)).toBe(0); expect(evaluateBubbleFilter(b.bucket).pass).toBe(false);
    const wm = s.watermarkNs;
    expect(trusted(s, 8_000_000_000n).watermarkNs).toBe(wm);
  });
  it("F09 UNKNOWN invalidates complete V/Delta and never advances via unknown direction", () => {
    const s = replay(scenario("F09"));
    expect(s.bubbles[0].status).toBe("INCOMPLETE");
    expect(s.bubbles[0].bucket.U).toBe(5n); expect(s.bubbles[0].bucket.V_raw).toBe(32n);
    expect(s.bubbles[0].bucket.delta).toBeNull();
    expect(trusted(s, 5_000_000_000n).bubbles[0].status).toBe("INCOMPLETE");
    const t = scenario("F09").events.at(-1)!;
    expect(ingestBubbleTrade(initial(scenario("F09")), t).watermarkNs).toBeNull();
  });
  it("F05 preserves original quantities but fails the default display filter", () => {
    const b = replay(scenario("F05")).bubbles[0];
    expect([b.bucket.B, b.bucket.S, b.bucket.delta]).toEqual([12n, 14n, -2n]);
    expect(evaluateBubbleFilter(b.bucket).pass).toBe(false);
    expect(F05_TRADES.expected.pass).toBe(false);
  });
  it.each(["GAP", "RESYNC"])("%s freezes watermark and suppresses reliable display", id => {
    const s = replay(scenario(id));
    expect(s.bubbles[0].status).toBe("INCOMPLETE");
    const wm = s.watermarkNs;
    expect(trusted(s, 9_000_000_000n).watermarkNs).toBe(wm);
    expect(bubbleOpacity(s.bubbles[0])).toBe(0);
  });
  it.each(["GAP", "RESYNCING"] as const)("arrival during %s cannot advance WM", condition => {
    let s = setBubbleCondition(initial(), condition);
    s = ingestBubbleTrade(s, F04_TRADES.events[0]);
    expect(s.watermarkNs).toBeNull();
    expect(s.bubbles[0].status).toBe("INCOMPLETE");
    s = setBubbleCondition(s, "VALID");
    expect(s.bubbles[0].status).toBe("PROVISIONAL");
    expect(s.watermarkNs).toBeNull(); // no clock invented on reconnection
  });
  it("preserves FINAL sealing across temporary gate, without spurious revision", () => {
    const s = replay(scenario("F04"));
    const restored = setBubbleCondition(setBubbleCondition(s, "RESYNCING"), "VALID");
    expect(restored.bubbles[0].status).toBe("FINAL"); expect(restored.bubbles[0].revision).toBe(0);
  });
  it.each(["GAP", "RESYNCING"] as const)("retains last sealed version across late arrival during %s", condition => {
    let s = setBubbleCondition(replay(scenario("F04")), condition);
    s = ingestBubbleTrade(s, scenario("LATE").events[3]);
    expect(s.bubbles[0].status).toBe("INCOMPLETE"); expect(s.bubbles[0].revision).toBe(0);
    const restored = setBubbleCondition(s, "VALID");
    expect(restored.bubbles[0].status).toBe("REVISED"); expect(restored.bubbles[0].revision).toBe(1);
    expect(restored.bubbles[0].bucket.V).toBe(87n);
    expect(setBubbleCondition(restored, "VALID").bubbles[0].revision).toBe(1);
  });
  it("does not advance via suspect quality, unknown precision or classification", () => {
    const f = F04_TRADES.events[0];
    for (const trade of [
      { ...f, header: { ...f.header, quality: "SUSPECT" } },
      { ...f, header: { ...f.header, sourceTimePrecision: "unknown" } },
      { ...f, classification: "UNKNOWN" },
    ]) expect(ingestBubbleTrade(initial(), trade).watermarkNs).toBeNull();
  });
  it("preserves nanosecond precision and monotonic watermark", () => {
    const s = trusted(initial(), 5_000_000_001n);
    expect(s.watermarkNs).toBe("1767261602000000001");
    expect(trusted(s, 5_000_000_000n).watermarkNs).toBe(s.watermarkNs);
  });
  it("requires explicit observation coverage at the progress timestamp", () => {
    const s = createBubbleFinality(F04_TRADES.events[0].header, []);
    expect(trusted(s, 5_000_000_000n).watermarkNs).toBeNull();
    expect(ingestBubbleTrade(s, F04_TRADES.events[0]).bubbles[0].status).toBe("INCOMPLETE");
  });
  it.each(["", "01", "-1", "1.5", "1e18"])("rejects invalid progress UTC ns '%s'", exchangeTimeNs => {
    const s = initial();
    expect(() => advanceBubbleWatermark(s, { exchangeTimeNs, trusted: true,
      evidence: "MOCK", scope: s.store.scope })).toThrow();
  });
  it("rejects untrusted, unidentified or cross-scope progress", () => {
    const s = initial(), p = { exchangeTimeNs: "1767261605000000000", trusted: true as const,
      evidence: "MOCK", scope: s.store.scope };
    expect(() => advanceBubbleWatermark(s, { ...p, trusted: false as never })).toThrow();
    expect(() => advanceBubbleWatermark(s, { ...p, evidence: " " })).toThrow();
    expect(() => advanceBubbleWatermark(s, { ...p, scope: { ...p.scope, sessionId: "other" } })).toThrow();
  });
  it("does not apply MOCK lateness policy to a LIVE or replay session", () => {
    expect(() => createBubbleFinality({ ...F04_TRADES.events[0].header, environment: "LIVE" }, [])).toThrow("MOCK");
    expect(() => createBubbleFinality({ ...F04_TRADES.events[0].header,
      environment: "REPLAY_FROM_SAVED_DATA" }, [])).toThrow("MOCK");
  });
  it("rejects mixed Trade scope and invalid quantities through unchanged R08 validator", () => {
    expect(() => ingestBubbleTrade(initial(), { ...F04_TRADES.events[0], qty: .5 })).toThrow();
    expect(() => ingestBubbleTrade(initial(), { ...F04_TRADES.events[0], header: {
      ...F04_TRADES.events[0].header, sessionId: "other",
    } })).toThrow();
  });
  it("identity conflicts invalidate scope rather than revise guessed quantities", () => {
    const s = replay(scenario("F04"));
    const next = ingestBubbleTrade(s, { ...F04_TRADES.events[0], qty: executedVolume(999) });
    expect(next.bubbles[0].status).toBe("INCOMPLETE");
    expect(next.store.issues[0].code).toBe("CONFLICTING_TRADE_ID");
    expect(next.bubbles[0].revision).toBe(0);
  });
  it("does not mutate original fixtures or previously returned state", () => {
    const source = JSON.stringify(R09_SCENARIOS), before = initial();
    const stateBytes = JSON.stringify(before);
    for (const s of R09_SCENARIOS) replay(s);
    expect(JSON.stringify(R09_SCENARIOS)).toBe(source);
    expect(JSON.stringify(before)).toBe(stateBytes);
  });
  it("fixes scene count/order and deterministic audit step inputs", () => {
    expect(R09_SCENARIOS.map(s => s.id)).toEqual([
      "F04", "F05", "F09", "FLIP", "LATE", "GAP", "RESYNC", "CORRECTION", "CANCEL",
    ]);
    expect(scenario("FLIP").events.map(t => t.qty)).toEqual([20, 60, 140]);
    expect(scenario("LATE").steps.map(s => s.tradeCount)).toEqual([3, 3, 4, 5]);
  });
});
