import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AppStore } from "../src/store/app.ts";
import { AppSettings } from "../src/settings/app.ts";
import { defaults } from "../src/settings/schema.ts";
import { storageMode } from "../src/store/objects.ts";
import type { Objects } from "../src/store/objects.ts";
import { hourOf } from "../src/store/local.ts";
import type { Column } from "../src/aggregate/columns.ts";
import type { Trade } from "../src/types.ts";

/** ダミー：SDK/network is never used by these tests. */
class DummyObjects implements Objects {
  files = new Map<string, Buffer>();
  fail: string | null = null;
  failPrefix: string | null = null;
  downloads: string[] = [];
  async exists(name: string) { return this.files.has(name); }
  async download(name: string, file: string) {
    this.downloads.push(name);
    if (!this.files.has(name)) throw Error("dummy_missing");
    await fs.writeFile(file, this.files.get(name)!);
  }
  async upload(name: string, file: string) {
    if (name === this.fail || this.failPrefix && name.startsWith(this.failPrefix)) throw Error("dummy_upload_failure");
    this.files.set(name, await fs.readFile(file));
  }
  async list(prefix: string) { return [...this.files.keys()].filter(k => k.startsWith(prefix)); }
}
const log = () => {};
const col = (sec: number): Column => ({ tsSec: sec, source: "live",
  bids: [{ price: 100, size: 2 }], asks: [{ price: 101, size: 3 }] });
const tick = (sec: number): Trade => ({ tsUs: sec * 1e6, recvUs: sec * 1e6, price: 100, size: 2, side: "buy", seq: 1 });
const root = () => fs.mkdtemp(path.join(os.tmpdir(), "dummy-app-storage-"));
const hour = hourOf(Date.UTC(2026, 9, 28) / 1000);

