import { describe, expect, it, vi } from "vitest";
import { F04_TRADES as F04 } from "../../fixtures/src/index";
import { executedVolume, type Trade } from "./events";
import { VolumeProfileAccumulator, VolumeProfileCapacityError } from "./volumeProfile";

function trade(priceTicks: number, qty: number, aggressor: Trade["aggressor"] = "BUY"): Trade {
  return { ...F04.events[0], priceTicks, qty: executedVolume(qty), aggressor };
}
const profile = (maxPriceLevels = 10) =>
  new VolumeProfileAccumulator(F04.events[0].header, { maxPriceLevels });
const apply = (vp: VolumeProfileAccumulator, t: Trade) => vp.prepareAccepted(t)();

describe("accepted observed Trade Volume Profile", () => {
  it("reproduces F04 without retaining original Trades or inventing market completeness", () => {
    const vp = profile();
    F04.events.forEach(t => apply(vp, t));
    expect(vp.read()).toMatchObject({
      pocTick: 80000, priceLevels: 1, volumeBasis: "ACCEPTED_OBSERVED_TRADES",
      marketCompleteness: "NOT_ASSERTED",
      totals: { buyVolume: 23n, sellVolume: 4n, unknownVolume: 0n, totalVolume: 27n, tradeCount: 3 },
    });
  });
  it("updates multiple levels independently, sorts on read and includes UNKNOWN", () => {
    const vp = profile();
    apply(vp, trade(80002, 6, "UNKNOWN"));
    apply(vp, trade(80000, 4, "SELL"));
    apply(vp, trade(80002, 3));
    const result = vp.read();
    expect(result.levels.map(l => l.priceTicks)).toEqual([80000, 80002]);
    expect(result.levels[1]).toMatchObject({ buyVolume: 3n, unknownVolume: 6n, totalVolume: 9n });
    expect(result.totals).toMatchObject({ buyVolume: 3n, sellVolume: 4n, unknownVolume: 6n, totalVolume: 13n });
    expect(result.classificationComplete).toBe(false);
  });
  it("uses lower tick for equal nonzero volume regardless of input order", () => {
    for (const ticks of [[80002, 80000], [80000, 80002]]) {
      const vp = profile();
      ticks.forEach(t => apply(vp, trade(t, 5)));
      expect(vp.read().pocTick).toBe(80000);
      apply(vp, trade(80002, 1));
      expect(vp.read().pocTick).toBe(80002);
      apply(vp, trade(80000, 1));
      expect(vp.read().pocTick).toBe(80000);
    }
  });
  it("same accepted Trade set has identical quantities/POC even in reversed event-time order", () => {
    const a = profile(), b = profile();
    F04.events.forEach(t => apply(a, t));
    [...F04.events].reverse().forEach(t => apply(b, t));
    expect(a.read()).toEqual(b.read());
  });
  it("empty and accepted zero-quantity Trades never create a positive POC", () => {
    const vp = profile();
    expect(vp.read().pocTick).toBeNull();
    apply(vp, trade(80000, 0));
    expect(vp.read().pocTick).toBeNull();
    expect(vp.read().totals).toMatchObject({ totalVolume: 0n, tradeCount: 1 });
  });
  it("sums beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const vp = profile();
    apply(vp, trade(80000, Number.MAX_SAFE_INTEGER));
    apply(vp, trade(80000, Number.MAX_SAFE_INTEGER));
    expect(vp.read().totals.totalVolume).toBe(18014398509481982n);
  });
  it.each([undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects missing or nonfinite/integer price cap %s", maximum => {
      expect(() => new VolumeProfileAccumulator(F04.events[0].header,
        { maxPriceLevels: maximum as number })).toThrow();
    },
  );
  it("checks capacity without partially applying and allows existing-level increments at cap", () => {
    const vp = profile(1);
    apply(vp, trade(80000, 3));
    const before = vp.read();
    expect(() => vp.prepareAccepted(trade(80001, 4))).toThrow(VolumeProfileCapacityError);
    expect(vp.read()).toEqual(before);
    apply(vp, trade(80000, 2));
    expect(vp.read().totals.totalVolume).toBe(5n);
    expect(() => profile(0).prepareAccepted(trade(80000, 0))).toThrow(VolumeProfileCapacityError);
  });
  it("preparing or abandoning a candidate never changes the published result", () => {
    const vp = profile();
    const before = vp.read();
    const commit = vp.prepareAccepted(trade(80000, 3));
    expect(vp.read()).toEqual(before);
    commit();
    const after = vp.read();
    expect(() => commit()).toThrow();
    expect(vp.read()).toEqual(after);
  });
  it("rejects stale candidates rather than replacing a newer update", () => {
    const vp = profile();
    const stale = vp.prepareAccepted(trade(80000, 9));
    apply(vp, trade(80000, 2));
    expect(() => stale()).toThrow();
    expect(vp.read().totals.totalVolume).toBe(2n);
  });
  it("a prepared candidate does not alias a caller's mutable Trade", () => {
    const vp = profile(), input = { ...trade(80000, 3) };
    const commit = vp.prepareAccepted(input);
    input.priceTicks = 80002;
    commit();
    expect(vp.read()).toMatchObject({ pocTick: 80000, levels: [{ priceTicks: 80000 }] });
  });
  it("rejects invalid prices, quantities, foreign scopes, missing time and revisions", () => {
    const vp = profile();
    for (const t of [
      { ...trade(80000, 1), priceTicks: 80000.25 },
      { ...trade(80000, 1), qty: -1 },
      { ...trade(80000, 1), qty: 1.5 },
      { ...trade(80000, 1), header: { ...F04.events[0].header, sessionId: "OTHER" } },
      { ...trade(80000, 1), header: { ...F04.events[0].header, exchangeTimeNs: null } },
      { ...trade(80000, 1), kind: "TRADE_CANCEL", originalTradeId: "old" },
    ]) expect(() => vp.prepareAccepted(t as Trade)).toThrow();
    expect(vp.read().totals.tradeCount).toBe(0);
    expect(() => new VolumeProfileAccumulator(
      { ...F04.events[0].header, environment: "LIVE" }, { maxPriceLevels: 1 })).toThrow();
  });
  it("returns independent frozen level, total and scope objects, not the internal Map", () => {
    const vp = profile();
    apply(vp, trade(80000, 2));
    const a = vp.read(), b = vp.read();
    expect(a).toEqual(b);
    expect(a.scope).not.toBe(b.scope);
    expect(a.totals).not.toBe(b.totals);
    expect(a.levels).not.toBe(b.levels);
    expect(a.levels[0]).not.toBe(b.levels[0]);
    expect(() => { (a.levels[0] as { totalVolume: bigint }).totalVolume = 999n; }).toThrow();
    apply(vp, trade(80000, 3));
    expect(a.totals.totalVolume).toBe(2n);
    expect(vp.read().totals.totalVolume).toBe(5n);
  });
  it("per-update work does not iterate or copy the whole price Map", () => {
    const vp = profile();
    const values = vi.spyOn(Map.prototype, "values");
    const entries = vi.spyOn(Map.prototype, Symbol.iterator);
    try {
      for (let i = 0; i < 5; i++) apply(vp, trade(80000 + i, 1));
      expect(values).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
      vp.read();
      expect(values).toHaveBeenCalledTimes(1);
    } finally { values.mockRestore(); entries.mockRestore(); }
  });
  it("propagates event quality/precision/classification uncertainty without losing volume", () => {
    const vp = profile();
    apply(vp, { ...trade(80000, 7), classification: "UNKNOWN",
      header: { ...F04.events[0].header, sourceTimePrecision: "unknown", quality: "SUSPECT" } });
    expect(vp.read()).toMatchObject({ unknownTimePrecision: true, nonValidTradeQuality: true,
      classificationComplete: false, totals: { totalVolume: 7n }, marketCompleteness: "NOT_ASSERTED" });
  });
});
