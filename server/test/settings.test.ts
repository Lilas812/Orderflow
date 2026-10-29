import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import { LocalSettings } from "../src/settings/local.ts";
import { defaults, validateBody, validateSettings } from "../src/settings/schema.ts";
import { settingsRouter } from "../src/settings/routes.ts";
import { LocalStore } from "../src/store/local.ts";

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "dummy-settings-"));

test("ダミー：設定5項目の境界、整数、0.1刻み、型、タイムゾーン、欠落と余分な項目", () => {
  for (const values of [
    defaults, { ...defaults, heatTopPct: .1, bubbleMin: 1, bigTopPct: .1, bigMinSec: 1, timeZone: "America/Chicago" },
    { ...defaults, heatTopPct: 10, bubbleMin: 1000, bigTopPct: 20, bigMinSec: 600, timeZone: "Asia/Tokyo" },
    { ...defaults, heatTopPct: 1.3, bigTopPct: 19.9 },
  ]) assert.equal(Object.keys(validateSettings(values)).length, 0);
  for (const [key, bad] of [
    ["heatTopPct", [.09, 10.1, .15, "1", NaN, Infinity, null]],
    ["bubbleMin", [0, 1001, 1.5, "10"]],
    ["bigTopPct", [0, 20.1, .15]],
    ["bigMinSec", [0, 601, 1.5]],
    ["timeZone", ["UTC", "ct", null]],
  ] as const) for (const value of bad) assert.ok(validateSettings({ ...defaults, [key]: value })[key]);
  for (const key of Object.keys(defaults)) {
    const missing = { ...defaults } as Record<string, unknown>; delete missing[key];
    assert.ok(validateSettings(missing)[key]);
  }
  assert.ok(validateBody({ values: defaults, version: 1 }).version);
  assert.ok(validateBody({}).values);
  assert.ok(validateSettings(JSON.parse(JSON.stringify(defaults).replace("}", ',"__proto__":1}'))).__proto__);
});

test("ダミー：GET未保存は初期値、PUT400は原本不変、成功と再起動保持、JSON不正", async () => {
  const dir = await temp(), file = path.join(dir, "settings.json");
  const store = new LocalSettings(file, () => {});
  const app = express(); app.use("/api/settings", settingsRouter(store));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/settings`;
  try {
    const initial = await (await fetch(url)).json();
    assert.deepEqual(initial, { version: 4, values: defaults, updatedAt: null });
    await assert.rejects(fs.access(file));
    const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const saved = await (await put({ values: { ...defaults, bubbleMin: 123 } })).json();
    assert.ok(Number.isSafeInteger(saved.updatedAt));
    const before = await fs.readFile(file);
    for (const body of [{ values: { ...defaults, bubbleMin: 0 } }, { values: {} }, { values: { ...defaults, extra: 1 } }, { values: defaults, extra: 1 }]) {
      const res = await put(body); assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "invalid_settings");
      assert.deepEqual(await fs.readFile(file), before);
    }
    const malformed = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(malformed.status, 400);
    assert.deepEqual((await malformed.json()).fields, { _body: "正しいJSONを送ってください" });
    assert.deepEqual(await new LocalSettings(file, () => {}).get(), saved);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dir, { recursive: true }); }
});

test("ダミー：完成した一時ファイルを置換、置換前失敗は元設定不変", async () => {
  const dir = await temp(), file = path.join(dir, "settings.json");
  try {
    await new LocalSettings(file, () => {}).put({ ...defaults });
    const before = await fs.readFile(file);
    let seen = false;
    const store = new LocalSettings(file, () => {}, async (a, b) => {
      assert.equal(b, file); assert.notEqual(a, b);
      assert.equal(JSON.parse(await fs.readFile(a, "utf8")).values.bubbleMin, 77);
      assert.deepEqual(await fs.readFile(file), before); seen = true;
      throw Error("ダミー置換前失敗");
    });
    await assert.rejects(store.put({ ...defaults, bubbleMin: 77 }), /settings_save_failed/);
    assert.ok(seen); assert.deepEqual(await fs.readFile(file), before);
    assert.equal(store.snapshot().saveError, "settings_save_failed");
    assert.deepEqual(await fs.readdir(dir), ["settings.json"]);
  } finally { await fs.rm(dir, { recursive: true }); }
});

test("ダミー：壊れた原本をバイト不変で退避してから保存、状態とログ、再起動と7日削除対象外", async () => {
  const dir = await temp(), file = path.join(dir, "settings.json");
  const raw = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 13, 10, 123, 0]);
  const events: { event: string; details: any }[] = [];
  try {
    await fs.writeFile(file, raw);
    const store = new LocalSettings(file, (event, details) => events.push({ event, details }));
    assert.deepEqual((await store.get()).values, defaults);
    assert.equal(store.snapshot().readError, "invalid_settings_file");
    assert.deepEqual(await fs.readFile(file), raw);
    const saved = await store.put({ ...defaults, timeZone: "America/Chicago" });
    const backup = (await fs.readdir(dir)).find(n => n.startsWith("settings.corrupt-")); assert.ok(backup);
    assert.deepEqual(await fs.readFile(path.join(dir, backup)), raw);
    assert.ok(events.some(e => e.event === "settings_corrupt_preserved" && e.details.file === `data/${backup}`));
    assert.deepEqual(store.snapshot().preservedFiles, [`data/${backup}`]);
    const restarted = new LocalSettings(file, () => {}); assert.deepEqual(await restarted.get(), saved);
    assert.deepEqual(restarted.snapshot().preservedFiles, [`data/${backup}`]);
    const old = new Date(Date.now() - 30 * 86400000);
    await fs.utimes(file, old, old); await fs.utimes(path.join(dir, backup), old, old);
    const marketStore = new LocalStore(dir);
    await marketStore.initialize(); await marketStore.flush();
    assert.deepEqual(await fs.readFile(path.join(dir, backup)), raw);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), saved);
  } finally { await fs.rm(dir, { recursive: true }); }
});

test("ダミー：同時保存は直列化され最後のPUTが勝つ", async () => {
  const dir = await temp(), file = path.join(dir, "settings.json");
  try {
    const store = new LocalSettings(file, () => {});
    await Promise.all([store.put({ ...defaults, bubbleMin: 12 }), store.put({ ...defaults, bubbleMin: 34 })]);
    assert.equal((await store.get()).values.bubbleMin, 34);
  } finally { await fs.rm(dir, { recursive: true }); }
});
