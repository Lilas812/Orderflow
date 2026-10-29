import test from "node:test";
import assert from "node:assert/strict";
import { defaults, readDocument, validateSettings } from "../src/settings/schema.ts";
const oldKeys = ["heatTopPct", "bubbleMin", "bigTopPct", "bigMinSec", "timeZone"];

test("ダミー：version1/2をv3へ補完、原本とupdatedAtを維持、不正旧版は拒否", () => {
  for (const version of [1, 2]) {
    const keys = [...oldKeys, ...(version === 2 ? ["bubbleScale", "bookBarPct", "bookBarOpacity"] : [])];
    const doc = { version, updatedAt: 123000, values: Object.fromEntries(keys.map(k => [k, k === "heatTopPct" ? 1 : defaults[k as keyof typeof defaults]])) };
    const before = JSON.stringify(doc), normalized = readDocument(doc)!;
    assert.equal(normalized.version, 4);
    assert.equal(normalized.updatedAt, doc.updatedAt);
    assert.deepEqual(normalized.values, defaults);
    assert.equal(JSON.stringify(doc), before);
    assert.equal(readDocument({ ...doc, values: { ...doc.values, heatGamma: 2 } }), null);
    assert.equal(readDocument({ ...doc, values: { ...doc.values, heatTopPct: "bad" } }), null);
  }
});

test("ダミー：新しい6項目の境界・刻み・数字以外・不正modeは全て拒否", () => {
  for (const [key, valid, invalid] of [
    ["heatUpperSize", [1, 100000], [0, 100001, 1.5, NaN, "1"]],
    ["heatLowerSize", [0, 100000], [-1, 100001, .5]],
    ["heatLowerPct", [.1, 90], [0, 90.1, .15]],
    ["heatGamma", [.3, 3], [.2, 3.1, .35, Infinity]],
    ["heatUpperMode", ["auto", "size"], ["off", null]],
    ["heatLowerMode", ["off", "pct", "size"], ["auto", null]],
  ] as const) {
    for (const value of valid) assert.equal(validateSettings({ ...defaults, [key]: value })[key], undefined);
    for (const value of invalid) assert.ok(validateSettings({ ...defaults, [key]: value })[key]);
  }
});
