import { describe, expect, it } from "vitest";
import { executedVolume, type Trade } from "./events";
import type { QualityInterval } from "./qualityTimeline";
import {
  createViewport, timeToX, xToTime, tickToY, yToTick, resizeViewport,
  zoomTime, panTime, receiveLatest, goLatest, panPrice, autoPrice, zoomPrice,
  buildPriceSegments, DEFAULT_SPAN_NS, MAX_SPAN_NS, MIN_SPAN_NS,
} from "./viewport";

const ORIGIN = 1767225600000000000n;
const ns = (seconds: number) => (ORIGIN + BigInt(seconds) * 1_000_000_000n).toString();
const bounds = { left: 20, top: 10, width: 1000, height: 500 };
const quality: readonly QualityInterval[] = [{
  channel: "TRADES", startNs: ns(-10000), endNs: null, status: "VALID",
  reason: "Fixed MOCK continuity", sequenceVerification: "CONTIGUOUS",
}];
function trade(seconds: number, priceTicks: number, index = 1): Trade {
  return {
    kind: "TRADE", priceTicks, qty: executedVolume(1), aggressor: "UNKNOWN",
    classification: "UNKNOWN", tradeId: `MOCK-${index}`,
    header: {
      schemaVersion: 1, environment: "MOCK", source: "MOCK_DETERMINISTIC",
      sourceId: "MOCK-R05", canonicalInstrumentId: "CME:NQ:2026-03",
      channel: "TRADES", sessionId: "MOCK-R05", exchangeTimeNs: ns(seconds),
      receiveTimeNs: ns(seconds), sourceTimePrecision: "ns", sequenceScope: "CHANNEL",
      sequence: String(index), eventId: `MOCK-${index}`, quality: "VALID",
    },
  };
}
function view() {
  return createViewport({ bounds, latestNs: ns(1800), price: { minTick: 80000, maxTick: 80100 } });
}

describe("R05 shared CSS-pixel coordinates", () => {
  it("starts LIVE/AUTO with the latest 30 minutes", () => {
    const v = view();
    expect(v.time).toEqual({ minNs: ns(0), maxNs: ns(1800) });
    expect(v.timeMode).toBe("LIVE");
    expect(v.priceMode).toBe("AUTO");
  });
  it("maps exact time endpoints to left/right", () => {
    expect(timeToX(view(), ns(0))).toBe(20);
    expect(timeToX(view(), ns(1800))).toBe(1020);
    expect(timeToX(view(), ns(900))).toBe(520);
  });
  it("maps exact price endpoints to top/bottom", () => {
    expect(tickToY(view(), 80100)).toBe(10);
    expect(tickToY(view(), 80000)).toBe(510);
    expect(tickToY(view(), 80050)).toBe(260);
  });
  it.each([20, 20.1, 123.456, 520, 1000.25, 1020])("time inverse at %s CSSpx", (x) => {
    const t = xToTime(view(), x)!;
    expect(Math.abs(timeToX(view(), t)! - x)).toBeLessThanOrEqual(0.5);
  });
  it.each([10, 10.1, 123.456, 260, 500.25, 510])("price inverse at %s CSSpx", (y) => {
    expect(Math.abs(tickToY(view(), yToTick(view(), y)!)! - y)).toBeLessThanOrEqual(0.5);
  });
  it("uses fractional inverse tick coordinates only for display, not raw data", () => {
    expect(yToTick(view(), 12.5)).toBe(80099.5);
    expect(trade(0, 80000).priceTicks).toBe(80000);
  });
  it("keeps CSS positions unchanged at DPR 2", () => {
    const v = resizeViewport(view(), bounds, 2);
    expect(v.dpr).toBe(2);
    expect(timeToX(v, ns(900))).toBe(520);
    expect(tickToY(v, 80050)).toBe(260);
    expect(xToTime(v, 520)).toBe(ns(900));
  });
  it("preserves adjacent nanoseconds even at a huge epoch", () => {
    const start = 10n ** 40n;
    const v = { ...view(), time: { minNs: start.toString(), maxNs: (start + 2n).toString() } };
    expect(timeToX(v, (start + 1n).toString())).toBe(520);
    expect(xToTime(v, 520)).toBe((start + 1n).toString());
  });
  it.each(["width", "height"] as const)("handles zero %s without NaN or division by zero", (key) => {
    const v = resizeViewport(view(), { ...bounds, [key]: 0 }, 1);
    if (key === "width") {
      expect(timeToX(v, ns(0))).toBeNull();
      expect(xToTime(v, 20)).toBeNull();
      expect(panTime(v, 10)).toEqual(v);
      expect(zoomTime(v, 20, 0.5)).toEqual(v);
    } else {
      expect(tickToY(v, 80000)).toBeNull();
      expect(yToTick(v, 10)).toBeNull();
      expect(panPrice(v, 10)).toEqual(v);
    }
  });
  it("has no fabricated price or current market timestamp without data", () => {
    const v = createViewport({ bounds });
    expect(v.price).toBeNull();
    expect(v.latestNs).toBeNull();
    expect(v.priceData).toBe("NO TRADE PRICE");
    expect(tickToY(v, 80000)).toBeNull();
  });
  it.each([
    { ...bounds, width: -1 }, { ...bounds, height: NaN },
    { ...bounds, left: Infinity }, { ...bounds, top: NaN },
  ])("rejects invalid bounds %#", (b) => {
    expect(() => createViewport({ bounds: b })).toThrow();
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid DPR %s", (dpr) => {
    expect(() => createViewport({ bounds, dpr })).toThrow();
  });
  it.each([
    { minNs: ns(1), maxNs: ns(0) }, { minNs: ns(0), maxNs: ns(0) },
    { minNs: "1.5", maxNs: ns(0) },
  ])("rejects invalid time ranges %#", (time) => {
    expect(() => timeToX({ ...view(), time }, ns(0))).toThrow();
  });
  it.each([
    { minTick: 1, maxTick: 1 }, { minTick: 2, maxTick: 1 },
    { minTick: 1.5, maxTick: 2 }, { minTick: 0, maxTick: Infinity },
  ])("rejects invalid price ranges %#", (price) => {
    expect(() => createViewport({ bounds, price })).toThrow();
  });
  it("rejects invalid query coordinates and times explicitly", () => {
    expect(() => timeToX(view(), "1.5")).toThrow();
    expect(() => xToTime(view(), NaN)).toThrow();
    expect(() => yToTick(view(), Infinity)).toThrow();
  });
});

