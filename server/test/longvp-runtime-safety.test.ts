import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Objects } from "../src/store/objects.ts";
import type { ConditionalCloud, CloudVersion } from "../src/import/longvp-cloud.ts";
import { LongObjects } from "../src/long-vp/objects.ts";
import { AppLongVp } from "../src/long-vp/app-service.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { serializeDay } from "../src/long-vp/day.ts";
import { atET } from "../src/long-vp/calendar.ts";
import { LocalStore } from "../src/store/local.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import { HistoryClient, WindowUnavailableError, NetworkWindowSplitError } from "../src/history/client.ts";
import { readTradeRange } from "../src/vp/trade-history.ts";
import { createLogger } from "../src/logger.ts";
import type { Trade } from "../src/types.ts";

class MemoryCloud implements ConditionalCloud {
  files = new Map<string, { bytes: Buffer; version: CloudVersion }>();
  seq = 0; beforePut: (() => Promise<void>) | null = null;
  async list(p: string) { return [...this.files.keys()].filter(n => n.startsWith(p)); }
  async stat(n: string) { return this.files.get(n)?.version ?? null; }
  async download(n: string, g: string, f: string) {
    const v = this.files.get(n);
    if (!v || v.version.generation !== g) throw Object.assign(Error("missing_generation"), { code: 404 });
    await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, v.bytes);
  }
  async put(n: string, f: string, expected: string | null, metadata: Record<string, string> = {}) {
    const hook = this.beforePut; this.beforePut = null; await hook?.();
    if ((this.files.get(n)?.version.generation ?? null) !== expected) throw Object.assign(Error("conflict"), { code: 412 });
    const bytes = await fs.readFile(f), generation = String(++this.seq);
    this.files.set(n, { bytes, version: { generation, size: bytes.length, metadata } });
    return generation;
  }
  async remove(n: string, generation: string) {
    if (this.files.get(n)?.version.generation !== generation) throw Object.assign(Error("conflict"), { code: 412 });
    this.files.delete(n);
  }
}
class MemoryObjects implements Objects {
  conditional = new MemoryCloud();
  async exists(n: string) { return this.conditional.files.has(n); }
  async list(p: string) { return this.conditional.list(p); }
  async download(n: string, f: string) {
    return this.conditional.download(n, (await this.conditional.stat(n))!.generation, f);
  }
  async upload() { throw Error("unguarded_upload_forbidden_in_test"); }
}
class SavedStore extends LocalStore { protected override async retention() {} }
const noop = () => {};
const meta = { contract: "NQZ6", sinceUs: atET("2026-10-01", 0) };
const trade = (tsUs: number, size: number, seq = 1): Trade =>
  ({ tsUs, recvUs: tsUs, seq, price: 400, size, side: "buy" });
