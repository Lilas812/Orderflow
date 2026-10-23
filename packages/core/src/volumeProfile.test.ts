import { describe, expect, it, vi } from "vitest";
import { F04_TRADES as F04 } from "../../fixtures/src/index";
import { executedVolume, type Trade } from "./events";
import {
  VolumeProfileAccumulator, VolumeProfileCapacityError, type VolumeProfileSnapshot,
} from "./volumeProfile";

function trade(priceTicks: number, qty: number, aggressor: Trade["aggressor"] = "BUY"): Trade {
  return { ...F04.events[0], priceTicks, qty: executedVolume(qty), aggressor };
}
const profile = (maxPriceLevels = 10) =>
  new VolumeProfileAccumulator(F04.events[0].header, { maxPriceLevels });
const apply = (vp: VolumeProfileAccumulator, t: Trade) => vp.prepareAccepted(t)();

/** Deliberately literal 1-tick oracle for SMALL test domains only. */
function referenceValueArea(snapshot: VolumeProfileSnapshot) {
  const quantities = new Map(snapshot.levels.map(level => [level.priceTicks, level.totalVolume]));
  let low = snapshot.pocTick, high = low;
  let included = low === null ? 0n : quantities.get(low)!;
  if (snapshot.totals.totalVolume > 0n) {
    const minimum = snapshot.levels[0].priceTicks;
    const maximum = snapshot.levels[snapshot.levels.length - 1].priceTicks;
    while (included * 10n < snapshot.totals.totalVolume * 7n) {
      const lower = low! > minimum ? quantities.get(low! - 1) ?? 0n : null;
      const upper = high! < maximum ? quantities.get(high! + 1) ?? 0n : null;
      if (lower === null && upper === null) throw new Error("Invalid test oracle input");
      const takeLower = lower !== null && (upper === null || lower >= upper);
      const takeUpper = upper !== null && (lower === null || upper >= lower);
      if (takeLower) { low = low! - 1; included += lower!; }
      if (takeUpper) { high = high! + 1; included += upper!; }
    }
  }
  return { ratioNumerator: 7n, ratioDenominator: 10n,
    valTick: low, vahTick: high, includedVolume: included };
}

