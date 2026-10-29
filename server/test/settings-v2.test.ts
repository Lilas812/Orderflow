import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaults, validateSettings } from "../src/settings/schema.ts";
import { LocalSettings } from "../src/settings/local.ts";

test("ダミー：追加3設定の両境界・刻み・型・必須", () => {
  for (const [key, good, bad] of [
    ["bubbleScale", [.5, .6, 1, 2, 3], [.4, 3.1, .55, "1", null, NaN, Infinity]],
    ["bookBarPct", [5, 10, 20], [4, 21, 5.5, "10", null, NaN, Infinity]],
    ["bookBarOpacity", [.1, .15, .5, .95, 1], [.05, 1.05, .11, "0.5", null, NaN, Infinity]],
  ] as const) {
    for (const n of good) assert.equal(Object.keys(validateSettings({ ...defaults, [key]: n })).length, 0);
    for (const n of bad) assert.ok(validateSettings({ ...defaults, [key]: n })[key]);
    const missing = { ...defaults } as Record<string, unknown>; delete missing[key];
    assert.ok(validateSettings(missing)[key]);
  }
});

test("ダミー：v1を補ってv2応答、元ファイル不変・退避なし・次の保存だけv2", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-settings-v2-"));
  const file = path.join(dir, "settings.json"), events: string[] = [];
  try {
    const legacy = { version: 1, values: { heatTopPct: 2, bubbleMin: 23, bigTopPct: 4,
      bigMinSec: 12, timeZone: "America/Chicago" }, updatedAt: 1234000 };
    const bytes = Buffer.from(JSON.stringify(legacy, null, 2) + "\r\n");
    await fs.writeFile(file, bytes);
    const store = new LocalSettings(file, event => events.push(event));
    const got = await store.get();
    assert.equal(got.version, 4); assert.equal(got.updatedAt, legacy.updatedAt);
    assert.deepEqual(got.values, { ...defaults, heatLowerMode: "off", heatLowerPct: 20, heatGamma: 1, ...legacy.values });
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.deepEqual(await fs.readdir(dir), ["settings.json"]);
    assert.equal(store.snapshot().readError, null); assert.deepEqual(events, []);
    const saved = await store.put(got.values);
    assert.equal(saved.version, 4);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), saved);
    assert.deepEqual(await fs.readdir(dir), ["settings.json"]);
    assert.deepEqual(events.filter(e => e === "settings_corrupt_preserved"), []);
  } finally { await fs.rm(dir, { recursive: true }); }
});
