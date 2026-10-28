import assert from "node:assert/strict";
import test from "node:test";
import { adjustmentTable, buildProfiles, buildSeries, groupLevels, latestContract, pixelRows, valueArea, weeklyCvd,
  barMinutes, aggregateBars, pocExtensionEnd, type DayData } from "../src/long-vp/model.ts";
import { planRequests, evictionOrder } from "../src/long-vp/store.ts";
import { atEt, dayStartSec, isRthSec, tradingDateAt, weekStartSec, latestTradingDate } from "../src/long-vp/time.ts";
import { defaults, readDocument, validateSettings } from "../src/long-vp/settings-schema.ts";
import { clampView, initialView, isLongVpRoute } from "../src/long-vp/view-math.ts";

const day = (date: string, contracts: string[], bars: DayData["bars1m"], vp: DayData["vp30m"]): DayData => ({
  version: 1, tradingDate: date, startSec: dayStartSec(date), endSec: dayStartSec(date) + 82800,
  contracts: contracts.map((c, i) => ({ contract: c, fromSec: dayStartSec(date) + i, toSec: dayStartSec(date) + 82800 })),
  bars1m: bars, vp30m: vp, gaps: [], complete: true, builtAtUs: 0 });

test("settings schema: defaults valid, exact ranges, readDocument null on bad", () => {
  assert.equal(Object.keys(validateSettings({ ...defaults })).length, 0);
  assert.equal(defaults.vpWidthPct, 40); assert.equal(defaults.priceStyle, "line");
  assert.ok(validateSettings({ ...defaults, vpWidthPct: 81 }).vpWidthPct);
  assert.ok(validateSettings({ ...defaults, vpTickGroup: 1.5 }).vpTickGroup);
  assert.ok(validateSettings({ ...defaults, extra: 1 }).extra);
  assert.equal(readDocument({ version: 2, values: defaults, updatedAt: null }), null);
  assert.deepEqual(readDocument({ version: 1, values: defaults, updatedAt: 5 })?.values, defaults);
});

test("exchange calendar across DST", () => {
  // 2026-11-01 DST ends; Sunday 18:00 ET starts Monday 2026-11-02.
  assert.equal(weekStartSec("2026-11-04"), atEt("2026-11-01", 18));
  assert.equal(atEt("2026-11-01", 18) - atEt("2026-10-31", 18), 25 * 3600);
  assert.equal(tradingDateAt(atEt("2026-11-01", 18)), "2026-11-02");
  assert.equal(tradingDateAt(atEt("2026-11-02", 17, 30)), "2026-11-02");
  assert.ok(isRthSec(atEt("2026-11-02", 9, 30))); assert.ok(!isRthSec(atEt("2026-11-02", 16)));
  assert.equal(latestTradingDate(atEt("2026-11-07", 12)), "2026-11-06");
});

test("roll chain adjusts to latest; unknown never zero", () => {
  const rolls = [{ from: "NQU6", to: "NQZ6", atSec: 1.9e9, diffTicks: 80, method: "edge" },
    { from: "NQZ6", to: "NQH7", atSec: 1.95e9, diffTicks: 60, method: "edge" }];
  const t = adjustmentTable(["NQU6", "NQZ6", "NQH7", "NQM6"], rolls, "NQH7");
  assert.equal(t.get("NQU6"), 140); assert.equal(t.get("NQZ6"), 60); assert.equal(t.get("NQH7"), 0);
  assert.equal(t.get("NQM6"), null);
  assert.equal(latestContract([day("2026-09-01", ["NQU6"], [], [])], rolls), "NQH7");
});

test("unadjustable rows omitted, CVD keeps them, VWAP adjusted", () => {
  const d = "2026-09-01", s = dayStartSec(d);
  const data = day(d, ["NQU6", "NQZ6"], [[s, 10, 12, 9, 11, 5, 2, 0], [s + 60, 100, 101, 99, 100, 1, 4, 1]],
    [[s, 10, 3, 1, 0], [s, 100, 2, 2, 1], [s, 102, 1, 1, 1]]);
  const series = buildSeries([data], [], "NQZ6");
  assert.equal(series.bars.length, 1);
  assert.ok(series.unadjustableDates.has(d));
  assert.deepEqual(series.cvd.map(c => c.v), [3, 0]);
  assert.equal(series.vwap[0].v, (100 * 4 + 102 * 2) / 6);
  const [p] = buildProfiles(series, "day", false, [d]);
  assert.equal(p.unadjustable, true); assert.equal(p.total, 6);
});

