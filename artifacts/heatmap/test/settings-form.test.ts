import assert from "node:assert/strict";
import test from "node:test";
import { SettingsForm } from "../src/components/settings-form.ts";
import { DEFAULT_SETTINGS } from "../src/data/settings.ts";
import type { SettingsValues } from "../src/data/settings.ts";

const saved: SettingsValues = { ...DEFAULT_SETTINGS, heatTopPct: 2.5, bubbleMin: 30, bigTopPct: 4, bigMinSec: 12, timeZone: "America/Chicago" };

test("入力検査：範囲外・数字でない・刻み違いで保存不可", () => {
  const f = new SettingsForm(); f.loadOk(saved);
  assert.equal(f.canSave(), true);
  f.set("heatTopPct", "abc"); assert.ok(f.errors().heatTopPct); assert.equal(f.canSave(), false);
  f.set("heatTopPct", "0.15"); assert.ok(f.errors().heatTopPct);
  f.set("heatTopPct", "10"); f.set("bubbleMin", "1.5"); assert.ok(f.errors().bubbleMin);
  f.set("bubbleMin", ""); assert.ok(f.errors().bubbleMin);
  f.set("bubbleMin", "1001"); assert.ok(f.errors().bubbleMin);
  f.set("bubbleMin", "1000"); assert.equal(f.canSave(), true);
});

test("初期値に戻すは入力だけ、保存は始まらない", () => {
  const f = new SettingsForm(); f.loadOk(saved); f.resetDefaults();
  assert.equal(f.inputs.bubbleMin, String(DEFAULT_SETTINGS.bubbleMin));
  assert.equal(f.status, "ready");
});

test("閉じて開き直すと入力は破棄され読み込み待ち", () => {
  const f = new SettingsForm(); f.loadOk(saved); f.set("bubbleMin", "77");
  f.begin(); assert.equal(f.canSave(), false);
  f.loadOk(saved); assert.equal(f.inputs.bubbleMin, "30");
});

test("保存失敗は入力を残し再保存可能、保存中は再送不可", () => {
  const f = new SettingsForm(); f.loadOk(saved); f.set("bigMinSec", "20");
  const v = f.startSave(); assert.equal(v?.bigMinSec, 20);
  assert.equal(f.startSave(), null);
  f.saveFail("x"); assert.equal(f.inputs.bigMinSec, "20"); assert.ok(f.message); assert.equal(f.canSave(), true);
});

test("読み込み失敗では保存も初期値に戻すも不可", () => {
  const f = new SettingsForm(); f.loadFail("timeout");
  assert.equal(f.canSave(), false); assert.equal(f.startSave(), null);
  f.resetDefaults(); assert.equal(f.canSave(), false); assert.match(f.message, /timeout/);
});
