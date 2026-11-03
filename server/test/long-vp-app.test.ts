import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import { AppLongVp, accumulationEnabled, improvesDay } from "../src/long-vp/app-service.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { LongObjects, validateDay, validateRolls } from "../src/long-vp/objects.ts";
import { atET } from "../src/long-vp/calendar.ts";
import { dayAt, dayBounds, datesBetween, edgeDifference, isRth, nextFinalizeUs, serializeDay,
  weekStartUs } from "../src/long-vp/day.ts";
import { LocalStore } from "../src/store/local.ts";
import type { Objects } from "../src/store/objects.ts";
import { ObjectGenerationConflict } from "../src/store/objects.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import { readTradeRange } from "../src/vp/trade-history.ts";
import { WindowUnavailableError } from "../src/history/client.ts";
import { longVpRouter } from "../src/long-vp/routes.ts";
import type { Trade } from "../src/types.ts";
import { createLogger } from "../src/logger.ts";

const noop = () => {};
test("ダミー：欠け補完後は当日と確定済み日を保存経路から再集計し、再通知で二重加算しない", async t => {
  const { root, repo, objects } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  const now = atET("2026-10-28", 18, 6);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  let seq = 0;
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
    nextSeq: () => ++seq, now: () => now, metadata: { roll: async () => metadata },
    history: { get: async () => { throw Error("unexpected_dummy_request"); } }, log: noop });
  t.after(() => service.stop());
  await service.run();
  const current = trade(now - 60e6, 400, 7, "buy", ++seq);
  await store.addTrades([current]); await store.flush();
  const second = Math.floor(current.tsUs / 1e6);
  service.historyRepaired(second, second + 1); await service.run();
  assert.equal(service.today()!.vp30m.reduce((n, row) => n + row[2] + row[3], 0), 7);
  service.historyRepaired(second, second + 1); await service.run();
  assert.equal(service.today()!.vp30m.reduce((n, row) => n + row[2] + row[3], 0), 7);
  const old = trade(atET("2026-10-27", 18, 30), 400, 11, "buy", ++seq);
  await store.addTrades([old]); await store.flush();
  service.historyRepaired(old.tsUs / 1e6, old.tsUs / 1e6 + 1); await service.run();
  const saved = [...objects.files].find(([name]) => name.endsWith("2026-10-28.json.gz"));
  assert(saved);
  const { gunzipSync } = await import("node:zlib");
  const day = JSON.parse(gunzipSync(saved[1]).toString());
  assert.equal(day.vp30m.reduce((n: number, row: number[]) => n + row[2] + row[3], 0), 11);
});