describe("read-time 70% Value Area", () => {
  const cases: { name: string; levels: [number, number][]; poc: number | null;
    bounds: [number | null, number | null]; volume: bigint }[] = [
    { name: "single price", levels: [[100, 27]], poc: 100, bounds: [100, 100], volume: 27n },
    { name: "multiple prices", levels: [[98, 10], [99, 20], [100, 40], [101, 25], [102, 5]],
      poc: 100, bounds: [99, 101], volume: 85n },
    { name: "upper priority and exactly 70%", levels: [[99, 10], [100, 40], [101, 30], [102, 20]],
      poc: 100, bounds: [100, 101], volume: 70n },
    { name: "lower priority", levels: [[98, 20], [99, 30], [100, 40], [101, 10]],
      poc: 100, bounds: [99, 100], volume: 70n },
    { name: "equal pair is indivisible", levels: [[99, 20], [100, 40], [101, 20]],
      poc: 100, bounds: [99, 101], volume: 80n },
    { name: "symmetric missing zeros", levels: [[98, 30], [100, 40], [102, 30]],
      poc: 100, bounds: [98, 102], volume: 100n },
    { name: "asymmetric missing zeros retain zero boundary", levels: [[97, 30], [100, 40], [102, 30]],
      poc: 100, bounds: [99, 102], volume: 70n },
    { name: "POC alone reaches 70%", levels: [[100, 7], [101, 3]],
      poc: 100, bounds: [100, 100], volume: 7n },
    { name: "overshoot stops immediately", levels: [[100, 6], [101, 4]],
      poc: 100, bounds: [100, 101], volume: 10n },
    { name: "integer rounding cannot truncate the threshold", levels: [[100, 2], [101, 1]],
      poc: 100, bounds: [100, 101], volume: 3n },
    { name: "POC tie remains lower tick", levels: [[100, 5], [101, 5]],
      poc: 100, bounds: [100, 101], volume: 10n },
    { name: "zero total", levels: [[100, 0], [101, 0]],
      poc: null, bounds: [null, null], volume: 0n },
  ];
  it.each(cases)("$name", ({ levels, poc, bounds, volume }) => {
    const vp = profile();
    levels.forEach(([price, qty]) => apply(vp, trade(price, qty)));
    const result = vp.read();
    expect(result.pocTick).toBe(poc);
    expect(result.valueArea).toEqual({ ratioNumerator: 7n, ratioDenominator: 10n,
      valTick: bounds[0], vahTick: bounds[1], includedVolume: volume });
    expect(result.valueArea).toEqual(referenceValueArea(result));
  });
  it("empty profile returns null boundaries", () => {
    expect(profile().read().valueArea).toEqual({ ratioNumerator: 7n, ratioDenominator: 10n,
      valTick: null, vahTick: null, includedVolume: 0n });
  });
  it("preserves bigint quantities above the safe integer limit and an exact threshold", () => {
    const vp = profile(), q = Number.MAX_SAFE_INTEGER;
    for (const [price, count] of [[99, 3], [100, 4], [101, 2], [102, 1]]) {
      for (let i = 0; i < count; i++) apply(vp, trade(price, q));
    }
    expect(vp.read().totals.totalVolume).toBe(BigInt(q) * 10n);
    expect(vp.read().valueArea).toMatchObject({
      valTick: 99, vahTick: 100, includedVolume: BigInt(q) * 7n,
    });
  });
  it("matches a literal oracle exhaustively for sparse and explicit-zero small domains", () => {
    for (let pattern = 0; pattern < 3 ** 5; pattern++) {
      for (const explicitZeros of [false, true]) {
        const vp = profile();
        let remaining = pattern;
        for (const tick of [100, 101, 103, 106, 107]) {
          const qty = remaining % 3;
          remaining = Math.floor(remaining / 3);
          if (qty || explicitZeros) apply(vp, trade(tick, qty));
        }
        const snapshot = vp.read();
        expect(snapshot.valueArea).toEqual(referenceValueArea(snapshot));
      }
    }
  });
  it("skips enormous symmetric zero runs without materializing ticks", () => {
    const vp = profile();
    [[0, 30], [1_000_000_000_000, 40], [2_000_000_000_000, 30]]
      .forEach(([tick, qty]) => apply(vp, trade(tick, qty)));
    const result = vp.read();
    expect(result.levels).toHaveLength(3);
    expect(result.valueArea).toMatchObject({ valTick: 0,
      vahTick: 2_000_000_000_000, includedVolume: 100n });
  });
  it("handles large tick boundaries and asymmetric zeros with integer-exact arithmetic", () => {
    const vp = profile(), maximum = Number.MAX_SAFE_INTEGER;
    [[0, 30], [maximum - 2, 40], [maximum, 30]]
      .forEach(([tick, qty]) => apply(vp, trade(tick, qty)));
    expect(vp.read().valueArea).toMatchObject({
      valTick: maximum - 3, vahTick: maximum, includedVolume: 70n,
    });
  });
  it("handles a one-sided zero run after the other side reaches its observed boundary", () => {
    const vp = profile();
    [[99, 0], [100, 40], [1_000_000_000_000, 30], [1_000_000_000_001, 30]]
      .forEach(([tick, qty]) => apply(vp, trade(tick, qty)));
    expect(vp.read().valueArea).toMatchObject({
      valTick: 99, vahTick: 1_000_000_000_000, includedVolume: 70n,
    });
  });
  it.each([[[100, 4], [101, 3], [102, 3]], [[98, 3], [99, 3], [100, 4]]])(
    "expands only within an observed edge: %j", (...levels) => {
      const vp = profile();
      levels.forEach(([tick, qty]) => apply(vp, trade(tick, qty)));
      const result = vp.read();
      expect(result.valueArea).toEqual(referenceValueArea(result));
      expect(result.valueArea.includedVolume).toBe(7n);
    },
  );
  it("is independent of accepted-input order", () => {
    const levels = [[97, 30], [100, 40], [102, 30], [99, 0]] as const;
    const a = profile(), b = profile(), c = profile();
    levels.forEach(([tick, qty]) => apply(a, trade(tick, qty)));
    [...levels].reverse().forEach(([tick, qty]) => apply(b, trade(tick, qty)));
    [levels[2], levels[0], levels[3], levels[1]]
      .forEach(([tick, qty]) => apply(c, trade(tick, qty)));
    expect(b.read().valueArea).toEqual(a.read().valueArea);
    expect(c.read().valueArea).toEqual(a.read().valueArea);
  });
  it("returns independently frozen VA results without mutating pending or committed state", () => {
    const vp = profile();
    apply(vp, trade(100, 6));
    const before = vp.read(), pending = vp.prepareAccepted(trade(101, 4));
    const again = vp.read();
    expect(again).toEqual(before);
    expect(again.valueArea).not.toBe(before.valueArea);
    expect(Object.isFrozen(before.valueArea)).toBe(true);
    expect(() => { (before.valueArea as { valTick: number }).valTick = -1; }).toThrow();
    pending();
    expect(vp.read().valueArea).toMatchObject({ valTick: 100, vahTick: 101, includedVolume: 10n });
    expect(before.valueArea).toMatchObject({ valTick: 100, vahTick: 100, includedVolume: 6n });
  });
  it("does not calculate VA on candidate preparation or commit, only on read", () => {
    const vp = profile(), freeze = Object.freeze;
    let calculations = 0;
    const spy = vi.spyOn(Object, "freeze").mockImplementation((value) => {
      if (value && typeof value === "object" && "ratioNumerator" in value &&
          value.ratioNumerator === 7n) calculations++;
      return freeze(value);
    });
    try {
      const pending = vp.prepareAccepted(trade(100, 4));
      expect(calculations).toBe(0);
      pending();
      apply(vp, trade(101, 3));
      expect(calculations).toBe(0);
      vp.read();
      expect(calculations).toBe(1);
      apply(vp, trade(102, 3));
      expect(calculations).toBe(1);
      vp.read();
      expect(calculations).toBe(2);
    } finally { spy.mockRestore(); }
  });
});

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