const qty = (d: Awaited<ReturnType<LongObjects["day"]>>) => d.vp30m.reduce((n, r) => n + r[2] + r[3] + (r[5] ?? 0), 0);
async function fixture(t: test.TestContext, symbol: "NQ" | "GC" = "NQ") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longvp-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const objects = new MemoryObjects(), repo = new LongObjects(objects, "prod/", path.join(root, "tmp"), symbol);
  const store = new SavedStore(path.join(root, "raw")); await store.initialize();
  return { root, objects, repo, store };
}
function day(size: number, complete = true) {
  const a = new LongAggregate(), us = atET("2026-10-28", 10);
  a.add(trade(us, size), "NQZ6");
  return serializeDay("2026-10-28", a, [meta], complete ? [] : [[us / 1e6 + 60, us / 1e6 + 120]], us);
}
for (const race of [false, true]) test(`CAS: external stronger day is preserved ${race ? "during" : "before"} upload`, async t => {
  const { root, objects, repo } = await fixture(t);
  await repo.save(day(1, false));
  const external = new LongObjects(objects, "prod/", path.join(root, "external"));
  if (race) objects.conditional.beforePut = async () => { await external.save(day(100)); };
  else await external.save(day(100));
  const result = await repo.save(day(2));
  assert.equal(result.saved, false); assert.equal(qty(await repo.day("2026-10-28")), 100);
  const reader = new LongObjects(objects, "prod/", path.join(root, "reader"));
  assert.equal(qty(await reader.day("2026-10-28")), 100);
});
test("CAS: absent-target creation race reloads latest body, while ordinary improvement succeeds", async t => {
  const { root, objects, repo } = await fixture(t);
  const other = new LongObjects(objects, "prod/", path.join(root, "other"));
  objects.conditional.beforePut = async () => { await other.save(day(10)); };
  assert.equal((await repo.save(day(2))).saved, false);
  assert.equal((await repo.save(day(12))).saved, true);
  assert.equal(qty(await other.day("2026-10-28")), 10); // Intentionally stale cache.
  const fresh = new LongObjects(objects, "prod/", path.join(root, "fresh"));
  assert.equal(qty(await fresh.day("2026-10-28")), 12);
});
test("CT16:55 snapshots saved partial prints despite hung history; next seven-day rebuild fills it without doubling", async t => {
  const { repo, store } = await fixture(t);
  let now = atET("2026-10-28", 17, 54), sequence = 10, calls = 0;
  const hole = atET("2026-10-28", 10) / 1e6;
  await store.addTrades([trade(atET("2026-10-28", 9), 7)]);
  store.markCovered("tick", now / 1e6 - 8 * 86400, hole);
  store.markCovered("tick", hole + 60, now / 1e6); await store.flush();
  let entered!: () => void;
  const fetching = new Promise<void>(r => { entered = r; });
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop), metadata: { roll: async () => meta },
    now: () => now, nextSeq: () => ++sequence, log: noop,
    history: { get: async (_k, _a, _b, signal) => {
      calls++; entered(); return new Promise((_resolve, reject) => signal.addEventListener("abort",
        () => reject(signal.reason), { once: true }));
    } } });
  t.after(() => service.stop());
  service.start(); await fetching;
  await service.saveRecordedDeadline(); assert.equal(repo.records.has("2026-10-28"), false);
  now = atET("2026-10-28", 17, 55);
  await service.saveRecordedDeadline();
  const partial = await repo.day("2026-10-28");
  assert.equal(partial.complete, false); assert.equal(qty(partial), 7); assert.equal(calls, 1);
  assert.ok(partial.gaps.some(([a, b]) => a <= hole && b >= hole + 60));
  assert.ok(partial.gaps.every(([, b]) => b <= atET("2026-10-28", 17) / 1e6));
  await service.stop(); // The hung request and deadline timers must cancel.
  await store.addTrades([trade((hole + 1) * 1e6, 3, ++sequence)]);
  now = atET("2026-10-29", 18, 6);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  const restarted = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop), metadata: { roll: async () => meta },
    now: () => now, nextSeq: () => ++sequence, log: noop,
    history: { get: async () => { throw Error("unexpected_history"); } } });
  await restarted.run();
  assert.equal((await repo.day("2026-10-28")).complete, true); assert.equal(qty(await repo.day("2026-10-28")), 10);
  await restarted.stop();
});
test("network failure splits 15-minute windows once, retries a one-minute leaf three times, preserves successful siblings", async t => {
  const { store } = await fixture(t), calls: [number, number][] = [], logs: any[] = [];
  const client = new HistoryClient("DUMMY-SECRET", (event, details) => logs.push({ event, details }), async input => {
    const u = new URL(String(input)), a = Number(u.searchParams.get("start")), b = Number(u.searchParams.get("end"));
    calls.push([a, b]);
    if (b - a > 60 || a === 3000) throw Error("simulated_timeout");
    return Response.json({ ticks: [{ ts: a * 1e6 + 1, price: 100, size: 2, side: "buy" }], truncated: false });
  }, async () => {}, "GC");
  let seq = 0; const received: Trade[] = [];
  const state = await readTradeRange({ store, source: client, metrics: new Metrics(noop), nextSeq: () => ++seq,
    signal: new AbortController().signal, start: 3000, end: 3900, visit: t => received.push(t),
    schedule: { now: () => 10000000, wait: async () => {} } });
  assert.equal(calls.filter(([a, b]) => a === 3000 && b === 3900).length, 1);
  assert.equal(calls.filter(([a, b]) => a === 3000 && b === 3060).length, 3);
  assert.ok(calls.every(([a, b]) => b - a >= 60));
  assert.deepEqual(state.gaps, [{ startSec: 3000, endSec: 3060, reason: "network_or_timeout" }]);
  assert.equal(received.length, 14); assert.equal(received.reduce((n, t) => n + t.size, 0), 28);
  assert.equal(store.covered("tick", 3000), false); assert.equal(store.covered("tick", 3060), true);
  assert.ok(logs.filter(l => l.event === "history_request_failed").every(l =>
    l.details.symbol === "GC" && l.details.elapsedMs >= 0 && Number.isFinite(l.details.start) && Number.isFinite(l.details.end)));
  assert.equal(JSON.stringify(logs).includes("DUMMY-SECRET"), false);
});
test("one minute fails three times; large body-read failure requests split; malformed JSON does not; abort is not retried", async () => {
  let calls = 0, waits = 0;
  const c = new HistoryClient("dummy", noop, async () => { calls++; throw Error("network"); }, async () => { waits++; });
  await assert.rejects(c.get("tick", 0, 60, new AbortController().signal), WindowUnavailableError);
  assert.equal(calls, 3); assert.equal(waits, 2);
  const body = new HistoryClient("dummy", noop, async () => {
    const r = Response.json({}); r.json = async () => { throw new TypeError("body"); }; return r;
  });
  await assert.rejects(body.get("tick", 0, 900, new AbortController().signal), NetworkWindowSplitError);
  const malformed = new HistoryClient("dummy", noop, async () => new Response("{"));
  await assert.rejects(malformed.get("tick", 0, 900, new AbortController().signal), /invalid_history_json/);
  const abort = new AbortController();
  const stopped = new HistoryClient("dummy", noop, async () => { abort.abort(); throw Error("network"); });
  await assert.rejects(stopped.get("tick", 0, 900, abort.signal), e => (e as Error).name === "AbortError");
  assert.equal(stopped.stats.retries, 0);
});
test("GC failure exposes original error, nested cause and stack through credential sanitizer", async t => {
  const { repo, store } = await fixture(t, "GC"), lines: string[] = [];
  const cause = Object.assign(new Error("inner DUMMY-SECRET"), { code: "ECONNRESET" });
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop), nextSeq: () => 1,
    now: () => atET("2026-10-28", 10), log: createLogger("DUMMY-SECRET", s => lines.push(s)),
    history: { get: async () => { throw Error("unused"); } },
    metadata: { roll: async () => { throw new Error("outer error", { cause }); } } });
  service.start(); await service.settled(); await service.stop();
  const failure = lines.map(l => JSON.parse(l)).find(l => l.event === "long_vp_failed").details;
  assert.equal(failure.symbol, "GC"); assert.equal(failure.reason, "longvp_failed");
  assert.equal(failure.error.message, "outer error"); assert.equal(failure.error.cause.code, "ECONNRESET");
  assert.match(failure.error.cause.message, /REDACTED/); assert.ok(failure.error.stack);
  assert.equal(lines.join("").includes("DUMMY-SECRET"), false);
});
test("GC deadline uses CT wall clock across DST, skips Saturday, retains explicit and UNKNOWN saved contracts", async t => {
  const { repo, store } = await fixture(t, "GC");
  let now = atET("2026-10-30", 17, 55), sequence = 1;
  const rows = [
    { ...trade(atET("2026-10-30", 10), 2, sequence++), contract: "GCZ6" },
    trade(atET("2026-10-30", 10, 1), 3, sequence++),
    { ...trade(atET("2026-11-02", 10), 4, sequence++), contract: "GCZ6" },
  ];
  await store.addTrades(rows); await store.flush();
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop), nextSeq: () => ++sequence,
    now: () => now, log: noop, metadata: { roll: async () => { throw Error("must_not_wait_for_metadata"); } },
    history: { get: async () => { throw Error("must_not_fetch_history"); } } });
  await service.saveRecordedDeadline();
  const friday = await repo.day("2026-10-30");
  assert.equal(friday.complete, false); assert.equal(qty(friday), 5);
  assert.deepEqual(friday.contracts.map(c => c.contract).sort(), ["GCZ6", "UNKNOWN"]);
  now = atET("2026-10-31", 17, 55); await service.saveRecordedDeadline();
  assert.equal(repo.records.has("2026-10-31"), false);
  now = atET("2026-11-02", 17, 54); await service.saveRecordedDeadline();
  assert.equal(repo.records.has("2026-11-02"), false);
  now = atET("2026-11-02", 17, 55); await service.saveRecordedDeadline();
  const monday = await repo.day("2026-11-02");
  assert.equal(qty(monday), 4); assert.equal(monday.startSec, Date.parse("2026-11-01T23:00:00Z") / 1000);
  assert.equal(monday.complete, false); await service.stop();
});