test("ダミー：日次処理は先行backfill/VPがrunningでも完了待ちせず保存する", async t => {
  const { root, repo, objects } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  const now = atET("2026-10-28", 18, 6);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6);
  await store.flush();
  const logs: { event: string; details: any }[] = [];
  let requests = 0, seq = 0;
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
    nextSeq: () => ++seq, now: () => now, metadata: { roll: async () => metadata },
    history: { get: async () => { requests++; throw Error("DUMMY-unexpected-request"); } },
    readyStatus: () => ({ seamReady: false, backfillState: "running", vpHistoryState: "running" }),
    log: (event, details) => logs.push({ event, details }) });
  await service.run();
  assert.equal(requests, 0);
  assert.ok(objects.uploads.some(n => n.endsWith("2026-10-28.json.gz")));
  const stages = logs.filter(r => r.event === "long_vp_stage_started").map(r => r.details.stage);
  for (const stage of ["repository_initialize", "rolls_read", "metadata", "today_restore", "build", "save"])
    assert.ok(stages.includes(stage), stage);
  const diagnosticRows = logs.filter(r => r.event.startsWith("long_vp_stage_") || r.event === "long_vp_decision");
  assert.ok(diagnosticRows.every(r => r.details.symbol === "NQ" && r.details.runId));
  assert.ok(logs.some(r => r.event === "long_vp_decision" && r.details.action === "save"));
  const uploads = objects.uploads.filter(n => n.endsWith("2026-10-28.json.gz")).length;
  await service.run();
  assert.equal(objects.uploads.filter(n => n.endsWith("2026-10-28.json.gz")).length, uploads);
  assert.ok(logs.some(r => r.event === "long_vp_decision" && r.details.action === "skip"));
  await service.stop();
});
test("ダミー：診断はimprovesDayの拒否を変えず、保存済みの行を保全する", async t => {
  const { root, repo, objects } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  const now = atET("2026-10-28", 18, 6), ts = atET("2026-10-28", 10);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6);
  await store.flush();
  const a = new LongAggregate();
  a.add(trade(ts, 400, 5), "NQZ6");
  await repo.save(serializeDay("2026-10-28", a, [metadata], [[ts / 1e6 + 1, ts / 1e6 + 10]], now));
  const key = "dev/longvp/NQ/days/2026-10-28.json.gz", original = Buffer.from(objects.files.get(key)!);
  const logs: { event: string; details: any }[] = [];
  let seq = 0;
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
    nextSeq: () => ++seq, now: () => now, metadata: { roll: async () => metadata },
    history: { get: async () => { throw Error("DUMMY-unexpected-request"); } },
    log: (event, details) => logs.push({ event, details }) });
  await service.run();
  assert.deepEqual(objects.files.get(key), original);
  assert.ok(logs.some(r => r.event === "long_vp_decision" && r.details.date === "2026-10-28"
    && r.details.action === "preserve"));
  assert.equal(objects.uploads.filter(n => n === key).length, 1);
  await service.stop();
});
for (const failedStage of ["repository_initialize", "metadata", "build", "save"]) {
  test(`ダミー：${failedStage}失敗を段階ログで特定し、元の例外を保持`, async t => {
    const { root, repo } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
    await store.initialize();
    const now = atET("2026-10-28", 18, 6), error = Error("DUMMY-raw-payload");
    store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6);
    await store.flush();
    if (failedStage === "repository_initialize") repo.initialize = async () => { throw error; };
    if (failedStage === "save") repo.save = async () => { throw error; };
    if (failedStage === "build") store.recordedTickCoverage = async () => { throw error; };
    const logs: { event: string; details: any }[] = [];
    let seq = 0;
    const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
      nextSeq: () => ++seq, now: () => now,
      metadata: { roll: async () => { if (failedStage === "metadata") throw error; return metadata; } },
      history: { get: async () => { throw Error("DUMMY-unexpected-request"); } },
      log: (event, details) => logs.push({ event, details }) });
    await assert.rejects(service.run(), e => e === error);
    assert.ok(logs.some(r => r.event === "long_vp_stage_finished"
      && r.details.stage === failedStage && r.details.outcome === "failed"));
    assert.equal(logs.at(-1)!.details.outcome, "failed");
    assert.ok(!JSON.stringify(logs).includes(error.message));
    await service.stop();
  });
}
class DummyStore extends LocalStore { protected override async retention() {} }
const metadata = { contract: "NQZ6", sinceUs: Date.parse("2026-09-14T07:46:50Z") * 1000 };
function trade(us: number, price = 400, size = 2, side: "buy" | "sell" = "buy", seq = 1): Trade {
  return { tsUs: us, recvUs: us, price, size, side, seq };
}
class DummyObjects implements Objects {
  files = new Map<string, Buffer>();
  downloads = 0; uploads: string[] = [];
  corrupt = false;
  generations = new Map<string, string>();
  counter = 0;
  async exists(name: string) { return this.files.has(name); }
  async list(prefix: string) { return [...this.files.keys()].filter(n => n.startsWith(prefix)); }
  async download(name: string, file: string) {
    this.downloads++;
    if (!this.files.has(name)) throw Error("dummy_missing");
    await fs.writeFile(file, this.corrupt ? Buffer.from("DUMMY: corrupt") : this.files.get(name)!);
  }
  async upload(name: string, file: string) {
    this.files.set(name, await fs.readFile(file)); this.uploads.push(name);
    this.generations.set(name, String(++this.counter));
  }
  async downloadVersion(name: string, file: string, generation?: string) {
    if (!this.files.has(name)) {
      if (generation) throw new ObjectGenerationConflict();
      return null;
    }
    const current = this.generations.get(name)!;
    if (generation && current !== generation) throw new ObjectGenerationConflict();
    await this.download(name, file);
    return current;
  }
  async uploadConditional(name: string, file: string, generation: string) {
    const bytes = await fs.readFile(file);
    if ((this.generations.get(name) ?? "0") !== generation) throw new ObjectGenerationConflict();
    this.files.set(name, bytes); this.uploads.push(name);
    const next = String(++this.counter); this.generations.set(name, next); return next;
  }
}
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-longvp-app-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const objects = new DummyObjects(), repo = new LongObjects(objects, "dev/", path.join(root, "tmp"));
  return { root, objects, repo };
}
test("ダミー：CT16:55の記録済み日次は進行中の履歴窓を待たず、後の7日再構築で埋まる", async t => {
  const { root, repo } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  let now = atET("2026-10-28", 17, 54), seq = 10, calls = 0, release!: () => void, entered!: () => void;
  const hole = atET("2026-10-28", 17, 30) / 1e6;
  await store.addTrades([trade(atET("2026-10-28", 17, 15), 444, 3)]);
  store.markCovered("tick", now / 1e6 - 8 * 86400, hole);
  store.markCovered("tick", hole + 60, now / 1e6); await store.flush();
  const blocked = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
    metadata: { roll: async () => metadata }, nextSeq: () => ++seq, log: noop, now: () => now,
    history: { get: async () => { calls++; entered(); await blocked; return { truncated: false, rows: [] }; } } });
  const background = service.run();
  await started;
  try {
    now = atET("2026-10-28", 17, 55);
    await service.checkpoint();
    const partial = await repo.day("2026-10-28");
    assert.equal(partial.complete, false);
    assert.equal(calls, 1);
    assert.ok(partial.gaps.some(([a, b]) => a <= hole && b >= hole + 60));
    assert.ok(partial.gaps.some(([a, b]) => a <= now / 1e6 && b === dayBounds("2026-10-28").endUs / 1e6));
    assert.equal(partial.vp30m.reduce((n, r) => n + r[2], 0), 3);
    now = atET("2026-10-28", 18, 5);
    await store.addTrades([trade(hole * 1e6, 445, 6)]);
    store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  } finally { release(); }
  await background;
  assert.equal((await repo.day("2026-10-28")).complete, true);
  assert.equal((await repo.day("2026-10-28")).vp30m.reduce((n, r) => n + r[2], 0), 9);
  await service.stop();
});
test("ダミー：既存タイマーがCT16:55で不完全日を保存し、CT17:05で確定する", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { root, repo } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  let now = atET("2026-10-28", 17, 54), seq = 0;
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
    metadata: { roll: async () => metadata }, nextSeq: () => ++seq, log: noop, now: () => now,
    history: { get: async () => { throw Error("DUMMY: no network allowed"); } } });
  service.start(); await service.settled();
  assert.equal(repo.records.has("2026-10-28"), false);
  now = atET("2026-10-28", 17, 55);
  t.mock.timers.tick(60000); await service.settled();
  assert.equal((await repo.day("2026-10-28")).complete, false);
  now = atET("2026-10-28", 18, 5);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  t.mock.timers.tick(60000); await service.settled();
  assert.equal((await repo.day("2026-10-28")).complete, true);
  await service.stop();
});
test("ダミー：限月切替後の16:55保存がmetadataより先でも旧限月を延長せず17:05に再集計できる", async t => {
  const { root, repo } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  let now = atET("2026-10-28", 17, 55), seq = 0, release!: () => void, entered!: () => void;
  await repo.save(serializeDay("2026-10-27", new LongAggregate(), [metadata], [], now));
  await store.addTrades([trade(atET("2026-10-28", 12), 450, 9)]);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  const pending = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
    nextSeq: () => ++seq, now: () => now, log: noop,
    metadata: { roll: async () => { entered(); await pending;
      return { contract: "NQH7", sinceUs: atET("2026-10-28", 11) }; } },
    history: { get: async () => { throw Error("DUMMY: unexpected network"); } } });
  const background = service.run();
  await started;
  try {
    await service.checkpoint();
    const early = await repo.day("2026-10-28");
    assert.equal(early.complete, false);
    assert.deepEqual(early.contracts, []);
    assert.deepEqual(early.vp30m, []);
    assert.ok(early.gaps.some(([a, b]) => a <= atET("2026-10-28", 12) / 1e6 && b > atET("2026-10-28", 12) / 1e6));
    now = atET("2026-10-28", 18, 5);
    store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  } finally { release(); }
  await background;
  const repaired = await repo.day("2026-10-28");
  assert.equal(repaired.complete, true);
  assert.equal(repaired.vp30m.reduce((n, r) => n + r[2], 0), 9);
  assert.ok(repaired.vp30m.every(r => repaired.contracts[r[4]].contract === "NQH7"));
  await service.stop();
});
test("ダミー：checkpointは最後のmetadata観測時刻より後の旧限月を推測しない", async t => {
  const { root, repo } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  let now = atET("2026-10-28", 17, 54), seq = 0;
  await store.addTrades([trade(atET("2026-10-28", 17, 15), 444, 3),
    trade(now + 30e6, 450, 9)]);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6 + 60); await store.flush();
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
    nextSeq: () => ++seq, now: () => now, log: noop, metadata: { roll: async () => metadata },
    history: { get: async () => { throw Error("DUMMY: unexpected network"); } } });
  await service.run();
  const observedUntil = now;
  now = atET("2026-10-28", 17, 55);
  await service.checkpoint();
  const early = await repo.day("2026-10-28");
  assert.equal(early.complete, false);
  assert.ok(early.contracts.every(c => c.toSec <= observedUntil / 1e6));
  assert.equal(early.vp30m.reduce((n, r) => n + r[2], 0), 3);
  assert.ok(early.gaps.some(([a, b]) => a <= observedUntil / 1e6 && b > now / 1e6));
  now = atET("2026-10-28", 18, 1);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  await service.run(); // Fresh metadata now confirms the entire finished day.
  await service.checkpoint();
  const immature = await repo.day("2026-10-28");
  assert.equal(immature.complete, false); // No complete file before CT17:05.
  assert.equal(immature.vp30m.reduce((n, r) => n + r[2], 0), 12);
  now = atET("2026-10-28", 18, 5);
  await service.checkpoint();
  assert.equal((await repo.day("2026-10-28")).complete, true);
  await service.stop();
});
test("ダミー：古いLRUよりクラウド最新を優先し、初回作成競合でも外部の増量分を保つ", async t => {
  const { root, repo, objects } = await fixture(t);
  const external = new LongObjects(objects, "dev/", path.join(root, "external"));
  const make = (size: number) => {
    const a = new LongAggregate(); a.add(trade(atET("2026-10-28", 10), 400, size), "NQZ6");
    return serializeDay("2026-10-28", a, [metadata], [], atET("2026-10-28", 18, 5));
  };
  await repo.save(make(5));
  await external.save(make(10));
  assert.equal((await repo.save(make(6))).saved, false);
  assert.equal((await repo.day("2026-10-28")).vp30m[0][2], 10);
  const original = objects.uploadConditional.bind(objects);
  let raced = false;
  objects.uploadConditional = async (name, file, generation) => {
    if (!raced) { raced = true; await external.save(make(20)); }
    return original(name, file, generation);
  };
  assert.equal((await repo.save(make(15))).saved, false);
  assert.equal((await repo.day("2026-10-28")).vp30m[0][2], 20);
  // The absent-object precondition is also a real CAS (ifGenerationMatch=0).
  const other = { ...make(30), tradingDate: "2026-10-29", ...{
    startSec: dayBounds("2026-10-29").startUs / 1e6, endSec: dayBounds("2026-10-29").endUs / 1e6,
    contracts: [], bars1m: [], vp30m: [], gaps: [] } };
  raced = false;
  objects.uploadConditional = async (name, file, generation) => {
    if (!raced) { raced = true; assert.equal(generation, "0"); await external.save(other); }
    return original(name, file, generation);
  };
  assert.equal((await repo.save(other)).saved, true);
  assert.ok(raced);
});
test("ダミー：競合しても候補が最新より良ければ世代を読み直して保存、連続競合は有限で中止", async t => {
  const { root, repo, objects } = await fixture(t);
  const external = new LongObjects(objects, "dev/", path.join(root, "external"));
  const make = (size: number) => {
    const a = new LongAggregate(); a.add(trade(atET("2026-10-28", 10), 400, size), "NQZ6");
    return serializeDay("2026-10-28", a, [metadata], [], atET("2026-10-28", 18, 5));
  };
  await repo.save(make(5));
  const original = objects.uploadConditional.bind(objects);
  let raced = false;
  objects.uploadConditional = async (name, file, generation) => {
    if (!raced) { raced = true; await external.save(make(7)); }
    return original(name, file, generation);
  };
  assert.equal((await repo.save(make(10))).saved, true);
  assert.equal((await repo.day("2026-10-28")).vp30m[0][2], 10);
  let conflicts = 0;
  objects.uploadConditional = async () => { conflicts++; throw new ObjectGenerationConflict(); };
  await assert.rejects(repo.save(make(12)), /conflict_exhausted/);
  assert.equal(conflicts, 5);
  assert.equal((await repo.day("2026-10-28")).vp30m[0][2], 10);
  assert.deepEqual(await fs.readdir(path.join(root, "tmp")), []);
});
test("ダミー：GC long_vp_failedは元の例外・cause・stackを残しAPIキーは伏せる", async t => {
  const { root, objects } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  const repo = new LongObjects(objects, "dev/", path.join(root, "gc"), "GC");
  const lines: string[] = [], logger = createLogger("DUMMY-key", line => lines.push(line));
  const error = Error("original failure DUMMY-key", { cause: Error("original cause") });
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
    metadata: { roll: async () => { throw error; } }, nextSeq: () => 1,
    now: () => atET("2026-10-28", 10), history: { get: async () => { throw Error("unexpected"); } },
    log: (event, fields) => logger(event, { ...(fields as object), symbol: "GC" }) });
  service.start(); await service.settled(); await service.stop();
  const failure = lines.map(s => JSON.parse(s)).find(r => r.event === "long_vp_failed");
  assert.equal(failure.details.symbol, "GC");
  assert.equal(failure.details.error.message, "original failure [REDACTED]");
  assert.equal(failure.details.error.cause.message, "original cause");
  assert.ok(failure.details.error.stack.includes("original failure"));
  assert.ok(!lines.join("").includes("DUMMY-key"));
});
test("ダミー：長期VPは休止を終了側に含め、週末・DST・CT17:05の確定・RTHを区別", () => {
  assert.equal(dayAt(atET("2026-10-28", 17, 59)), "2026-10-28");
  assert.equal(dayAt(atET("2026-10-28", 18)), "2026-10-29");
  assert.equal(dayAt(atET("2026-10-30", 17, 59)), "2026-10-30");
  assert.equal(dayAt(atET("2026-10-30", 18)), null);
  assert.equal(dayAt(atET("2026-11-01", 17, 59)), null);
  assert.equal(dayAt(atET("2026-11-01", 18)), "2026-11-02");
  assert.equal(dayBounds("2026-11-02").startUs, Date.parse("2026-11-01T23:00:00Z") * 1000);
  assert.equal(nextFinalizeUs(atET("2026-10-30", 18, 5)), atET("2026-11-02", 18, 5));
  assert.equal(nextFinalizeUs(atET("2026-11-02", 18, 4)), atET("2026-11-02", 18, 5));
  assert.equal(weekStartUs(atET("2026-10-28", 10)), atET("2026-10-25", 18));
  assert.equal(isRth(atET("2026-10-28", 9, 29)), false);
  assert.equal(isRth(atET("2026-10-28", 9, 30)), true);
  assert.equal(isRth(atET("2026-10-28", 16)), false);
  assert.equal(accumulationEnabled({ LONG_VP_DEV_ENABLE: "1" }), true);
  assert.equal(accumulationEnabled({ NODE_ENV: "production" }), false);
});
test("ダミー：60取引日まで、日付の自動繰上がり・逆範囲を拒否", () => {
  assert.deepEqual(datesBetween("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-11-02"]);
  assert.throws(() => datesBetween("2026-02-30", "2026-03-03"), /invalid/);
  assert.throws(() => datesBetween("2026-10-30", "2026-10-29"), /invalid/);
  assert.equal(datesBetween("2026-01-01", "2026-03-25").length, 60);
  assert.throws(() => datesBetween("2026-01-01", "2026-03-26"), /60/);
});
test("ダミー：配列形式、日中ロール、OHLC・買売・空分、edge根拠と不足", () => {
  const a = new LongAggregate(), start = atET("2026-10-28", 10), seam = start + 25e6;
  a.add(trade(start + 20e6, 404), "NQZ6");
  a.add(trade(start + 10e6, 400, 3, "sell"), "NQZ6");
  a.add(trade(seam, 500, 4), "NQH7");
  const day = serializeDay("2026-10-28", a, [metadata, { contract: "NQH7", sinceUs: seam }], [], start);
  assert.equal(day.bars1m.length, 2);
  assert.deepEqual(day.bars1m[0], [start / 1e6, 500, 500, 500, 500, 4, 0, 1]);
  assert.deepEqual(day.bars1m[1], [start / 1e6, 400, 404, 400, 404, 2, 3, 0]);
  assert.equal(day.vp30m.reduce((n, r) => n + r[2] + r[3], 0), 9);
  assert.equal(validateDay(day), day);
  const edge = edgeDifference("NQU6", "NQZ6", 1789372010905071,
    { tsUs: 1789372010853060, price: 116862 }, { tsUs: 1789372010920253, price: 116863 });
  assert.equal(edge.diffTicks, 1); assert.equal(edge.detail.gapSeconds, 0.067193);
  assert.deepEqual(validateRolls([edge]), [edge]);
  assert.throws(() => edgeDifference("NQU6", "NQZ6", seam, null, trade(seam)), /unavailable/);
  assert.throws(() => validateDay({ ...day, complete: false }), /invalid/);
});
test("ダミー：再DL照合、再起動復元、破損拒否、LRU日数・バイト上限", async t => {
  const { root, objects, repo } = await fixture(t);
  for (const date of datesBetween("2026-10-01", "2026-10-15"))
    await repo.save(serializeDay(date, new LongAggregate(), [metadata], [], atET(date, 18, 5)));
  assert.equal(repo.snapshot().days, 8);
  assert.ok(repo.snapshot().estimatedBytes <= repo.maxBytes);
  assert.ok(objects.uploads.every(n => n.startsWith("dev/longvp/NQ/days/")));
  const restarted = new LongObjects(objects, "dev/", path.join(root, "restart"));
  await restarted.initialize();
  assert.equal(restarted.records.size, 11);
  assert.equal(restarted.snapshot().days, 8);
  const before = objects.downloads;
  await restarted.day("2026-10-15"); await restarted.day("2026-10-15");
  assert.equal(objects.downloads, before);
  objects.corrupt = true;
  await assert.rejects(restarted.day("2026-10-01"));
  const failed = new LongObjects(objects, "dev/", path.join(root, "failure"));
  await assert.rejects(failed.save(serializeDay("2026-10-28", new LongAggregate(), [metadata], [], atET("2026-10-28", 18))), /verification/);
  assert.equal(failed.records.size, 0);
});
test("ダミー：同じ不足を2利用者が同時取得しても1回、既存の正当な重複は保持", async t => {
  const { root } = await fixture(t), store = new LocalStore(root);
  await store.initialize();
  const start = atET("2026-10-28", 10) / 1e6;
  let calls = 0, seq = 0;
  const source = { get: async () => { calls++; return { truncated: false,
    rows: [1, 2].map(() => ({ ts: start * 1e6, price: 100, size: 2, side: "buy" })) }; } };
  const read = async () => {
    const rows: Trade[] = [];
    await readTradeRange({ store, source, metrics: new Metrics(noop), nextSeq: () => ++seq,
      start, end: start + 1, signal: new AbortController().signal, visit: r => rows.push(r),
      schedule: { now: () => (start + 1000) * 1000, wait: async () => {} } });
    return rows;
  };
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(calls, 1); assert.equal(a.length, 2); assert.deepEqual(a, b);
  await store.flush();
});
test("ダミー：REST待ちの間にライブ保存が済んでも衝突せず、既存行を置換しない", async t => {
  const { root } = await fixture(t), store = new LocalStore(root);
  await store.initialize();
  const start = atET("2026-10-28", 10) / 1e6;
  let seq = 10;
  const rows: Trade[] = [];
  await readTradeRange({ store, source: { get: async () => {
    await store.addTrades([trade(start * 1e6, 444)]);
    await store.flush();
    return { truncated: false, rows: [{ ts: start * 1e6, price: 100, size: 20, side: "buy" }] };
  } }, metrics: new Metrics(noop), nextSeq: () => ++seq, start, end: start + 1,
    signal: new AbortController().signal, visit: r => rows.push(r),
    schedule: { now: () => (start + 1000) * 1000, wait: async () => {} } });
  assert.equal(rows.length, 1); assert.equal(rows[0].price, 444); assert.equal(rows[0].size, 2);
});
test("ダミー：保存ファイル優先・当日再起動・日次はライブメモリを昇格させない", async t => {
  const { root, objects, repo } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  let now = atET("2026-10-28", 10), seq = 10, requests = 0;
  const raw = trade(atET("2026-10-28", 9, 31), 444, 3);
  await store.addTrades([raw]); store.markCovered("tick", Math.floor(now / 1e6) - 8 * 86400, Math.ceil(now / 1e6));
  await store.flush();
  const dependencies = { repository: repo, store, metrics: new Metrics(noop), nextSeq: () => ++seq,
    history: { get: async () => { requests++; throw Error("DUMMY: unexpected REST"); } },
    metadata: { roll: async () => metadata }, log: noop, now: () => now };
  const service = new AppLongVp(dependencies);
  await service.run();
  assert.equal(requests, 0);
  assert.equal(service.today()!.vp30m.reduce((n, r) => n + r[2] + r[3], 0), 3);
  service.trade({ ...trade(now, 999999, 100000, "buy", 1000), recvUs: now });
  assert.equal(service.today()!.vp30m.reduce((n, r) => n + r[2] + r[3], 0), 100003);
  const restart = new AppLongVp({ ...dependencies,
    repository: new LongObjects(objects, "dev/", path.join(root, "restart")) });
  await restart.run();
  assert.equal(restart.today()!.vp30m.reduce((n, r) => n + r[2] + r[3], 0), 3);
  now = atET("2026-10-28", 18, 6);
  store.markCovered("tick", Math.floor(now / 1e6) - 8 * 86400, Math.ceil(now / 1e6)); await store.flush();
  await service.run();
  const day = await repo.day("2026-10-28");
  assert.equal(day.complete, true);
  assert.equal(day.vp30m.reduce((n, r) => n + r[2] + r[3], 0), 3);
  await service.stop(); await restart.stop();
});
test("ダミー：失敗区間はgapsとして保存し、次回は不足だけ補って再構築", async t => {
  const { root, repo } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  const now = atET("2026-10-28", 18, 6), hole = atET("2026-10-28", 10) / 1e6;
  store.markCovered("tick", now / 1e6 - 8 * 86400, hole);
  store.markCovered("tick", hole + 1, now / 1e6); await store.flush();
  let fail = true, calls = 0, seq = 0;
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop), nextSeq: () => ++seq,
    metadata: { roll: async () => metadata }, log: noop, now: () => now,
    history: { get: async () => {
      calls++; if (fail) throw new WindowUnavailableError("DUMMY_network");
      return { truncated: false, rows: [{ ts: hole * 1e6, price: 100, size: 5, side: "sell" }] };
    } } });
  await service.run();
  assert.deepEqual((await repo.day("2026-10-28")).gaps, [[hole, hole + 1]]);
  fail = false; await service.run();
  assert.equal((await repo.day("2026-10-28")).complete, true);
  assert.equal(calls, 2);
  assert.equal((await repo.day("2026-10-28")).vp30m[0][3], 5);
  await service.stop();
});
test("ダミー：旧gapsを増やす・場所を変える・既存の出来高を失う再構築は拒否", () => {
  const a = new LongAggregate(), ts = atET("2026-10-28", 10);
  a.add(trade(ts, 400, 5), "NQZ6");
  const old = serializeDay("2026-10-28", a, [metadata], [[ts / 1e6 + 1, ts / 1e6 + 10]], ts);
  assert.equal(improvesDay(old, { ...old, gaps: [] }), true);
  assert.equal(improvesDay(old, { ...old, gaps: [[ts / 1e6, ts / 1e6 + 9]] }), false);
  assert.equal(improvesDay(old, { ...old, vp30m: [] }), false);
});
test("ダミー：休止中に準備しても確定せず、CT17:05後に休止の約定も含める", async t => {
  const { root, repo } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  let now = atET("2026-10-28", 17, 10), seq = 10;
  await store.addTrades([trade(atET("2026-10-28", 16, 55), 400, 2)]);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  const service = new AppLongVp({ repository: repo, store, metrics: new Metrics(noop),
    history: { get: async () => { throw Error("DUMMY: unexpected REST"); } }, metadata: { roll: async () => metadata },
    log: noop, now: () => now, nextSeq: () => ++seq });
  await service.run();
  assert.equal(repo.records.has("2026-10-28"), false);
  now = atET("2026-10-28", 18, 5);
  await store.addTrades([trade(atET("2026-10-28", 17, 55), 401, 3)]);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  await service.run();
  const day = await repo.day("2026-10-28");
  assert.equal(day.complete, true); assert.equal(day.vp30m.reduce((n, r) => n + r[2], 0), 5);
  await service.stop();
});
test("ダミー：確認済みの両限月名と同じ保存履歴でedgeを保存し、再起動で復元", async t => {
  const { root, repo, objects } = await fixture(t), store = new DummyStore(path.join(root, "raw"));
  await store.initialize();
  let now = atET("2026-10-28", 9, 50), seq = 10, current = metadata;
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  const dependencies = { repository: repo, store, metrics: new Metrics(noop), nextSeq: () => ++seq,
    history: { get: async () => { throw Error("DUMMY: unexpected REST"); } }, metadata: { roll: async () => current },
    log: noop, now: () => now };
  const service = new AppLongVp(dependencies);
  await service.run();
  const seam = atET("2026-10-28", 10);
  now = atET("2026-10-28", 10, 10);
  await store.addTrades([trade(seam - 50000, 400, 2), trade(seam + 17000, 425, 3)]);
  store.markCovered("tick", now / 1e6 - 8 * 86400, now / 1e6); await store.flush();
  current = { contract: "NQH7", sinceUs: seam };
  await service.run();
  assert.equal(service.rolls().length, 1); assert.equal(service.rolls()[0].diffTicks, 25);
  assert.equal(service.rolls()[0].detail.gapSeconds, .067);
  const restart = new AppLongVp({ ...dependencies,
    repository: new LongObjects(objects, "dev/", path.join(root, "restart")) });
  await restart.run();
  assert.deepEqual(restart.rolls(), service.rolls());
  await service.stop(); await restart.stop();
});
test("ダミー：APIの無効・未準備・日付・60日上限・日次配列", async t => {
  const { repo } = await fixture(t);
  await repo.save(serializeDay("2026-10-28", new LongAggregate(), [metadata], [], atET("2026-10-28", 18, 5)));
  const app = express();
  app.use("/disabled", longVpRouter(null));
  app.use("/api/longvp", longVpRouter({ repository: repo, today: () => null, rolls: () => [] } as unknown as AppLongVp));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(url + "/disabled/days")).status, 503);
  assert.equal((await fetch(url + "/api/longvp/today")).status, 503);
  assert.equal((await fetch(url + "/api/longvp/days?from=2026-02-30&to=2026-03-03")).status, 400);
  assert.equal((await fetch(url + "/api/longvp/days?from=2026-01-01&to=2026-05-01")).status, 400);
  const response = await fetch(url + "/api/longvp/days?from=2026-10-28&to=2026-10-28");
  assert.equal(response.status, 200); assert.equal((await response.json()).length, 1);
});
