import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AppStore } from "../src/store/app.ts";
import { LocalStore, ranges } from "../src/store/local.ts";
import type { Coverage, Range } from "../src/store/local.ts";
import { compactTickGaps, coveredHours, durableHours, containsSecond, clipRanges } from "../src/store/coverage.ts";
import { MainThreadMonitor } from "../src/diagnostics/main-thread.ts";

class DummyObjects {
  files = new Map<string, Buffer>(); uploads: string[] = []; downloads: string[] = [];
  failBackup = false;
  async exists(name: string) { return this.files.has(name); }
  async list(prefix: string) { return [...this.files.keys()].filter(n => n.startsWith(prefix)); }
  async download(name: string, file: string) {
    this.downloads.push(name);
    if (!this.files.has(name)) throw Error("dummy_missing");
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, this.files.get(name)!);
  }
  async upload(name: string, file: string) {
    this.uploads.push(name);
    if (this.failBackup && name.includes("/backup/")) throw Error("dummy_backup_failed");
    this.files.set(name, await fs.readFile(file));
  }
}
const root = () => fs.mkdtemp(path.join(os.tmpdir(), "dummy-coverage-publish-"));
const hour = Date.UTC(2026, 10, 2) / 1000;
const column = (sec: number, source: "live" | "history" = "live") =>
  ({ tsSec: sec, source, bids: [{ price: 100, size: 1 }], asks: [{ price: 101, size: 2 }] });

