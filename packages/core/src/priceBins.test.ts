import { describe, expect, it } from "vitest";
import { F01_BOOK } from "../../fixtures/src/index";
import { applyMbpEvent, createMbpBook } from "./mbpBook";
import { priceBinId, priceBinTicks, readPriceBin } from "./priceBins";
import type { PriceBinWidth } from "./priceBins";

describe("R04 exact price bucket geometry", () => {
  it.each([1, 2, 4, 8] as const)("supports width %i with floor-aligned boundaries", (width) => {
    expect(priceBinId(80001, width)).toBe(Math.floor(80001 / width));
    const ticks = priceBinTicks(80001, width);
    expect(ticks).toHaveLength(width);
    expect(ticks[0]).toBe(Math.floor(80001 / width) * width);
    expect(ticks[ticks.length - 1]).toBe(ticks[0] + width - 1);
  });

  it.each([
    [-1, 1, -1], [-1, 2, -1], [-1, 4, -1], [-1, 8, -1],
    [-2, 2, -1], [-3, 2, -2], [-4, 4, -1], [-5, 4, -2], [-9, 8, -2],
  ] as const)("floor(%i/%i) = %i, not truncation toward zero", (tick, width, expected) => {
    expect(priceBinId(tick, width)).toBe(expected);
    expect(priceBinTicks(tick, width)).toContain(tick);
  });

  it.each([0, 3, -1, 16, 1.5, NaN, Infinity])("rejects unsupported width %s", (width) => {
    expect(() => priceBinId(80000, width as PriceBinWidth)).toThrow();
  });

  it.each([0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid Tick %s", (tick) => {
    expect(() => priceBinId(tick, 2)).toThrow();
  });

  it("rejects a bucket whose mathematical boundary exceeds safe Tick integers", () => {
    expect(() => priceBinTicks(-Number.MAX_SAFE_INTEGER, 2)).toThrow();
    expect(priceBinTicks(Number.MAX_SAFE_INTEGER, 2))
      .toEqual([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]);
  });
});

describe("R04 side-specific bucket quantities", () => {
  const snapshot = {
    ...F01_BOOK.events[0], depthScope: { type: "PRICE_RANGE", minTick: 80000, maxTick: 80007 },
    bids: [{ priceTicks: 80000, qty: 40 }, { priceTicks: 80001, qty: 20 }],
    asks: [{ priceTicks: 80000, qty: 3 }, { priceTicks: 80001, qty: 5 }],
  };
  const book = applyMbpEvent(createMbpBook(), snapshot);

  it("sums only the requested side, using exact integer quantities", () => {
    expect(readPriceBin(book, "BID", 80000, 2)).toEqual({ status: "KNOWN", qty: 60n });
    expect(readPriceBin(book, "ASK", 80001, 2)).toEqual({ status: "KNOWN", qty: 8n });
    expect(readPriceBin(book, "BID", 80000, 1)).toEqual({ status: "KNOWN", qty: 40n });
    expect(readPriceBin(book, "BID", 80001, 1)).toEqual({ status: "KNOWN", qty: 20n });
  });

  it("does not replace an unknown or outside-depth component with zero", () => {
    expect(readPriceBin(book, "BID", 80000, 4)).toEqual({ status: "UNKNOWN", qty: null });
    expect(readPriceBin(book, "BID", 80008, 2)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
    const narrow = applyMbpEvent(createMbpBook(), F01_BOOK.events[0]);
    expect(readPriceBin(narrow, "BID", 80000, 2)).toEqual({ status: "OUTSIDE_DEPTH", qty: null });
  });

  it("uses zero omission semantics only when R02 has explicit evidence", () => {
    const known = applyMbpEvent(createMbpBook(), snapshot, {
      unlistedLevels: "ZERO", evidence: "MOCK only: omissions in this snapshot mean zero",
    });
    expect(readPriceBin(known, "BID", 80000, 8)).toEqual({ status: "KNOWN", qty: 60n });
  });

  it("preserves NOT_INITIALIZED rather than manufacturing an empty zero book", () => {
    expect(readPriceBin(createMbpBook(), "BID", 80000, 2))
      .toEqual({ status: "NOT_INITIALIZED", qty: null });
  });

  it("can sum quantities beyond Number precision without integer loss", () => {
    const large = applyMbpEvent(createMbpBook(), {
      ...snapshot, bids: [
        { priceTicks: 80000, qty: Number.MAX_SAFE_INTEGER },
        { priceTicks: 80001, qty: Number.MAX_SAFE_INTEGER },
      ],
    });
    expect(readPriceBin(large, "BID", 80000, 2))
      .toEqual({ status: "KNOWN", qty: 2n * BigInt(Number.MAX_SAFE_INTEGER) });
  });
});
