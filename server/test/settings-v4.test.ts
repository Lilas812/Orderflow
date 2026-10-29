import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaults, readDocument, validateSettings } from "../src/settings/schema.ts";
import { LocalSettings } from "../src/settings/local.ts";

const legacy = () => {
  const { heatStyle: _style, bigOrdersVisible: _visible, ...values } = defaults;
  return { version: 3, updatedAt: 123000, values: {
    ...values, heatTopPct: 1, heatLowerMode: "off", heatLowerPct: 20, heatGamma: 1,
  } };
};
test("ダミー：Phase14は16保存項目、2項目の型検査と初期値", () => {
  assert.equal(Object.keys(defaults).length, 16);
  assert.equal(defaults.heatStyle, "glow"); assert.equal(defaults.bigOrdersVisible, false);
  for (const heatStyle of ["glow", "block"]) assert.equal(Object.keys(validateSettings({ ...defaults, heatStyle })).length, 0);
  for (const bad of ["", true, 1, null]) assert.ok(validateSettings({ ...defaults, heatStyle: bad }).heatStyle);
  for (const bad of ["false", 0, null]) assert.ok(validateSettings({ ...defaults, bigOrdersVisible: bad }).bigOrdersVisible);
});
test("ダミー：v3の10c初期4値だけを移行、1つ変えれば4値すべて保持、原本不変", () => {
  const original = legacy(), bytes = JSON.stringify(original);
  const normalized = readDocument(original)!;
  assert.equal(normalized.version, 4); assert.deepEqual(normalized.values, defaults);
  assert.equal(JSON.stringify(original), bytes);
  for (const [key, value] of [["heatTopPct", 2], ["heatLowerMode", "size"],
    ["heatLowerPct", 21], ["heatGamma", 2]] as const) {
    const input = legacy(); Object.assign(input.values, { [key]: value });
    const result = readDocument(input)!;
    for (const k of ["heatTopPct", "heatLowerMode", "heatLowerPct", "heatGamma"] as const)
      assert.equal(result.values[k], input.values[k]);
    assert.equal(result.values.heatStyle, "glow"); assert.equal(result.values.bigOrdersVisible, false);
  }
  const current = { version: 4, updatedAt: 999, values: { ...defaults, ...original.values } };
  assert.deepEqual(readDocument(current), current, "v4の明示した旧値は移行しない");
  assert.equal(readDocument({ ...original, values: { ...original.values, heatStyle: "block" } }), null);
  assert.equal(readDocument({ ...current, values: original.values }), null);
});
test("ダミー：旧版GETで退避・書換なし、次の保存だけv4、互換2値を保持", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-phase14-settings-"));
  const file = path.join(dir, "settings.json"), events: string[] = [];
  try {
    const doc = legacy(); doc.values.bookBarPct = 17; doc.values.bookBarOpacity = .75;
    const raw = JSON.stringify(doc) + "\r\n"; await fs.writeFile(file, raw);
    const store = new LocalSettings(file, event => events.push(event));
    const loaded = await store.get();
    assert.equal(loaded.version, 4); assert.equal(loaded.updatedAt, doc.updatedAt);
    assert.equal(await fs.readFile(file, "utf8"), raw);
    assert.deepEqual(await fs.readdir(dir), ["settings.json"]);
    assert.equal(store.snapshot().readError, null);
    const saved = await store.put(loaded.values);
    assert.equal(saved.version, 4); assert.equal(saved.values.bookBarPct, 17);
    assert.equal(saved.values.bookBarOpacity, .75);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 4);
    assert.equal(events.includes("settings_corrupt_preserved"), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
