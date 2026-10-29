import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSocketUrl } from "../src/data/socket.ts";
import { adjustmentTable, buildSeries, latestContract, parseDay, parseRolls } from "../src/long-vp/model.ts";
import { instrumentPrice } from "../../../lib/market/instruments.ts";
import { dayEndSec, dayStartSec } from "../src/long-vp/time.ts";

test("legacy WS defaults to NQ, GC has an explicit symbol, secure scheme and replay remain intact", () => {
  const location = { protocol: "https:", host: "example.invalid", search: "?mode=replay&from=123&speed=2" };
  const nq = new URL(buildSocketUrl(location, "NQ")), gc = new URL(buildSocketUrl(location, "GC"));
  assert.equal(nq.protocol, "wss:"); assert.equal(nq.pathname, "/api/ws"); assert.equal(nq.searchParams.has("symbol"), false);
  assert.equal(gc.protocol, "wss:"); assert.equal(gc.searchParams.get("symbol"), "GC");
  assert.equal(gc.searchParams.get("mode"), "replay"); assert.equal(gc.searchParams.get("from"), "123");
  assert.equal(instrumentPrice(40283, "GC"), "4028.3");
});

test("GC unknown identities stay distinct from gaps, never become zero adjustments, and still contribute to CVD", () => {
  const start = dayStartSec("2026-10-29"), end = dayEndSec("2026-10-29");
  const raw = { version: 1, tradingDate: "2026-10-29", startSec: start, endSec: end,
    contracts: [{ contract: "GCZ6", fromSec: start, toSec: end }, { contract: "UNKNOWN", fromSec: start, toSec: end }],
    bars1m: [[start + 60, 40283, 40285, 40281, 40284, 10, 4, 0],
      [start + 120, 40283, 40285, 40281, 40284, 30, 2, 1]],
    vp30m: [[start, 40283, 10, 4, 0], [start + 1800, 40283, 30, 2, 1]],
    gaps: [], complete: true, builtAtUs: 1 };
  const day = parseDay(raw, "GC");
  assert.throws(() => parseDay(raw, "NQ"));
  assert.equal(latestContract([day]), "GCZ6");
  const offsets = adjustmentTable(["UNKNOWN", "GCZ6"], [], "GCZ6");
  assert.equal(offsets.get("UNKNOWN"), null); assert.equal(offsets.get("GCZ6"), 0);
  assert.equal(adjustmentTable(["UNKNOWN"], [], "UNKNOWN").get("UNKNOWN"), null);
  assert.equal(adjustmentTable(["GCJ6"], [], "GCZ6").get("GCJ6"), null);
  const result = buildSeries([day], [], "GCZ6");
  assert.equal(result.bars.length, 1); assert.deepEqual(result.gaps, []);
  assert.equal(result.unadjustableDates.has(day.tradingDate), true);
  assert.equal(result.cvd.at(-1)!.v, 34);
});

test("GC roll adjustments use GC delivery months and integer GC ticks without accepting NQ records", () => {
  const rows = [{ from: "GCZ6", to: "GCG7", atSec: 1, diffTicks: 12, method: "fixture" }];
  const rolls = parseRolls(rows, "GC");
  assert.equal(adjustmentTable(["GCZ6", "GCG7"], rolls, "GCG7").get("GCZ6"), 12);
  assert.equal(instrumentPrice(40283 + 12, "GC"), "4029.5");
  assert.throws(() => parseRolls(rows, "NQ"));
});