test("ダミー：公開判定はREPLIT_DEPLOYMENTだけ。NODE_ENV本番でもdev、公開はlocal指定を無視", () => {
  assert.deepEqual(storageMode({}), { app: false, prefix: "dev/" });
  assert.deepEqual(storageMode({ NODE_ENV: "production", HEATMAP_STORAGE: "app-storage" }), { app: true, prefix: "dev/" });
  assert.deepEqual(storageMode({ REPLIT_DEPLOYMENT: "1", HEATMAP_STORAGE: "local" }), { app: true, prefix: "prod/" });
});
test("ダミー：書きかけは上げず、UTC境界後にgzip・再DL照合・該当kindだけcoverage。失敗は保持して60秒後再試行", async () => {
  const dir = await root(), cloud = new DummyObjects(); let now = (hour + 5) * 1000;
  const store = new AppStore(dir, cloud, "dev/", log, () => now);
  try {
    await store.initialize(); await store.addColumns([col(hour + 1)]); await store.addTrades([tick(hour + 1)]);
    await store.flush(); assert.equal(cloud.files.size, 0);
    now = (hour + 3601) * 1000;
    const name = "dev/columns/NQ/1s/2026-10-28/00.bin.gz";
    cloud.fail = name; await store.flush();
    let index = JSON.parse(cloud.files.get("dev/coverage.json")!.toString());
    assert.deepEqual(index.book, []); assert.deepEqual(index.tick, [[hour + 1, hour + 2]]);
    await fs.access(path.join(dir, "columns/NQ/1s/2026-10-28/00.bin.gz"));
    assert.equal(store.cloudStatus.nextRetryAtUs, (now + 60000) * 1000);
    cloud.fail = null; await store.flush(); assert.equal(cloud.files.has(name), false);
    now += 60000; await store.flush();
    index = JSON.parse(cloud.files.get("dev/coverage.json")!.toString());
    assert.deepEqual(index.book, [[hour + 1, hour + 2]]);
    assert.ok(cloud.downloads.includes(name));
    assert.deepEqual((await store.readView(hour, hour + 3)).columns, [col(hour + 1)]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：再デプロイで書きかけが消えるとcoverageにもなく、履歴対象へ戻る", async () => {
  const a = await root(), b = await root(), cloud = new DummyObjects();
  try {
    const one = new AppStore(a, cloud, "dev/", log, () => (hour + 5) * 1000);
    await one.initialize(); await one.addColumns([col(hour + 1)]); await one.addTrades([tick(hour + 1)]); await one.flush();
    const two = new AppStore(b, cloud, "dev/", log, () => (hour + 10) * 1000);
    await two.initialize();
    assert.equal(two.covered("book", hour + 1), false); assert.equal(two.covered("tick", hour + 1), false);
    assert.deepEqual(await two.recordedTickCoverage(), []);
    // A dangling local working index must not assert coverage without the file.
    await fs.writeFile(path.join(b, "coverage.json"), JSON.stringify({ book: [[hour, hour + 2]], tick: [] }));
    const three = new AppStore(b, cloud, "dev/", log, () => (hour + 10) * 1000);
    await three.initialize(); assert.equal(three.covered("book", hour + 1), false);
  } finally { await fs.rm(a, { recursive: true, force: true }); await fs.rm(b, { recursive: true, force: true }); }
});
test("ダミー：48時間外はディスク一時ファイルをストリームで読み、応答成功・失敗後に除去。prodの7日削除なし", async () => {
  const dir = await root(), fresh = await root(), cloud = new DummyObjects(); let now = (hour + 3601) * 1000;
  try {
    const one = new AppStore(dir, cloud, "prod/", log, () => now);
    await one.initialize(); await one.addColumns([col(hour + 1)]); await one.addTrades([tick(hour + 1)]); await one.flush();
    now += 9 * 86400000;
    const two = new AppStore(fresh, cloud, "prod/", log, () => now);
    await two.initialize();
    assert.equal(two.covered("book", hour + 1), true);
    assert.equal(two.savedRange!.fromSec, hour + 1);
    const rows = await two.readView(hour, hour + 3);
    assert.deepEqual(rows.columns, [col(hour + 1)]); assert.deepEqual(rows.trades, [tick(hour + 1)]);
    assert.deepEqual(await fs.readdir(path.join(fresh, ".read-temporary")), []);
    await two.flush(); assert.ok(cloud.files.has("prod/trades/NQ/2026-10-28/00.jsonl.gz"));
    await assert.rejects(two.visitTrades(hour, hour + 3, () => { throw Error("dummy_consumer"); }));
    assert.deepEqual(await fs.readdir(path.join(fresh, ".read-temporary")), []);
    assert.ok(cloud.files.has("prod/columns/NQ/1s/2026-10-28/00.bin.gz"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(fresh, { recursive: true, force: true }); }
});
test("ダミー：App Storage設定保存・別端末読込、破損原本の不変退避が成功するまで置換しない", async () => {
  const dir = await root(), cloud = new DummyObjects(), file = path.join(dir, "settings.json");
  try {
    const app = new AppSettings(file, cloud, "dev/", log);
    assert.equal((await app.get()).updatedAt, null);
    await app.put({ ...defaults, bubbleScale: 2 });
    const other = new AppSettings(path.join(dir, "other.json"), cloud, "dev/", log);
    assert.equal((await other.get()).values.bubbleScale, 2);
    const corrupt = Buffer.from("壊れた\r\n原本");
    cloud.files.set("dev/settings.json", corrupt);
    await app.get(); assert.equal(app.snapshot().readError, "invalid_settings_file");
    cloud.failPrefix = "dev/settings.corrupt-";
    await assert.rejects(app.put(defaults), /settings_save_failed/);
    assert.deepEqual(cloud.files.get("dev/settings.json"), corrupt);
    assert.equal(app.snapshot().preservedFiles.length, 0);
    cloud.failPrefix = null;
    await app.put(defaults);
    const backup = app.snapshot().preservedFiles[0]; assert.ok(backup.startsWith("dev/settings.corrupt-"));
    assert.deepEqual(cloud.files.get(backup), corrupt);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：47時間のファイルは保持、49時間のアップロード確認済みファイルだけキャッシュから除く", async () => {
  const dir = await root(), cloud = new DummyObjects(); let now = (hour + 3601) * 1000;
  const store = new AppStore(dir, cloud, "prod/", log, () => now);
  const file = path.join(dir, "columns/NQ/1s/2026-10-28/00.bin.gz");
  try {
    await store.initialize(); await store.addColumns([col(hour + 1)]); await store.flush();
    now = (hour + 47 * 3600) * 1000; await store.flush(); await fs.access(file);
    now = (hour + 49 * 3600) * 1000; await store.flush();
    await assert.rejects(fs.access(file));
    assert.ok(cloud.files.has("prod/columns/NQ/1s/2026-10-28/00.bin.gz"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