test("ダミー：hour Set・二分探索は旧全走査と一致し、1時間を何度も列挙しない", async () => {
  const tick = ranges(Array.from({ length: 30000 }, (_, i): Range => [i * 4, i * 4 + 1]));
  const index: Coverage = { book: [[0, 150000]], tick };
  const cache = await durableHours(index);
  const oldHours = new Set<number>();
  for (const [a, b] of tick) for (let h = Math.floor(a / 3600) * 3600; h < b; h += 3600) oldHours.add(h);
  assert.deepEqual([...coveredHours(tick)], [...oldHours]); assert.deepEqual(cache.tick, oldHours);
  for (let sec = 0; sec < 150000; sec += 197) {
    assert.equal(containsSecond(tick, sec), tick.some(([a, b]) => a <= sec && sec < b));
    assert.deepEqual(clipRanges(tick, sec, sec + 3600), tick.filter(([a, b]) => a < sec + 3600 && b > sec)
      .map(([a, b]) => [Math.max(a, sec), Math.min(b, sec + 3600)]));
  }
});
test("ダミー：30秒以下・全book証拠・同銘柄・durable時間だけを圧縮、端は伸ばさない", async () => {
  const input: Coverage = { book: [[0, 40], [45, 100]], tick: [[1, 2], [32, 33], [64, 65], [70, 71]] };
  const original = structuredClone(input);
  assert.deepEqual((await compactTickGaps(input)).tick, [[1, 33], [64, 71]]);
  assert.deepEqual((await compactTickGaps(input, new Set())).tick, input.tick);
  assert.deepEqual(input, original);
  const crossing: Coverage = { book: [[3590, 3620]], tick: [[3590, 3595], [3605, 3620]] };
  assert.deepEqual((await compactTickGaps(crossing, new Set([0]))).tick, crossing.tick);
  assert.deepEqual((await compactTickGaps(crossing, new Set([0, 3600]))).tick, [[3590, 3620]]);
  assert.deepEqual((await compactTickGaps({ book: [], tick: crossing.tick })).tick, crossing.tick);
});
for (const symbol of ["NQ", "GC"] as const) test(`ダミー：${symbol} liveの静かな秒はデータ時刻+3秒のみで取得済み、history/板なしは不可`, async () => {
  const dir = await root(), store = new LocalStore(dir, () => (hour + 1000) * 1000, undefined, symbol);
  try {
    await store.initialize();
    await store.addColumns([column(hour), column(hour + 1), column(hour + 2, "history")]);
    await store.confirmLiveTradeSeconds((hour + 2.999999) * 1e6); await store.maintenance();
    assert.deepEqual(await store.recordedTickCoverage(), []);
    await store.confirmLiveTradeSeconds((hour + 3) * 1e6); await store.maintenance();
    assert.deepEqual(await store.recordedTickCoverage(), [[hour, hour + 1]]);
    await store.confirmLiveTradeSeconds((hour + 10) * 1e6); await store.maintenance();
    assert.deepEqual(await store.recordedTickCoverage(), [[hour, hour + 2]]);
    assert.equal(store.covered("tick", hour + 2), false); assert.equal(store.covered("tick", hour + 3), false);
    await store.addTrades([{ tsUs: (hour + 3) * 1e6, recvUs: 1, price: 100, size: 1, side: "buy", seq: 1 }]);
    await store.maintenance();
    assert.equal(store.covered("tick", hour + 3), true);
    // A late older book time cannot advance or roll back completeness.
    await store.confirmLiveTradeSeconds(hour * 1e6); await store.maintenance();
    assert.equal(store.covered("tick", hour + 2), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
for (const symbol of ["NQ", "GC"] as const) test(`ダミー：${symbol} startupは原本退避・再DL確認後だけ圧縮し、再起動で再適用しない`, async () => {
  const dir = await root(), objects = new DummyObjects(), prefix = symbol === "NQ" ? "dev/" : "dev/instruments/GC/";
  const original = Buffer.from(JSON.stringify({ book: [[hour, hour + 100]], tick: [[hour, hour + 1], [hour + 31, hour + 32]] }, null, 2));
  objects.files.set(prefix + "coverage.json", original);
  try {
    const initial = new LocalStore(dir, () => (hour + 3601) * 1000, undefined, symbol);
    await initial.initialize();
    await initial.addColumns([column(hour, "history"), column(hour + 31, "history")]);
    await initial.addTrades([hour, hour + 31].map((sec, seq) => ({
      tsUs: sec * 1e6, recvUs: 1, price: 100, size: 1, side: "buy" as const, seq,
    })));
    initial.markCovered("book", hour, hour + 100); await initial.flush();
    const localOriginal = await fs.readFile(path.join(dir, "coverage.json"));
    const marketFiles = [`columns/${symbol}/1s/2026-11-02/00.bin.gz`, `trades/${symbol}/2026-11-02/00.jsonl.gz`];
    const marketBytes = await Promise.all(marketFiles.map(f => fs.readFile(path.join(dir, f))));
    for (let i = 0; i < marketFiles.length; i++) objects.files.set(prefix + marketFiles[i], marketBytes[i]);
    const store = new AppStore(dir, objects, prefix, () => {}, () => (hour + 3601) * 1000, symbol);
    await store.initialize();
    assert.deepEqual((await store.recordedTickCoverage()), [[hour, hour + 32]]);
    const backups = store.cloudStatus.coverageCompaction.backups;
    assert.equal(backups.length, 2);
    for (const backup of backups) {
      assert.match(backup, /^dev\/backup\/coverage\//);
      assert.deepEqual(objects.files.get(backup), backup.endsWith("/cloud/coverage.json") ? original : localOriginal);
      assert.ok(objects.downloads.includes(backup));
    }
    for (let i = 0; i < marketFiles.length; i++)
      assert.deepEqual(await fs.readFile(path.join(dir, marketFiles[i])), marketBytes[i]);
    const oldReader = new LocalStore(dir, () => (hour + 3601) * 1000, undefined, symbol);
    await oldReader.initialize(); assert.equal(oldReader.covered("tick", hour + 20), true);
    const before = objects.uploads.length;
    const next = new AppStore(dir, objects, prefix, () => {}, () => (hour + 3601) * 1000, symbol);
    await next.initialize(); assert.equal(objects.uploads.length, before);
    assert.equal(next.cloudStatus.coverageCompaction.state, "already_applied");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：backup失敗なら印も圧縮も入れず起動継続、原cloud不変", async () => {
  const dir = await root(), objects = new DummyObjects();
  const original = Buffer.from('{"book":[[0,100]],"tick":[[0,1],[20,21]]}');
  objects.files.set("dev/coverage.json", original); objects.failBackup = true;
  try {
    const store = new AppStore(dir, objects, "dev/", () => {}, () => 3700 * 1000);
    await store.initialize();
    assert.deepEqual(objects.files.get("dev/coverage.json"), original);
    assert.deepEqual(await store.recordedTickCoverage(), [[0, 1], [20, 21]]);
    assert.equal(store.cloudStatus.coverageCompaction.state, "backup_failed");
    assert.equal(store.coverageIntervals.tickGapCompactionVersion, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：空の補完ではhydrate/市場ファイル再読込/置換なし、区間だけ更新", async () => {
  const dir = await root(), objects = new DummyObjects();
  objects.files.set("dev/coverage.json", Buffer.from(JSON.stringify({
    book: [], tick: [[hour, hour + 1]], tickGapCompactionVersion: 1 })));
  try {
    const store = new AppStore(dir, objects, "dev/", () => {}, () => (hour + 5) * 1000);
    await store.initialize(); objects.downloads = [];
    await store.insertUncoveredTradeRange(hour + 1, hour + 20, []);
    assert.deepEqual(objects.downloads, []);
    assert.deepEqual(await store.recordedTickCoverage(), [[hour, hour + 20]]);
    await assert.rejects(fs.access(path.join(dir, "trades/NQ/2026-11-02/00.jsonl.gz")));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：idle publishは停止、coverage変更・時刻境界・明示flushでは再開", async () => {
  const dir = await root(), objects = new DummyObjects(); let now = (hour + 5) * 1000;
  try {
    const store = new AppStore(dir, objects, "dev/", () => {}, () => now); await store.initialize();
    for (let i = 0; i < 3; i++) { await store.maintenance(); await store.publicationSettled(); }
    const n = store.publicationStats.count;
    for (let i = 0; i < 10; i++) { await store.maintenance(); await store.publicationSettled(); }
    assert.equal(store.publicationStats.count, n);
    store.markCovered("tick", hour, hour + 2);
    await store.maintenance(); await store.publicationSettled();
    assert.equal(store.publicationStats.count, n + 1);
    now += 3600 * 1000; await store.maintenance(); await store.publicationSettled();
    assert.ok(objects.files.has("dev/trades/NQ/2026-11-02/00.jsonl.gz"));
    const previous = store.publicationStats.count; await store.flush();
    assert.equal(store.publicationStats.count, previous + 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：async_hooksを使わなくてもCPU/GC/停止timerを維持", () => {
  const m = new MainThreadMonitor(() => {}, () => {}, false); m.start();
  try { assert.equal(m.snapshot().asyncHooksEnabled, false); assert.equal(m.snapshot().trackedResources, 0);
    assert.ok(m.snapshot().heap); assert.ok(m.snapshot().gc); }
  finally { m.stop(); }
});
test("ダミー：確定済みgzipが同じでも後から成熟した静かな秒をcloudへ反映、本体は再送しない", async () => {
  const dir = await root(), objects = new DummyObjects(); let now = (hour + 3601) * 1000;
  try {
    const store = new AppStore(dir, objects, "dev/", () => {}, () => now); await store.initialize();
    await store.addColumns([column(hour + 3597), column(hour + 3598), column(hour + 3599)]);
    await store.addTrades([{ tsUs: (hour + 3597) * 1e6, recvUs: 1, price: 100, size: 1, side: "buy", seq: 1 }]);
    await store.confirmLiveTradeSeconds((hour + 3600) * 1e6); await store.flush();
    const name = "dev/trades/NQ/2026-11-02/00.jsonl.gz", original = objects.files.get(name);
    const uploaded = objects.uploads.filter(n => n === name).length;
    assert.deepEqual(JSON.parse(objects.files.get("dev/coverage.json")!.toString()).tick, [[hour + 3597, hour + 3598]]);
    now += 2000; await store.confirmLiveTradeSeconds((hour + 3602) * 1e6);
    await store.flush();
    assert.deepEqual(JSON.parse(objects.files.get("dev/coverage.json")!.toString()).tick, [[hour + 3597, hour + 3600]]);
    assert.deepEqual(objects.files.get(name), original);
    assert.equal(objects.uploads.filter(n => n === name).length, uploaded);
    assert.equal(store.cloudStatus.coverageOnlyUploads, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