describe("R12 shared price zoom extension (existing transforms unchanged)", () => {
  const v = () => createViewport({ bounds, latestNs: ns(1000), price: { minTick: 79990, maxTick: 80010 } });
  it.each(["LIVE", "HISTORY"] as const)("keeps the %s time viewport and latest timestamp exactly unchanged", mode => {
    const start = { ...v(), timeMode: mode }, next = zoomPrice(start, 260, .5);
    expect(next.time).toBe(start.time); expect(next.timeMode).toBe(mode);
    expect(next.latestNs).toBe(start.latestNs);
    expect(next.bounds).toBe(start.bounds); expect(next.dpr).toBe(start.dpr);
    expect(next.priceMode).toBe("MANUAL");
    expect(next.price).toEqual({ minTick: 79995, maxTick: 80005 });
  });
  it.each([0, .25, .5, .75, 1])("anchors fraction %s within the integer-display rounding tolerance", f => {
    const start = v(), y = bounds.top + f * bounds.height;
    const tick = yToTick(start, y)!;
    const next = zoomPrice(start, y, .5);
    expect(Math.abs(yToTick(next, y)! - tick)).toBeLessThanOrEqual(.5);
    expect(Number.isSafeInteger(next.price!.minTick)).toBe(true);
    expect(Number.isSafeInteger(next.price!.maxTick)).toBe(true);
  });
  it("zooms out symmetrically and never changes time-X mapping", () => {
    const start = v(), next = zoomPrice(start, 260, 2);
    expect(next.price).toEqual({ minTick: 79980, maxTick: 80020 });
    expect(timeToX(next, ns(500))).toBe(timeToX(start, ns(500)));
  });
  it("returns unchanged with no price range or zero plot height", () => {
    const noPrice = { ...v(), price: null }, noHeight = { ...v(), bounds: { ...bounds, height: 0 } };
    expect(zoomPrice(noPrice, 10, .5)).toBe(noPrice);
    expect(zoomPrice(noHeight, 10, .5)).toBe(noHeight);
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid factor %s without mutating prior state", factor => {
    const start = v(), before = JSON.stringify(start);
    expect(() => zoomPrice(start, 10, factor)).toThrow();
    expect(JSON.stringify(start)).toBe(before);
  });
  it("has a minimum one-Tick display span, not a rounded market price", () => {
    const next = zoomPrice(v(), 260, Number.MIN_VALUE);
    expect(next.price!.maxTick - next.price!.minTick).toBe(1);
  });
  it("rejects unsafe price-range overflow rather than silently clipping", () => {
    const start = { ...v(), price: { minTick: Number.MAX_SAFE_INTEGER - 20, maxTick: Number.MAX_SAFE_INTEGER } };
    expect(() => zoomPrice(start, 260, 2)).toThrow(/safe integer/);
  });
  it("handles negative Tick ranges with the unchanged tickToY transform", () => {
    const next = zoomPrice({ ...v(), price: { minTick: -110, maxTick: -90 } }, 260, .5);
    expect(next.price).toEqual({ minTick: -105, maxTick: -95 });
    expect(tickToY(next, -100)).toBe(260);
  });
  it("price drag remains orthogonal after zoom, and AUTO preserves HISTORY", () => {
    const start = { ...v(), timeMode: "HISTORY" as const };
    const zoomed = zoomPrice(start, 260, .5), moved = panPrice(zoomed, 50);
    expect(moved.time).toBe(start.time); expect(moved.timeMode).toBe("HISTORY");
    const automatic = autoPrice({ ...moved, priceMode: "AUTO" }, [], []);
    expect(automatic.priceMode).toBe("AUTO"); expect(automatic.timeMode).toBe("HISTORY");
    expect(automatic.time).toBe(start.time); expect(automatic.priceData).toBe("NO TRADE PRICE");
    expect(automatic.price).toBe(moved.price);
  });
});

