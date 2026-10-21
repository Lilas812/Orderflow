import { describe, it, expect } from "vitest";
import { R12_LADDER_SCENARIOS, R12_LADDER_EXPECTED, F01_BOOK, F02_TWO_TICKS, F07_SEQUENCE_GAP, F04_TRADES } from "../../fixtures/src/index";
import { createMarketQualityState, ingestMarketEvent, markChannelCondition, currentQuality, type MarketQualityState } from "./qualityTimeline";
import { buildLadderView } from "./ladderView";
import { createViewport, resizeViewport, panPrice, zoomPrice, panTime, goLatest, tickToY, autoPrice } from "./viewport";
import { createTradeStore, ingestTrade, withTradeQuality } from "./tradeStore";
import { aggregateTrades } from "./bubbleAggregate";
import { createDeltaTimeline, ingestDeltaTrade, queryDeltaBin } from "./deltaTimeline";
import { restingQuantity, type L2Snapshot } from "./events";

const scenario = (id = "NORMAL") => R12_LADDER_SCENARIOS.find(s => s.id === id)!;
const vp = (dpr = 1) => createViewport({ bounds: { left: 0, top: 0, width: 1000, height: 400 }, dpr,
  latestNs: scenario().endNs, price: { minTick: 79992, maxTick: 80012 } });
function replay(id = "NORMAL", index = 0) {
  const s = scenario(id);
  let state = createMarketQualityState(s.config, s.startNs), count = 0;
  for (const step of s.steps.slice(0, index + 1)) {
    while (count < step.eventCount) state = ingestMarketEvent(state, s.events[count++]).state;
    if (step.condition) {
      const c = step.condition;
      state = markChannelCondition(state, c.channel, c.status, c.atNs, c.reason);
    }
  }
  return state;
}
const proof = (id: string, state: MarketQualityState) => scenario(id).topEvidence.find(e => e.snapshotCoversSequence === state.lastGoodBook.snapshotCoversSequence);
const view = (id = "NORMAL", index = 0) => {
  const state = replay(id, index);
  return buildLadderView(state, vp(), proof(id, state));
};
const row = (tick: number, id = "NORMAL", index = 0) => view(id, index).rows.find(r => r.priceTicks === tick)!;
const serialize = (o: unknown): string => JSON.stringify(o, (_, v) => v instanceof Map ? [...v] : typeof v === "bigint" ? v.toString() : v);