test("weekly CVD resets per week", () => {
  assert.deepEqual(weeklyCvd([{ t: 1, d: 5, week: "a" }, { t: 2, d: 1, week: "a" }, { t: 3, d: -2, week: "b" }]).map(x => x.v), [5, 6, -2]);
});

test("value area 70% with high-price ties", () => {
  assert.deepEqual(valueArea(new Map([[10, 5], [11, 5]])), { poc: 11, vah: 11, val: 10 });
  const area = valueArea(new Map([[1, 10], [2, 20], [3, 40], [4, 20], [5, 10]]));
  assert.deepEqual(area, { poc: 3, vah: 4, val: 2 });
  assert.deepEqual(valueArea(new Map()), { poc: null, vah: null, val: null });
});

test("display grouping does not move POC; pixel rows sum and clip", () => {
  const levels = new Map([[100, 3], [101, 9], [102, 4], [103, 1]]);
  assert.deepEqual([...groupLevels(levels, 2)], [[100, 12], [102, 5]]);
  assert.equal(valueArea(levels).poc, 101);
  const rows = pixelRows(levels, 1, p => (110 - p) * .4, 100); // 0.4 px per tick
  assert.equal(rows.reduce((a, r) => a + r.v, 0), 17);
  assert.ok(rows.some(r => r.v > 9));
  const tall = pixelRows(new Map([[100, 7]]), 1, p => (100.2 - p) * 50, 10);
  assert.deepEqual(tall, [{ y: 0, h: 10, v: 7 }]);
});

test("paging splits <=60 trading days, contiguous; eviction far first", () => {
  const dates: string[] = [];
  for (let t = Date.parse("2026-01-05"); dates.length < 70; t += 86400e3) {
    const d = new Date(t).toISOString().slice(0, 10), w = new Date(t).getUTCDay();
    if (w && w !== 6) dates.push(d);
  }
  const plan = planRequests(dates);
  assert.deepEqual(plan.map(p => p.dates.length), [60, 10]);
  assert.equal(planRequests([dates[0], dates[5]]).length, 2);
  assert.deepEqual(evictionOrder(["2026-01-01", "2026-03-01", "2026-03-02"], "2026-03-01", "2026-03-02", 2), ["2026-01-01"]);
});

test("adaptive bars and view helpers", () => {
  assert.equal(barMinutes(1), 1); assert.equal(barMinutes(60), 5); assert.equal(barMinutes(1e5), 240);
  const bars = aggregateBars([{ t: 0, o: 1, h: 3, l: 1, c: 2 }, { t: 60, o: 2, h: 5, l: 0, c: 4 }], 5, 0, 600);
  assert.deepEqual(bars, [{ t: 0, o: 1, h: 5, l: 0, c: 4 }]);
  assert.ok(isLongVpRoute("?view=longvp")); assert.ok(!isLongVpRoute("?mode=replay"));
  const v = initialView(atEt("2026-11-04", 12));
  assert.equal(v.startSec, dayStartSec("2026-10-22"));
  assert.ok(clampView({ ...v, endSec: v.startSec + 1e9 }, 0).endSec - clampView({ ...v, endSec: v.startSec + 1e9 }, 0).startSec <= 90 * 86400);
});

test("ダミー: POC延長は週末を越えて次の取引期間の10%まで", () => {
  const nextDay = dayStartSec("2026-11-02");
  assert.equal(pocExtensionEnd("2026-10-30", "day"), nextDay + 8640);
  const nextWeek = weekStartSec("2026-11-02");
  assert.equal(pocExtensionEnd("2026-10-25", "week"), nextWeek + 119 * 360);
});