describe("R05 independent time and price transitions", () => {
  it("anchors zoom on the pointer, not the chart midpoint", () => {
    const v = zoomTime(view(), 270, 0.5);
    expect(v.time).toEqual({ minNs: ns(225), maxNs: ns(1125) });
    expect(timeToX(v, ns(450))).toBe(270);
  });
  it("caps zoom at one minute and six hours", () => {
    const small = zoomTime(view(), 1020, 0.00001);
    const big = zoomTime(view(), 1020, 100000);
    expect(BigInt(small.time.maxNs) - BigInt(small.time.minNs)).toBe(MIN_SPAN_NS);
    expect(BigInt(big.time.maxNs) - BigInt(big.time.minNs)).toBe(MAX_SPAN_NS);
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid zoom factor %s", (factor) => {
    expect(() => zoomTime(view(), 500, factor)).toThrow();
  });
  it("drags right into the past and HISTORY", () => {
    const v = panTime(view(), 100);
    expect(v.time).toEqual({ minNs: ns(-180), maxNs: ns(1620) });
    expect(v.timeMode).toBe("HISTORY");
    expect(v.price).toEqual(view().price);
  });
  it("does not return to LIVE when panned back to the latest edge", () => {
    const v = panTime(panTime(view(), 100), -1000);
    expect(v.time.maxNs).toBe(ns(1800));
    expect(v.timeMode).toBe("HISTORY");
  });
  it("does not move HISTORY when latest time advances", () => {
    const past = panTime(view(), 100);
    const v = receiveLatest(past, ns(2000));
    expect(v.time).toEqual(past.time);
    expect(v.latestNs).toBe(ns(2000));
    expect(v.timeMode).toBe("HISTORY");
  });
  it("follows a newer valid time in LIVE with the selected duration", () => {
    const v = receiveLatest(zoomTime(view(), 1020, 0.5), ns(2000));
    expect(v.time).toEqual({ minNs: ns(1100), maxNs: ns(2000) });
    expect(v.timeMode).toBe("LIVE");
  });
  it("ignores equal/older latest times", () => {
    expect(receiveLatest(view(), ns(1700))).toEqual(view());
    expect(receiveLatest(view(), ns(1800))).toEqual(view());
  });
  it("returns to LIVE only via latest, resets 30 minutes and retains MANUAL", () => {
    const manual = panPrice(view(), 50);
    const past = receiveLatest(panTime(manual, 100), ns(2400));
    const v = goLatest(past);
    expect(v.timeMode).toBe("LIVE");
    expect(v.time).toEqual({ minNs: ns(600), maxNs: ns(2400) });
    expect(v.priceMode).toBe("MANUAL");
    expect(v.price).toEqual(manual.price);
    expect(BigInt(v.time.maxNs) - BigInt(v.time.minNs)).toBe(DEFAULT_SPAN_NS);
  });
  it("changes only the price axis during its drag", () => {
    const v = panPrice(view(), 50);
    expect(v.priceMode).toBe("MANUAL");
    expect(v.price).toEqual({ minTick: 80010, maxTick: 80110 });
    expect(v.time).toEqual(view().time);
    expect(v.timeMode).toBe("LIVE");
  });
  it("can use AUTO in HISTORY without returning to LIVE", () => {
    const v = autoPrice(panTime(panPrice(view(), 50), 100), [trade(0, 80040)], quality, true);
    expect(v.priceMode).toBe("AUTO");
    expect(v.timeMode).toBe("HISTORY");
    expect(v.price).toEqual({ minTick: 80032, maxTick: 80048 });
  });
  it("does not auto-scale MANUAL on new Trade data", () => {
    const v = panPrice(view(), 50);
    expect(autoPrice(v, [trade(1, 90000)], quality).price).toEqual(v.price);
  });
  it("leaves inputs unchanged", () => {
    const v = view();
    const before = JSON.stringify(v);
    zoomTime(v, 270, 0.5); panTime(v, 200); panPrice(v, 50);
    receiveLatest(v, ns(2000)); autoPrice(v, [trade(0, 80000)], quality);
    expect(JSON.stringify(v)).toBe(before);
  });
});

