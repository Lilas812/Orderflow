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
import { Metrics } from "../src/ingest/metrics.ts";
import { readTradeRange } from "../src/vp/trade-history.ts";
import { WindowUnavailableError } from "../src/history/client.ts";
import { longVpRouter } from "../src/long-vp/routes.ts";
import type { Trade } from "../src/types.ts";

const noop = () => {};
class DummyStore extends LocalStore { protected override async retention() {} }
const metadata = { contract: "NQZ6", sinceUs: Date.parse("2026-09-14T07:46:50Z") * 1000 };
function trade(us: number, price = 400, size = 2, side: "buy" | "sell" = "buy", seq = 1): Trade {
  return { tsUs: us, recvUs: us, price, size, side, seq };
}
class DummyObjects implements Objects {
  files = new Map<string, Buffer>();
  downloads = 0; uploads: string[] = [];
  corrupt = false;
  async exists(name: string) { return this.files.has(name); }
  async list(prefix: string) { return [...this.files.keys()].filter(n => n.startsWith(prefix)); }
  async download(name: string, file: string) {
    this.downloads++;
    if (!this.files.has(name)) throw Error("dummy_missing");
    await fs.writeFile(file, this.corrupt ? Buffer.from("DUMMY: corrupt") : this.files.get(name)!);
  }
  async upload(name: string, file: string) { this.files.set(name, await fs.readFile(file)); this.uploads.push(name); }
}
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-longvp-app-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const objects = new DummyObjects(), repo = new LongObjects(objects, "dev/", path.join(root, "tmp"));
  return { root, objects, repo };
}
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
