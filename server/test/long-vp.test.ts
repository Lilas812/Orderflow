import { test } from "node:test";
import assert from "node:assert/strict";
import { atET, batchDate, nextBatchUs, session, sessionAt } from "../src/long-vp/calendar.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { contractAt, fill, missing } from "../src/long-vp/fill.ts";
import { LongRest, rollSinceUs } from "../src/long-vp/rest.ts";
import type { LongSource, Roll } from "../src/long-vp/rest.ts";
import { LongVpService, productionAccumulation } from "../src/long-vp/service.ts";
import type { LongStore, SessionRecord } from "../src/long-vp/store.ts";
import type { Trade } from "../src/types.ts";

const us = (s: string) => Date.parse(s) * 1000;
const trade = (tsUs: number, price = 400, size = 2, side: "buy" | "sell" = "buy"): Trade =>
  ({ tsUs, price, size, side, seq: 1, recvUs: tsUs });
const signal = () => new AbortController().signal;
const roll: Roll = { contract: "NQZ6", sinceUs: us("2026-09-14T07:46:50Z") };

test("long VP ET calendar follows Nov 1 DST, rather than adding 24 UTC hours", () => {
  assert.equal(atET("2026-10-31", 17, 10), us("2026-10-31T21:10:00Z"));
  assert.equal(atET("2026-11-01", 17, 10), us("2026-11-01T22:10:00Z"));
  assert.equal(nextBatchUs(us("2026-10-31T21:10:00Z")), us("2026-11-01T22:10:00Z"));
  assert.equal(batchDate(us("2026-11-01T22:09:59Z")), "2026-10-31");
  assert.equal(batchDate(us("2026-11-01T22:10:00Z")), "2026-11-01");
  assert.equal(session("2026-11-02").startUs, us("2026-11-01T23:00:00Z"));
  assert.equal(sessionAt(us("2026-11-01T22:30:00Z")), null);
  assert.equal(sessionAt(us("2026-11-01T23:00:00Z"))?.date, "2026-11-02");
});
test("long VP calendar handles spring DST and exact 17/18 ET boundaries", () => {
  assert.equal(atET("2027-03-13", 17, 10), us("2027-03-13T22:10:00Z"));
  assert.equal(atET("2027-03-14", 17, 10), us("2027-03-14T21:10:00Z"));
  assert.equal(sessionAt(atET("2026-10-28", 17)), null);
  assert.equal(sessionAt(atET("2026-10-28", 18))?.date, "2026-10-29");
  assert.equal(sessionAt(atET("2026-10-28", 16))?.date, "2026-10-28");
});
test("long VP aggregation keeps contracts, 30 minute boundaries, OHLC time order, exact duplicates", () => {
  const a = new LongAggregate(), t = us("2026-10-28T13:30:00Z");
  a.add(trade(t + 20e6, 402), "NQZ6");
  a.add(trade(t + 10e6, 400, 3, "sell"), "NQZ6");
  a.add(trade(t + 20e6, 402), "NQZ6"); // A legitimate identical print, not a duplicate to erase.
  a.add(trade(t + 1800e6, 410), "NQZ6");
  a.add(trade(t + 20e6, 500), "NQH7");
  const b = [...a.minutes.values()].find(b => b.contract === "NQZ6" && b.startUs === t)!;
  assert.deepEqual([b.open, b.high, b.low, b.close, b.buy, b.sell], [400, 402, 400, 402, 4, 3]);
  assert.deepEqual(a.snapshot(), { trades: 5, volumeRows: 4, minuteRows: 3 });
});
test("long VP coverage is half open and does not re-fetch saved ranges", () => {
  assert.deepEqual(missing(0, 100, [{ startUs: 20, endUs: 30 }, { startUs: 30, endUs: 50 }]),
    [{ startUs: 0, endUs: 20 }, { startUs: 50, endUs: 100 }]);
  assert.equal(contractAt(roll.sinceUs - 1, [roll]), null);
  assert.equal(contractAt(roll.sinceUs, [roll]), "NQZ6");
  assert.equal(rollSinceUs("2026-09-14T07:46:50.905071381+00:00"), roll.sinceUs + 905071);
  assert.throws(() => rollSinceUs(null), /unverified/);
});
test("long VP truncation recursively splits, discards parent rows, and keeps one-second failures as gaps", async () => {
  const t = us("2026-10-28T13:30:00Z"), calls: number[][] = [];
  const source: LongSource = {
    roll: async () => roll,
    ticks: async (a, b) => {
      calls.push([a, b]);
      return { trades: [trade(a), trade(b)], truncated: b - a > 1e6 };
    },
  };
  const a = new LongAggregate();
  const r = await fill(source, a, [{ startUs: t, endUs: t + 4e6 }], [roll], signal());
  assert.equal(a.count, 4);
  assert.equal(calls.length, 7);
  assert.deepEqual(r.coverage, [{ startUs: t, endUs: t + 4e6 }]);
  source.ticks = async () => ({ trades: [trade(t)], truncated: true });
  const failed = await fill(source, a, [{ startUs: t, endUs: t + 1e6 }], [roll], signal());
  assert.equal(failed.coverage.length, 0);
  assert.equal(failed.gaps[0].reason, "truncated_single_second");
  assert.equal(a.count, 4);
});
test("long VP request retries are capped at three; auth failure is immediately fatal", async () => {
  let calls = 0, waits = 0;
  const rest = new LongRest("DUMMY_TEST_KEY", async () => {
    calls++; return new Response("unavailable", { status: 503 });
  }, async () => { waits++; });
  await assert.rejects(rest.roll(signal()), /long_rest_exhausted/);
  assert.equal(calls, 3); assert.equal(waits, 2);
  const forbidden = new LongRest("DUMMY_TEST_KEY", async () => new Response("", { status: 401 }));
  await assert.rejects(forbidden.roll(signal()), /long_rest_auth_failed/);
});
test("long VP REST validates microseconds/prices, excludes end rows, preserves legitimate duplicate ticks", async () => {
  const t = us("2026-10-28T13:30:00Z");
  const rest = new LongRest("DUMMY_TEST_KEY", async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("start"), String(t / 1e6));
    assert.equal(url.searchParams.get("limit"), "100000");
    return Response.json({ ticks: [
      { ts: t, price: 100, size: 2, side: "buy" }, { ts: t, price: 100, size: 2, side: "buy" },
      { ts: t + 1e6, price: 100, size: 2, side: "buy" },
    ], truncated: false });
  });
  const page = await rest.ticks(t, t + 1e6, signal());
  assert.equal(page.trades.length, 2);
  assert.equal(page.trades[0].price, 400);
});
test("long VP unknown contract is a gap, never an invented expiry; cancellation propagates", async () => {
  let calls = 0;
  const source: LongSource = { roll: async () => roll, ticks: async () => {
    calls++; return { trades: [], truncated: false };
  } };
  const r = await fill(source, new LongAggregate(), [{ startUs: 0, endUs: 1e6 }], [roll], signal());
  assert.equal(calls, 0); assert.equal(r.gaps[0].reason, "unverified_contract");
  const c = new AbortController(); c.abort();
  await assert.rejects(fill(source, new LongAggregate(), [{ startUs: 0, endUs: 1e6 }], [roll], c.signal));
});

