import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fetchSettingsFile } from "../src/settings/fetch-file.ts";
import { LocalSettings } from "../src/settings/local.ts";
import { settingsRouter } from "../src/settings/routes.ts";
import type { Objects } from "../src/store/objects.ts";

test("ダミー: 独立listを重ね、失敗時も全I/O終了までstaging所有権を解放しない", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-read-"));
  const events: string[] = [];
  let downloaded = false;
  const objects: Objects = {
    exists: async () => { events.push("exists"); await delay(5); return true; },
    download: async (_n, f) => { events.push("download"); await delay(30); await fs.writeFile(f, "original"); downloaded = true; },
    list: () => { events.push("list"); throw Error("dummy_list_failure"); },
    upload: async () => { assert.fail("GET must not upload"); },
  };
  try {
    await assert.rejects(fetchSettingsFile(objects, "dummy/", "settings", path.join(dir, "settings.json")), /dummy_list_failure/);
    assert.equal(downloaded, true);
    assert.ok(events.indexOf("list") < events.indexOf("download"));
    assert.equal(await fs.readFile(path.join(dir, "settings.json"), "utf8"), "original");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: ローカルI/O失敗は初期値200にせず500、GETで保存しない", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settings-io-"));
  const file = path.join(dir, "settings.json");
  await fs.mkdir(file); // readFile(EISDIR), not ENOENT or invalid JSON.
  const store = new LocalSettings(file, () => {});
  const app = express(); app.use("/api/settings", settingsRouter(store));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}/api/settings`);
    assert.equal(res.status, 500); assert.deepEqual(await res.json(), { error: "settings_read_failed" });
    assert.equal(store.snapshot().readError, "settings_read_failed");
    assert.equal((await fs.stat(file)).isDirectory(), true);
    assert.deepEqual(await fs.readdir(dir), ["settings.json"]);
  } finally { await new Promise<void>(r => server.close(() => r())); await fs.rm(dir, { recursive: true, force: true }); }
});
