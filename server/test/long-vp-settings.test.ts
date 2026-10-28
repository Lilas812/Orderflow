import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { LongVpSettings, longVpSettingsRouter } from "../src/settings/longvp.ts";
import { defaults, validateSettings } from "../../artifacts/heatmap/src/long-vp/settings-schema.ts";
import type { Objects } from "../src/store/objects.ts";

class DummyObjects implements Objects {
  data = new Map<string, Buffer>();
  failUpload = false;
  corruptDownload = false;
  async exists(n: string) { return this.data.has(n); }
  async list(p: string) { return [...this.data.keys()].filter(n => n.startsWith(p)); }
  async download(n: string, file: string) {
    const bytes = this.data.get(n); if (!bytes) throw Error("missing_dummy");
    await fs.writeFile(file, this.corruptDownload && file.endsWith(".verify") ? Buffer.from("ダミー破損") : bytes);
  }
  async upload(n: string, file: string) {
    if (this.failUpload) throw Error("dummy_upload_failed");
    this.data.set(n, await fs.readFile(file));
  }
}
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "dummy-longvp-settings-"));

test("ダミー: 専用設定は全項目・型・範囲を検査する", () => {
  assert.deepEqual(Object.keys(validateSettings(defaults)), []);
  for (const [key, value] of Object.entries(defaults)) {
    const missing: Record<string, unknown> = { ...defaults }; delete missing[key];
    assert.ok(validateSettings(missing)[key], key);
    assert.ok(validateSettings({ ...defaults, [key]: typeof value === "boolean" ? "true" : null })[key], key);
  }
  for (const v of [0, 41, 1.5]) assert.ok(validateSettings({ ...defaults, vpTickGroup: v }).vpTickGroup);
  for (const v of [9, 81, 40.5]) assert.ok(validateSettings({ ...defaults, vpWidthPct: v }).vpWidthPct);
  assert.ok(validateSettings({ ...defaults, extra: true }).extra);
});

test("ダミー: ローカル保存・別端末再読込・既存設定不変・破損原本退避", async () => {
  const dir = await temp(), file = path.join(dir, "settings-longvp.json");
  try {
    const legacy = Buffer.from('{"version":2,"unchanged":"ダミー"}\n');
    await fs.writeFile(path.join(dir, "settings.json"), legacy);
    const store = new LongVpSettings(file, () => {});
    assert.deepEqual(await store.get(), { version: 1, values: defaults, updatedAt: null });
    const saved = await store.put({ ...defaults, vpWidthPct: 60 });
    assert.equal(saved.version, 1);
    assert.equal((await new LongVpSettings(file, () => {}).get()).values.vpWidthPct, 60);
    assert.deepEqual(await fs.readFile(path.join(dir, "settings.json")), legacy);
    const raw = Buffer.from([0xff, 0, 123, 13, 10]);
    await fs.writeFile(file, raw);
    assert.deepEqual((await store.get()).values, defaults);
    assert.equal(store.snapshot().readError, "invalid_settings_file");
    await store.put({ ...defaults });
    const backup = (await fs.readdir(dir)).find(n => /^settings-longvp\.corrupt-\d+\.json$/.test(n));
    assert.ok(backup);
    assert.deepEqual(await fs.readFile(path.join(dir, backup)), raw);
    assert.equal(store.snapshot().readError, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: App Storage専用prefix・再DL照合・壊れた原本退避・失敗を隠さない", async () => {
  const dir = await temp(), cloud = new DummyObjects(), file = path.join(dir, "settings-longvp.json");
  const legacy = Buffer.from("既存設定ダミー"); cloud.data.set("dev/settings.json", legacy);
  try {
    const store = new LongVpSettings(file, () => {}, { objects: cloud, prefix: "dev/" });
    await store.put({ ...defaults, rthOnly: true });
    assert.deepEqual(cloud.data.get("dev/settings.json"), legacy);
    assert.equal((await new LongVpSettings(path.join(dir, "other.json"), () => {},
      { objects: cloud, prefix: "dev/" }).get()).values.rthOnly, true);
    const raw = Buffer.from("壊れた長期VP設定ダミー");
    cloud.data.set("dev/settings-longvp.json", raw);
    await store.put({ ...defaults });
    const backup = [...cloud.data.keys()].find(n => n.startsWith("dev/settings-longvp.corrupt-"));
    assert.ok(backup); assert.deepEqual(cloud.data.get(backup), raw);
    cloud.failUpload = true;
    await assert.rejects(store.put({ ...defaults, vpWidthPct: 70 }), /settings_save_failed/);
    assert.equal(store.snapshot().saveError, "settings_save_failed");
    cloud.failUpload = false; cloud.corruptDownload = true;
    await assert.rejects(store.put({ ...defaults }), /settings_save_failed/);
    assert.ok([...cloud.data.keys()].every(n => n.startsWith("dev/")));
    assert.ok(!(await fs.readdir(dir)).some(n => n.endsWith(".tmp") || n.endsWith(".verify")));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: HTTP GET/PUT・400原本不変・JSON不正・再読込", async () => {
  const dir = await temp(), file = path.join(dir, "settings-longvp.json");
  const store = new LongVpSettings(file, () => {}), app = express();
  app.use("/api/settings/longvp", longVpSettingsRouter(store));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/settings/longvp`;
  const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(url)).json()).version, 1);
    assert.equal((await put({ values: { ...defaults, showWeeklyCvd: false } })).status, 200);
    const before = await fs.readFile(file);
    for (const body of [{}, { values: {} }, { values: { ...defaults, vpTickGroup: 0 } },
      { values: defaults, version: 1 }, { values: { ...defaults, extra: true } }]) {
      assert.equal((await put(body)).status, 400);
      assert.deepEqual(await fs.readFile(file), before);
    }
    assert.equal((await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
    assert.equal((await (await fetch(url)).json()).values.showWeeklyCvd, false);
    assert.equal((await fetch(url)).headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ダミー: 破損原本のクラウド退避失敗は上書きを中止する", async () => {
  const dir = await temp(), cloud = new DummyObjects(), raw = Buffer.from("ダミー破損原本");
  cloud.data.set("dev/settings-longvp.json", raw); cloud.failUpload = true;
  try {
    const store = new LongVpSettings(path.join(dir, "settings-longvp.json"), () => {}, { objects: cloud, prefix: "dev/" });
    await assert.rejects(store.put({ ...defaults }), /settings_save_failed/);
    assert.deepEqual(cloud.data.get("dev/settings-longvp.json"), raw);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: クラウド読取失敗はHTTP500で初期値成功に見せない", async () => {
  const dir = await temp(), cloud = new DummyObjects();
  cloud.exists = async () => { throw Error("dummy_read_failure"); };
  const store = new LongVpSettings(path.join(dir, "settings-longvp.json"), () => {}, { objects: cloud, prefix: "dev/" });
  const app = express(); app.use("/api/settings/longvp", longVpSettingsRouter(store));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/settings/longvp`);
    assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: "settings_read_failed" });
    assert.equal(store.snapshot().readError, "settings_read_failed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