describe("R05 AUTO and gap-safe Trade line", () => {
  const trades = [trade(0, 80000, 1), trade(300, 80100, 2), trade(600, 80040, 3)];
  const gap: readonly QualityInterval[] = [
    { ...quality[0], endNs: ns(360) },
    { ...quality[0], startNs: ns(360), endNs: ns(540), status: "GAP", reason: "Deliberate MOCK GAP" },
    { ...quality[0], startNs: ns(540) },
  ];
  it("adds exactly 15% above and below valid visible Trade extrema", () => {
    const v = autoPrice(view(), trades, quality);
    expect(v.price).toEqual({ minTick: 79985, maxTick: 80115 });
    expect(v.priceData).toBe("VALID");
  });
  it("rounds margins outward to whole display ticks, not raw prices", () => {
    const v = autoPrice(view(), [trade(0, 80000), trade(1, 80001, 2)], quality);
    expect(v.price).toEqual({ minTick: 79999, maxTick: 80002 });
  });
  it("gives a single price at least eight ticks on each side", () => {
    expect(autoPrice(view(), [trade(0, 80000)], quality).price)
      .toEqual({ minTick: 79992, maxTick: 80008 });
  });
  it("retains the last valid scale but reports no Trade prices", () => {
    const v = autoPrice(view(), [], quality);
    expect(v.price).toEqual(view().price);
    expect(v.priceData).toBe("NO TRADE PRICE");
  });
  it("does not invent an initial scale", () => {
    expect(autoPrice(createViewport({ bounds }), [], quality).price).toBeNull();
  });
  it("excludes prices outside the time window", () => {
    expect(autoPrice(view(), [trade(-1, 99999), trade(1, 80000)], quality).price)
      .toEqual({ minTick: 79992, maxTick: 80008 });
  });
  it("splits three MOCK points into two runs with ZERO GAP-crossing edges", () => {
    const segments = buildPriceSegments(trades, gap);
    expect(segments.map((s) => s.map((t) => t.tradeId))).toEqual([["MOCK-1", "MOCK-2"], ["MOCK-3"]]);
    const edges = segments.flatMap((s) => s.slice(1).map((t, i) => [s[i], t]));
    expect(edges).toHaveLength(1);
    expect(edges.filter(([a, b]) => BigInt(a.header.exchangeTimeNs!) < BigInt(ns(540))
      && BigInt(b.header.exchangeTimeNs!) >= BigInt(ns(360)))).toHaveLength(0);
  });
  it("connects all three only when continuity is explicitly valid", () => {
    expect(buildPriceSegments(trades, quality).map((s) => s.length)).toEqual([3]);
  });
  it("does not treat missing quality coverage as valid continuity", () => {
    expect(buildPriceSegments(trades, [])).toEqual([]);
  });
  it("excludes a Trade inside the GAP from AUTO and line", () => {
    const t = [...trades, trade(400, 90000, 4)];
    expect(buildPriceSegments(t, gap).flat()).toHaveLength(3);
    expect(autoPrice(view(), t, gap).price).toEqual({ minTick: 79985, maxTick: 80115 });
  });
  it("stable-sorts by exact event time without altering raw input", () => {
    const same = trade(300, 80002, 4);
    const raw = [trades[2], trades[1], same, trades[0]];
    const before = JSON.stringify(raw);
    expect(buildPriceSegments(raw, quality)[0].map((t) => t.tradeId))
      .toEqual(["MOCK-1", "MOCK-2", "MOCK-4", "MOCK-3"]);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("does not join session boundaries", () => {
    const other = { ...trades[2], header: { ...trades[2].header, sessionId: "MOCK-OTHER" } };
    expect(buildPriceSegments([trades[0], other], quality).map((s) => s.length)).toEqual([1, 1]);
  });
  it("rejects mixing individual contracts in a single viewport", () => {
    const other = { ...trades[2], header: { ...trades[2].header, canonicalInstrumentId: "CME:NQ:2026-06" } };
    expect(() => buildPriceSegments([trades[0], other], quality)).toThrow();
  });
  it("does not connect through a zero-length GAP marker", () => {
    const q = [
      { ...quality[0], endNs: ns(400) },
      { ...quality[0], startNs: ns(400), endNs: ns(400), status: "GAP" as const },
      { ...quality[0], startNs: ns(400) },
    ];
    expect(buildPriceSegments(trades, q).map((s) => s.length)).toEqual([2, 1]);
  });
  it("rejects unsupported corrections rather than displaying them as ordinary Trades", () => {
    expect(() => buildPriceSegments([{ ...trades[0], kind: "TRADE_CANCEL" }], quality)).toThrow();
  });
  it("excludes SUSPECT prices and does not interpolate across them", () => {
    const suspect = { ...trade(200, 99999, 4), header: { ...trade(200, 99999, 4).header, quality: "SUSPECT" as const } };
    const input = [trades[0], suspect, trades[1]];
    expect(buildPriceSegments(input, quality).map((s) => s.length)).toEqual([1, 1]);
    expect(autoPrice(view(), input, quality).price).toEqual({ minTick: 79985, maxTick: 80115 });
  });
  it("does not interpolate when an untimed event cannot be ordered", () => {
    const untimed = { ...trades[1], header: { ...trades[1].header, exchangeTimeNs: null } };
    expect(buildPriceSegments([trades[2], untimed, trades[0]], quality)
      .map((s) => s.map((t) => t.tradeId))).toEqual([["MOCK-1"], ["MOCK-3"]]);
  });
  it("does not join across uncovered quality time", () => {
    const holes = [
      { ...quality[0], endNs: ns(360) }, { ...quality[0], startNs: ns(540) },
    ];
    expect(buildPriceSegments(trades, holes).map((s) => s.length)).toEqual([2, 1]);
  });
  it("ends half-open GAP exactly at recovery without losing the recovery point", () => {
    const atRecovery = trade(540, 80020, 4);
    expect(buildPriceSegments([...trades, atRecovery], gap)
      .map((s) => s.map((t) => t.tradeId))).toEqual([["MOCK-1", "MOCK-2"], ["MOCK-4", "MOCK-3"]]);
  });
  it("does not label unrelated L1 quality as Trade continuity", () => {
    expect(() => buildPriceSegments(trades, [{ ...quality[0], channel: "L1" }])).toThrow();
  });
  it("rejects reversed or overlapping quality intervals", () => {
    expect(() => buildPriceSegments(trades, [{ ...quality[0], startNs: ns(10), endNs: ns(0) }])).toThrow();
    expect(() => buildPriceSegments(trades, [quality[0], quality[0]])).toThrow();
  });
  it("rejects AUTO scales that would exceed safe integer Tick bounds", () => {
    expect(() => autoPrice(view(), [trade(0, Number.MAX_SAFE_INTEGER)], quality)).toThrow();
  });
  it("keeps negative prices and their display margins valid", () => {
    expect(autoPrice(view(), [trade(0, -100), trade(1, -80, 2)], quality).price)
      .toEqual({ minTick: -103, maxTick: -77 });
  });
});