describe("R12 current MBP quantities, independent from history/Trade/filters", () => {
  it("matches the independent new fixture exactly, with separate BID/ASK", () => {
    expect(row(80000).bid).toEqual({ status: "KNOWN", qty: 60 });
    expect(row(80001).bid.qty).toBe(20); expect(row(80002).ask.qty).toBe(30); expect(row(80003).ask.qty).toBe(15);
    expect(row(80000).ask.qty).toBe(0); expect(row(80002).bid.qty).toBe(0);
    expect(R12_LADDER_EXPECTED.normal.bestBidTick).toBe(80001);
    expect(row(80000).priceLabel).toBe("20000.00"); expect(row(80001).priceLabel).toBe("20000.25");
  });
  it.each([["F01", 80000], ["F02", 80000]] as const)("%s preserves 40/80/0/60/60/0 without mixing source sessions", (id, tick) => {
    const values = scenario(id).steps.map((_, i) => row(tick, id, i).bid.qty);
    expect(values).toEqual(R12_LADDER_EXPECTED.f01Quantities);
    expect(view(id).identity!.sessionId).toBe(id === "F01" ? "MOCK-F-01" : "MOCK-F-02");
  });
  it("F01 at six seconds is current60, never the ten-second TWA38", () => {
    expect(row(80000, "F01", 4).bid.qty).toBe(60);
    expect(view("F01", 4).asOfNs).toBe("1767225605000000000");
    expect(scenario("F01").steps[4].asOfNs).toBe("1767225606000000000");
    expect(F01_BOOK.expected.timeWeightedAverage).toBe(38);
  });
  it.each([0, 1, 2, 3, 4, 5])("F02 keeps independent Tick80001=20 at step%i", i => {
    expect(row(80001, "F02", i).bid.qty).toBe(20);
  });
  it("SET replaces, DELETE keeps known0, re-add restores60", () => {
    expect([0, 1, 2, 3].map(i => row(80000, "NORMAL", i).bid.qty)).toEqual([60, 80, 0, 60]);
    expect(row(80000, "NORMAL", 2).bid.status).toBe("KNOWN");
    expect(row(80000, "NORMAL", 2).ask.qty).toBe(0);
  });
  it("unknown omitted ASK in original F01 is not zero", () => {
    expect(row(80000, "F01").ask).toEqual({ status: "UNKNOWN", qty: null });
    expect(row(80001, "F01").bid).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
  });
  it("PRICE_RANGE respects inclusive boundaries and does not zero-fill outside", () => {
    for (const t of [79998, 80005]) expect(row(t).bid.status).toBe("KNOWN");
    for (const t of [79997, 80006]) expect(row(t).bid).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
  });
  it("FULL missing levels remain UNKNOWN, not invented0", () => {
    expect(row(80006, "FULL").bid).toEqual({ status: "UNKNOWN", qty: null });
    expect(view("FULL").topOfBookGuaranteed).toBe(false);
  });
  it("TOP_N has separate side-specific envelopes and no inferred globalBest", () => {
    expect(row(80001, "TOP_N").bid.qty).toBe(20);
    expect(row(80001, "TOP_N").ask.status).toBe("OUTSIDE_DEPTH");
    expect(row(80002, "TOP_N").bid.status).toBe("OUTSIDE_DEPTH");
    expect(row(80002, "TOP_N").ask.qty).toBe(30);
    expect(view("TOP_N").topOfBookGuaranteed).toBe(false);
  });
  it("NOT_INITIALIZED and no selected source cannot become zero", () => {
    expect(view("NOT_INITIALIZED").rows.every(r => r.bid.qty === null && r.ask.qty === null)).toBe(true);
    expect(buildLadderView(null, vp()).quality).toBe("NOT_INITIALIZED");
    expect(buildLadderView(null, { ...vp(), price: null }).rows).toHaveLength(0);
  });
  it.each([4, 5])("GAP/RESYNCING at step%i withholds all stale quantities", i => {
    const state = replay("NORMAL", i), v = view("NORMAL", i);
    expect(v.quality).toBe(i === 4 ? "GAP" : "RESYNCING");
    expect(v.rows.every(r => r.bid.qty === null && r.ask.qty === null)).toBe(true);
    expect(state.lastGoodBook.bids.get(80000)).toBe(60); // retained diagnostic only; rejected100 never applied.
    expect(v.bestBidTick).toBeNull(); expect(v.observedBidTick).toBeNull();
  });
  it("only new valid covering snapshot restores the current board and Best", () => {
    expect(view("NORMAL", 6).quality).toBe("VALID"); expect(row(80000, "NORMAL", 6).bid.qty).toBe(60);
    expect(view("NORMAL", 6).bestBidTick).toBe(80001);
    expect(replay("NORMAL", 6).lastGoodBook.snapshotCoversSequence).toBe("7");
  });
  it("STALE retains observation time, never publishes old values as current", () => {
    const v = view("STALE", 1);
    expect(v.quality).toBe("STALE"); expect(v.asOfNs).toBe(scenario().startNs);
    expect(v.rows.every(r => r.bid.qty === null && r.ask.qty === null)).toBe(true);
    expect(v.warnings.join(" ")).toContain("現在値ではない");
    expect(view("STALE", 3).quality).toBe("VALID");
  });
  it("L1 missing and Trade-only GAP leave valid L2 numbers unchanged", () => {
    const s = replay("TRADE_GAP", 1);
    expect(currentQuality(s.timeline, "TRADES").status).toBe("GAP");
    expect(currentQuality(s.timeline, "L1").status).toBe("NOT_INITIALIZED");
    expect(row(80000, "TRADE_GAP", 1).bid.qty).toBe(60); expect(view("TRADE_GAP", 1).quality).toBe("VALID");
  });
  it("original F07 gaps only L2, reconnect remainsinvalid, original recovery restores", () => {
    const g = replay("F07", 2);
    expect(currentQuality(g.timeline, "TRADES").status).toBe("VALID");
    expect(view("F07", 2).quality).toBe("GAP");
    expect(view("F07", 3).quality).toBe("RESYNCING");
    expect(view("F07", 4).quality).toBe("VALID");
    expect(row(80000, "F07", 4).bid.qty).toBe(40);
  });
  it.each(["canonicalInstrumentId", "sourceId", "sessionId"] as const)("foreign %s cannot alter this Ladder scope", field => {
    const state = replay(), event = scenario().events[1];
    const next = ingestMarketEvent(state, { ...event, header: { ...event.header,
      [field]: field === "canonicalInstrumentId" ? "CME:NQ:2026-06" : "FOREIGN" } });
    expect(next.applied).toBe(false); expect(next.state).toBe(state);
    expect(buildLadderView(next.state, vp()).identity![field]).toBe(state.config.identity[field]);
  });
});