class DummyStore implements LongStore {
  recordsMap = new Map<string, SessionRecord>();
  data = new Map<string, LongAggregate>();
  savedRolls: Roll[] = [];
  writes = 0;
  closed = false;
  async records() { return [...this.recordsMap.values()]; }
  async rolls() { return this.savedRolls.slice(); }
  async load(date: string) { return structuredAggregate(this.data.get(date)!); }
  async save(r: SessionRecord, a: LongAggregate, rolls: Roll[]) {
    this.recordsMap.set(r.date, structuredClone(r)); this.data.set(r.date, structuredAggregate(a));
    this.savedRolls = rolls.slice(); this.writes++;
  }
  async close() { this.closed = true; }
}
function structuredAggregate(a: LongAggregate) {
  const b = new LongAggregate();
  for (const [k, v] of a.volumes) b.volumes.set(k, { ...v });
  for (const [k, v] of a.minutes) b.minutes.set(k, { ...v });
  b.count = a.count; return b;
}
test("long VP completed days use REST only, restart is idempotent, partial day repairs only missing windows", async () => {
  const store = new DummyStore(), requests: number[][] = [];
  const now = atET("2026-10-28", 17, 11);
  let failWindow = true;
  const failStart = session("2026-10-28").startUs + 900e6;
  const source: LongSource = { roll: async () => roll, ticks: async (a, b) => {
    requests.push([a, b]);
    if (a === failStart && failWindow) throw Error("long_rest_exhausted");
    return { trades: [trade(a)], truncated: false };
  } };
  const logs: unknown[] = [];
  const service = new LongVpService(source, store, (e, d) => { logs.push([e, d]); }, () => now);
  await service.run();
  assert.equal(store.recordsMap.get("2026-10-28")!.complete, false);
  const before = store.data.get("2026-10-28")!.count;
  requests.length = 0; failWindow = false;
  const restarted = new LongVpService(source, store, () => {}, () => now);
  await restarted.run();
  assert.deepEqual(requests, [[failStart, failStart + 900e6]]);
  assert.equal(store.data.get("2026-10-28")!.count, before + 1);
  assert.equal(store.recordsMap.get("2026-10-28")!.complete, true);
  requests.length = 0;
  await restarted.run();
  assert.equal(requests.length, 0);
  await restarted.stop();
  assert.equal(store.closed, true);
  assert.ok(logs.length > 0);
});
test("long VP production enablement ignores NODE_ENV and app-storage overrides in development", () => {
  assert.equal(productionAccumulation({ NODE_ENV: "production", HEATMAP_STORAGE: "app-storage" }), false);
  assert.equal(productionAccumulation({ REPLIT_DEPLOYMENT: "1" }), true);
});
test("long VP startup finishes without sockets; unknown metadata blocks before any DB writes", async () => {
  const store = new DummyStore();
  const now = atET("2026-10-28", 17, 11);
  const source: LongSource = { roll: async () => { throw Error("unverified_contract_since"); },
    ticks: async () => { throw Error("DUMMY: must not request ticks"); } };
  const service = new LongVpService(source, store, () => {}, () => now);
  service.start();
  await service.settled();
  assert.equal(service.snapshot().state, "blocked");
  assert.equal(service.snapshot().error, "unverified_contract_since");
  assert.equal(store.writes, 0);
  await service.stop();
});
test("long VP REST handles fractional-second contract seams with no double counts or expiry mixing", async () => {
  const t = us("2026-10-28T13:30:00Z"), seam = t + 1000001;
  const rows = [trade(t), trade(seam - 1), trade(seam), trade(t + 2e6)];
  const source: LongSource = { roll: async () => roll,
    ticks: async () => ({ trades: rows, truncated: false }) };
  const a = new LongAggregate();
  await fill(source, a, [{ startUs: t, endUs: t + 3e6 }],
    [roll, { contract: "NQH7", sinceUs: seam }], signal());
  assert.equal(a.count, 4);
  assert.equal([...a.volumes.values()].find(v => v.contract === "NQZ6")!.buy, 4);
  assert.equal([...a.volumes.values()].find(v => v.contract === "NQH7")!.buy, 4);
});
test("long VP closing a day never promotes provisional live memory into authoritative DB aggregates", async () => {
  const store = new DummyStore();
  let now = atET("2026-10-28", 10);
  const source: LongSource = { roll: async () => roll,
    ticks: async (a) => ({ trades: [trade(a)], truncated: false }) };
  const service = new LongVpService(source, store, () => {}, () => now);
  await service.run();
  service.trade(trade(now, 999999, 100000));
  assert.equal(service.snapshot().provisional.trades, 1);
  assert.equal(service.snapshot().provisional.authoritative, false);
  now = atET("2026-10-28", 17, 11);
  await service.run();
  const saved = store.data.get("2026-10-28")!;
  assert.equal(saved.count, 92);
  assert.equal([...saved.volumes.values()].some(v => v.price === 999999), false);
  assert.equal([...saved.volumes.values()].reduce((n, v) => n + v.buy + v.sell, 0), 184);
  await service.stop();
});
test("long VP catches up when initial acquisition crosses today's 17:10 ET schedule", async () => {
  const store = new DummyStore();
  let now = atET("2026-10-28", 17, 9);
  let resolveSaved!: () => void;
  const saved = new Promise<void>(resolve => { resolveSaved = resolve; });
  const source: LongSource = { roll: async () => roll, ticks: async (a) => {
    now = atET("2026-10-28", 17, 11);
    return { trades: [trade(a)], truncated: false };
  } };
  const service = new LongVpService(source, store, (event, details) => {
    if (event === "long_vp_session_saved" && details && typeof details === "object"
      && "date" in details && details.date === "2026-10-28") resolveSaved();
  }, () => now);
  const timeout = setTimeout(() => resolveSaved(), 1000);
  try {
    service.start();
    await saved;
    assert.equal(store.recordsMap.get("2026-10-28")?.complete, true);
  } finally { clearTimeout(timeout); await service.stop(); }
});
