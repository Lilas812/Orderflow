import { describe, expect, it } from "vitest";
import { NQ, priceToTicks, ticksToPrice } from "./instrument";

describe("NQ tick conversions (R00)", () => {
  it("defines NQ outright tick size as 0.25", () => {
    expect(NQ.root).toBe("NQ");
    expect(NQ.tickSize).toBe(0.25);
  });

  it("converts 80000 ticks to 20000.00", () => {
    expect(ticksToPrice(80000)).toBe(20000.00);
  });

  it("converts 80001 ticks to 20000.25", () => {
    expect(ticksToPrice(80001)).toBe(20000.25);
  });

  it("converts 20000.50 to 80002 ticks", () => {
    expect(priceToTicks(20000.50)).toBe(80002);
  });

  it("rejects off-grid 20000.10 instead of rounding", () => {
    expect(() => priceToTicks(20000.10)).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid tick input %s",
    (ticks) => expect(() => ticksToPrice(ticks)).toThrow(RangeError),
  );

  it.each([NaN, Infinity, -Infinity, 0.1, 0.250000000001, Number.MAX_VALUE,
    (Number.MAX_SAFE_INTEGER + 1) / 4])(
    "rejects invalid or unsafe price input %s",
    (price) => expect(() => priceToTicks(price)).toThrow(RangeError),
  );

  it.each([0, 1, -1, 80002, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    "round-trips safe tick input %s",
    (ticks) => expect(priceToTicks(ticksToPrice(ticks))).toBe(ticks),
  );
});