describe("R12 Best evidence, abnormal boards, precision and immutability", () => {
  it("derives valid positive Best from the board with scoped completeness evidence", () => {
    const v = view();
    expect([v.bestBidTick, v.bestAskTick, v.topOfBookGuaranteed]).toEqual([80001, 80002, true]);
    expect(row(80001).isBestBid).toBe(true); expect(row(80002).isBestAsk).toBe(true);
    expect(v.crossed).toBe(false);
  });
  it("does not label known0 as Best, including after deletion of a current Best", () => {
    const s = replay(), initial = scenario().events[0] as L2Snapshot;
    const t = { ...scenario().events[1], side: "BID", kind: "L2_DELETE_LEVEL", priceTicks: 80001, qty: 0 };
    const next = ingestMarketEvent(s, t).state;
    const v = buildLadderView(next, vp(), scenario().topEvidence[0]);
    expect(v.bestBidTick).toBe(80000); expect(v.rows.find(r => r.priceTicks === 80001)!.bid.qty).toBe(0);
    expect(initial.bids.find(l => l.priceTicks === 80001)!.qty).toBe(20);
  });
  it("missing/wrong-scope/wrong-generation evidence cannot promote a range candidate to marketBest", () => {
    const state = replay(), e = scenario().topEvidence[0];
    for (const bad of [undefined, { ...e, snapshotCoversSequence: "999" },
      { ...e, identity: { ...e.identity, sessionId: "FOREIGN" } }, { ...e, evidence: "" }]) {
      const v = buildLadderView(state, vp(), bad);
      expect(v.bestBidTick).toBeNull(); expect(v.observedBidTick).toBe(80001);
      expect(v.warnings.join(" ")).toContain("市場全体のBest未保証");
    }
  });
  it("even evidence cannot hide unknown potentially-better prices", () => {
    const original = scenario().events[0] as L2Snapshot;
    const snap = { ...original, bids: original.bids.filter(l => l.priceTicks !== 80004) };
    const state = ingestMarketEvent(createMarketQualityState(scenario().config, scenario().startNs), snap).state;
    expect(buildLadderView(state, vp(), scenario().topEvidence[0]).bestBidTick).toBeNull();
  });
  it("crossed and same-price two-sided quantities are retained without repair", () => {
    const v = view("CROSS");
    expect(v.crossed).toBe(true); expect(v.bestBidTick).toBe(80003); expect(v.bestAskTick).toBe(80002);
    expect([row(80003, "CROSS").bid.qty, row(80003, "CROSS").ask.qty]).toEqual([9, 15]);
    expect(v.warnings.join()).toContain("CROSSED");
  });
  it("locked books are distinguished from crossed books", () => {
    const original = scenario().events[0] as L2Snapshot;
    const snap = { ...original, bids: original.bids.map(l => l.priceTicks === 80002 ? { ...l, qty: restingQuantity(9) } : l) };
    const s = ingestMarketEvent(createMarketQualityState(scenario().config, scenario().startNs), snap).state;
    const v = buildLadderView(s, vp(), scenario().topEvidence[0]);
    expect(v.locked).toBe(true); expect(v.crossed).toBe(false);
    expect(v.rows.find(r => r.priceTicks === 80002)!.bid.qty).toBe(9);
  });
  it("HISTORY/time zoom/latest never rewind or alter the latest selected board", () => {
    const state = replay("NORMAL", 3), base = vp(), old = serialize(state);
    const times = [base, panTime(base, 400), goLatest(panTime(base, 400))];
    const values = times.map(v => buildLadderView(state, v, proof("NORMAL", state)));
    expect(values.map(v => v.asOfNs)).toEqual(Array(3).fill(values[0].asOfNs));
    expect(values.every(v => v.rows.find(r => r.priceTicks === 80000)!.bid.qty === 60)).toBe(true);
    expect(serialize(state)).toBe(old);
  });
  it.each([1, 2])("shares exact Y coordinates at DPR%i, including nonzero plot origin", dpr => {
    const state = replay(), base = { ...vp(dpr), bounds: { left: 20, top: 11, width: 700, height: 420 } };
    const v = buildLadderView(state, base);
    for (const tick of [80000, 80001]) expect(v.rows.find(r => r.priceTicks === tick)!.y).toBe(tickToY(base, tick));
    expect(v.rows.map(r => r.priceTicks)).toEqual([...v.rows.map(r => r.priceTicks)].sort((a, b) => b - a));
  });
  it("reprojects shared prices on zoom, drag and resize without mutating data", () => {
    const s = replay(), before = serialize(s), v = vp();
    for (const next of [zoomPrice(v, 200, .5), panPrice(v, 40), resizeViewport(v, { ...v.bounds, width: 600, height: 500 }, 2)]) {
      const rows = buildLadderView(s, next).rows;
      for (const r of rows) expect(r.y).toBe(tickToY(next, r.priceTicks));
      expect(rows.find(r => r.priceTicks === 80000)!.bid.qty).toBe(60);
      expect(next.time).toBe(v.time);
    }
    expect(serialize(s)).toBe(before);
  });
  it("AUTO without Trades keeps the verification range and declares no Trade price", () => {
    const v = autoPrice(vp(), [], []);
    expect(v.priceMode).toBe("AUTO"); expect(v.priceData).toBe("NO TRADE PRICE");
    expect(v.price).toEqual(vp().price);
  });
  it("density only suppresses labels at their own exact Tick, never reassigning quantities", () => {
    const v = { ...vp(), price: { minTick: 70000, maxTick: 90000 } }, frame = buildLadderView(replay(), v);
    expect(frame.densityStep).toBeGreaterThan(1); expect(frame.rows.length).toBeLessThan(40);
    const best = frame.rows.find(r => r.priceTicks === 80001)!;
    expect(best.bid.qty).toBe(20); expect(best.y).toBe(tickToY(v, 80001));
  });
  it("handles negative ranges and enormous safe ranges without allocating every Tick", () => {
    for (const price of [{ minTick: -110, maxTick: -90 }, { minTick: -4503599627370495, maxTick: 4503599627370495 }]) {
      const f = buildLadderView(null, { ...vp(), price });
      expect(f.rows.length).toBeLessThan(40);
      expect(f.rows.every(r => Number.isSafeInteger(r.priceTicks) && Number.isFinite(r.y))).toBe(true);
    }
  });
  it("pricezoom/quantity display has no path to mutate normalized Trades or Delta", () => {
    let store = createTradeStore(F04_TRADES.events[0].header);
    store = withTradeQuality(store, [{ channel: "TRADES", startNs: F04_TRADES.expected.startNs, endNs: F04_TRADES.expected.endNs, status: "VALID", reason: "MOCK" }]);
    let delta = createDeltaTimeline(F04_TRADES.events[0].header, store.quality, {
      scope: store.scope, timeAxis: "EXCHANGE_TIME_NS", evidence: "Explicit MOCK exchange-time observation" });
    for (const t of F04_TRADES.events) { store = ingestTrade(store, t).store; delta = ingestDeltaTrade(delta, t); }
    const before = serialize([store, delta]), board = replay();
    for (const factor of [.5, 1, 2, 10]) buildLadderView(board, zoomPrice(vp(), 200, factor));
    expect(aggregateTrades(store)[0].delta).toBe(19n);
    expect(queryDeltaBin(delta, F04_TRADES.expected.startNs).delta).toBe(19n);
    expect(serialize([store, delta])).toBe(before);
  });
  it("readmodel depends on neither heatmap filter nor raw fixture modifications", () => {
    const state = replay(), before = serialize([state, F01_BOOK, F02_TWO_TICKS, F07_SEQUENCE_GAP]);
    const a = buildLadderView(state, vp()), b = buildLadderView(state, vp());
    expect(a).toEqual(b);
    expect(serialize([state, F01_BOOK, F02_TWO_TICKS, F07_SEQUENCE_GAP])).toBe(before);
    expect(scenario("F01").events).toBe(F01_BOOK.events);
    expect(scenario("F02").events).toBe(F02_TWO_TICKS.events);
    expect(scenario("F07").events[2]).toBe(F07_SEQUENCE_GAP.events[2]);
  });
});
