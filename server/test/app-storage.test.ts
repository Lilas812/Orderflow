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
  uploads: string[] = [];
  async exists(name: string) { return this.files.has(name); }
  async download(name: string, file: string) {
    this.downloads.push(name);
    if (!this.files.has(name)) throw Error("dummy_missing");
    await fs.writeFile(file, this.files.get(name)!);
  }
  async upload(name: string, file: string) {
    this.uploads.push(name);
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

test("ダミー：incremental stats track hydration, verified expiry and empty covered-hour files", async () => {
  const first = await root(), second = await root(), emptyDir = await root();
  const cloud = new DummyObjects();
  let now = (hour + 5) * 1000;
  try {
    const seed = new AppStore(first, cloud, "dev/", log, () => now);
    await seed.initialize(); await seed.addColumns([col(hour + 1)]); await seed.addTrades([tick(hour + 1)]);
    now = (hour + 3605) * 1000; await seed.flush();
    const originalObjects = new Map([...cloud.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
    const store = new AppStore(second, cloud, "dev/", log, () => now);
    await store.initialize();
    assert.equal(store.stats.files, 0);
    assert.equal((await store.readView(hour, hour + 2)).trades.length, 1);
    await store.maintenance(); await store.publicationSettled();
    const hydrated = { files: store.stats.files, bytes: store.stats.bytes };
    await store.refreshStats();
    assert.deepEqual({ files: store.stats.files, bytes: store.stats.bytes }, hydrated);
    assert.equal(hydrated.files, 2);
    now += 49 * 3600 * 1000;
    await store.maintenance(); await store.publicationSettled();
    await store.maintenance(); await store.publicationSettled();
    assert.equal(store.stats.files, 0); assert.equal(store.stats.bytes, 0);
    assert.deepEqual(cloud.files, originalObjects);

    const emptyStore = new AppStore(emptyDir, new DummyObjects(), "dev/", log, () => now);
    await emptyStore.initialize();
    // Known-empty history must still be materialized and published, not skipped.
    const h = hourOf(now / 1000) - 3600;
    emptyStore.markCovered("tick", h, h + 3600);
    await emptyStore.maintenance(); await emptyStore.publicationSettled();
    await emptyStore.maintenance(); await emptyStore.publicationSettled();
    const incremental = { files: emptyStore.stats.files, bytes: emptyStore.stats.bytes };
    await emptyStore.refreshStats();
    assert.deepEqual({ files: emptyStore.stats.files, bytes: emptyStore.stats.bytes }, incremental);
    assert.equal(incremental.files, 1); assert.ok(incremental.bytes > 0);
  } finally { for (const dir of [first, second, emptyDir]) await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー：公開判定はREPLIT_DEPLOYMENTだけ。NODE_ENV本番でもdev、公開はlocal指定を無視", () => {
  assert.deepEqual(storageMode({}), { app: false, prefix: "dev/" });
  assert.deepEqual(storageMode({ NODE_ENV: "production", HEATMAP_STORAGE: "app-storage" }), { app: true, prefix: "dev/" });
  assert.deepEqual(storageMode({ REPLIT_DEPLOYMENT: "1", HEATMAP_STORAGE: "local" }), { app: true, prefix: "prod/" });
});
test("ダミー：停止は失敗し続けても各完了時間を1回だけ。失敗した範囲はクラウドcoverageに入れない", async () => {
  const dir = await root(), cloud = new DummyObjects();
  let now = (hour + 5) * 1000;
  const events: any[] = [];
  try {
    const store = new AppStore(dir, cloud, "dev/", (event, details) => events.push({ event, details }), () => now);
    await store.initialize();
    await store.addColumns([col(hour + 1)]); await store.addTrades([tick(hour + 1)]);
    await store.addColumns([col(hour + 3601)]); await store.addTrades([tick(hour + 3601)]);
    now = (hour + 3605) * 1000;
    cloud.failPrefix = "dev/";
    const budget = new AbortController();
    store.beginShutdown(budget.signal);
    const start = performance.now(); await store.flush();
    assert.ok(performance.now() - start < 1000);
    assert.equal(cloud.uploads.length, 2); assert.equal(new Set(cloud.uploads).size, 2);
    assert.ok(cloud.uploads.every(n => n.includes("/00.")));
    assert.equal(cloud.files.has("dev/coverage.json"), false);
    assert.equal(store.cloudStatus.nextRetryAtUs, null);
    assert.equal(events.some(e => e.event === "app_storage_retry"), false);
    assert.equal(store.shutdownSummary().remaining.filter(f => f.reason === "open_at_signal").length, 2);
    await fs.access(path.join(dir, "columns/NQ/1s/2026-10-28/01.bin"));
    await fs.access(path.join(dir, "trades/NQ/2026-10-28/01.jsonl.gz"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：応答しないアップロードも全体期限で戻り、遅れて成功してもcoverageを追加しない", async () => {
  const dir = await root(), cloud = new DummyObjects();
  let now = (hour + 5) * 1000;
  try {
    const store = new AppStore(dir, cloud, "dev/", log, () => now);
    await store.initialize(); await store.addColumns([col(hour + 1)]);
    const original = cloud.upload.bind(cloud);
    cloud.upload = async (name, file) => {
      const bytes = await fs.readFile(file); cloud.uploads.push(name);
      await new Promise(resolve => setTimeout(resolve, 200));
      cloud.files.set(name, bytes);
    };
    now = (hour + 3605) * 1000;
    const budget = new AbortController(); store.beginShutdown(budget.signal);
    const timer = setTimeout(() => budget.abort(), 50);
    const start = performance.now(); await store.flush(); clearTimeout(timer);
    assert.ok(performance.now() - start < 150);
    assert.equal(cloud.files.has("dev/coverage.json"), false);
    await store.publicationSettled();
    assert.equal(cloud.files.has("dev/coverage.json"), false);
    assert.equal(cloud.uploads.length, 1);
    assert.equal(store.shutdownSummary().remaining[0].reason, "deadline");
    cloud.upload = original;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：確認済みキャッシュの再起動では再アップロードしない。変更した同サイズの内容は再送する", async () => {
  const dir = await root(), cloud = new DummyObjects();
  let now = (hour + 5) * 1000;
  try {
    const one = new AppStore(dir, cloud, "dev/", log, () => now);
    await one.initialize(); await one.addColumns([col(hour + 1)]); await one.addTrades([tick(hour + 1)]);
    now = (hour + 3605) * 1000; await one.flush(); cloud.uploads = [];
    const two = new AppStore(dir, cloud, "dev/", log, () => now);
    await two.initialize(); const budget = new AbortController(); two.beginShutdown(budget.signal); await two.flush();
    assert.equal(cloud.uploads.length, 0);
    assert.equal(cloud.downloads.filter(n => n.endsWith(".gz")).length >= 4, true);
    // Valid gzip, but different content: filename/coverage alone is not confirmation.
    const file = path.join(dir, "trades/NQ/2026-10-28/00.jsonl.gz");
    const { gzipSync } = await import("node:zlib");
    await fs.writeFile(file, gzipSync(JSON.stringify({ ...tick(hour + 1), size: 3 }) + "\n"));
    const three = new AppStore(dir, cloud, "dev/", log, () => now);
    await three.initialize(); three.beginShutdown(new AbortController().signal); await three.flush();
    assert.equal(cloud.uploads.filter(n => n.includes("/00.jsonl.gz")).length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：SIGTERM時の書きかけは停止処理中にUTC境界を越えても上げない", async () => {
  const dir = await root(), cloud = new DummyObjects(); let now = (hour + 3599) * 1000;
  try {
    const store = new AppStore(dir, cloud, "dev/", log, () => now);
    await store.initialize(); await store.addColumns([col(hour + 1)]); await store.addTrades([tick(hour + 1)]);
    store.beginShutdown(new AbortController().signal); now = (hour + 3601) * 1000;
    await store.flush();
    assert.equal(cloud.uploads.length, 0);
    assert.equal(store.shutdownSummary().remaining.filter(f => f.reason === "open_at_signal").length, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：通常運転のアップロード途中にSIGTERMが来ても同じファイルを二度試さない", async () => {
  const dir = await root(), cloud = new DummyObjects(); let now = (hour + 5) * 1000;
  try {
    const store = new AppStore(dir, cloud, "dev/", log, () => now);
    await store.initialize(); await store.addColumns([col(hour + 1)]);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    cloud.upload = async name => {
      cloud.uploads.push(name); entered();
      await new Promise(resolve => setTimeout(resolve, 80)); throw Error("dummy_failure");
    };
    now = (hour + 3601) * 1000;
    await store.maintenance(); await started;
    store.beginShutdown(new AbortController().signal); await store.flush();
    assert.equal(cloud.uploads.length, 1);
    assert.equal(cloud.files.has("dev/coverage.json"), false);
    assert.equal(store.cloudStatus.nextRetryAtUs, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("ダミー：同じ時間内の停止・再起動は前半を保持し、書きかけをクラウドへ上書きしない", async () => {
  const dir = await root(), fresh = await root(), cloud = new DummyObjects();
  let now = (hour + 5) * 1000;
  try {
    const one = new AppStore(dir, cloud, "dev/", log, () => now);
    await one.initialize(); await one.addColumns([col(hour + 1)]); await one.addTrades([tick(hour + 1)]);
    one.beginShutdown(new AbortController().signal); await one.flush();
    assert.equal(cloud.uploads.length, 0);
    const two = new AppStore(dir, cloud, "dev/", log, () => now);
    await two.initialize(); await two.addColumns([col(hour + 3)]); await two.addTrades([{ ...tick(hour + 3), seq: 2 }]);
    assert.deepEqual((await two.readView(hour, hour + 5)).columns.map(c => c.tsSec), [hour + 1, hour + 3]);
    assert.equal((await two.readTrades(hour, hour + 5)).length, 2);
    two.beginShutdown(new AbortController().signal); await two.flush(); assert.equal(cloud.uploads.length, 0);
    // A wiped disk has no remote current-hour coverage. Backfill must restore
    // the first half before the completed hour may become durable.
    const three = new AppStore(fresh, cloud, "dev/", log, () => now);
    await three.initialize(); assert.equal(three.covered("tick", hour + 1), false);
    await three.addColumns([col(hour + 3)]); await three.addTrades([{ ...tick(hour + 3), seq: 2 }]);
    await three.addColumns([col(hour + 1)]);
    await three.replaceTradeRange(hour + 1, hour + 2, [tick(hour + 1)]);
    await three.flush(); assert.equal(cloud.uploads.length, 0);
    now = (hour + 3605) * 1000; await three.flush();
    const four = new AppStore(await root(), cloud, "dev/", log, () => now);
    try {
      await four.initialize();
      const view = await four.readView(hour, hour + 5);
      assert.deepEqual(view.columns.map(c => c.tsSec), [hour + 1, hour + 3]);
      assert.equal(view.trades.length, 2);
    } finally { await fs.rm(four.root, { recursive: true, force: true }); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(fresh, { recursive: true, force: true }); }
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
test("ダミー：公開prod/のversion2設定はGETで退避・書換せず、次の保存だけv3", async () => {
  const dir = await root(), cloud = new DummyObjects(), events: string[] = [];
  const keys = ["heatTopPct", "bubbleMin", "bigTopPct", "bigMinSec", "timeZone", "bubbleScale", "bookBarPct", "bookBarOpacity"];
  const original = Buffer.from(JSON.stringify({ version: 2, updatedAt: 1000000,
    values: { ...Object.fromEntries(keys.map(k => [k, defaults[k as keyof typeof defaults]])), bubbleScale: 2 } }) + "\r\n");
  cloud.files.set("prod/settings.json", original);
  try {
    const app = new AppSettings(path.join(dir, "settings.json"), cloud, "prod/", event => events.push(event));
    const doc = await app.get();
    assert.equal(doc.version, 4); assert.equal(doc.values.bubbleScale, 2);
    assert.equal(doc.values.heatUpperSize, 100); assert.equal(doc.updatedAt, 1000000);
    assert.deepEqual(cloud.files.get("prod/settings.json"), original);
    assert.equal(app.snapshot().readError, null);
    assert.deepEqual(app.snapshot().preservedFiles, []);
    assert.equal(cloud.uploads.length, 0);
    await app.put({ ...doc.values, heatUpperMode: "size", heatUpperSize: 42, heatLowerSize: 88 });
    const saved = JSON.parse(cloud.files.get("prod/settings.json")!.toString());
    assert.equal(saved.version, 4); assert.equal(saved.values.heatUpperSize, 42); assert.equal(saved.values.heatLowerSize, 88);
    assert.ok(!events.includes("settings_corrupt_preserved"));
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
