import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, defaultDocument, resolveSettings, settingsChanges, validateSettings } from "../src/data/settings.ts";
import { ColumnCache } from "../src/data/cache.ts";
import { BigOrderFeed } from "../src/data/big-orders.ts";
import { LayerScheduler } from "../src/chart/layer-scheduler.ts";
import { resetViewport } from "../src/chart/view-reset.ts";
import { timeUsToX } from "../src/chart/coordinates.ts";
import { formatTimeUs } from "../src/chart/timezone.ts";
import type { HeatColumn } from "../src/domain.ts";
import { viewportPositiveP99 } from "../src/chart/scale.ts";
import { SettingsForm, toInputs } from "../src/components/settings-form.ts";

const column = (second: number): HeatColumn => ({ timeUs: second * 1e6, source: "live",
  bids: { prices: new Int32Array([400]), sizes: new Uint32Array([10]) },
  asks: { prices: new Int32Array([401]), sizes: new Uint32Array([100]) } });

test("ダミー：上位設定で正の可視セルの順位だけ変わり、破棄で入力を残さない", () => {
  const c = column(0);
  c.bids.prices = Int32Array.from({ length: 100 }, (_, i) => i + 1);
  c.bids.sizes = Uint32Array.from({ length: 100 }, (_, i) => i + 1);
  c.asks.prices = new Int32Array(); c.asks.sizes = new Uint32Array();
  const v = { startUs: 0, durationSec: 600, centerPriceTicks: 50, priceSpanTicks: 200 };
  assert.equal(viewportPositiveP99([c], v, 1), 99);
  assert.equal(viewportPositiveP99([c], v, 10), 90);
  assert.equal(viewportPositiveP99([c], v, .1), 100);
  const form = new SettingsForm(); form.loadOk({ ...DEFAULT_SETTINGS, bubbleMin: 50 });
  form.set("bubbleMin", "99"); form.begin();
  assert.deepEqual(form.inputs, toInputs(DEFAULT_SETTINGS)); assert.equal(form.canSave(), false);
});

test("ダミー：設定の範囲・刻みとURL優先、無効URL初期値、tz廃止", () => {
  assert.equal(Object.keys(validateSettings(DEFAULT_SETTINGS)).length, 0);
  for (const v of [{ ...DEFAULT_SETTINGS, bubbleMin: 0 }, { ...DEFAULT_SETTINGS, heatTopPct: 1.01 },
    { ...DEFAULT_SETTINGS, bigMinSec: 601 }, { ...DEFAULT_SETTINGS, timeZone: "UTC" }])
    assert.ok(Object.keys(validateSettings(v)).length);
  const doc = { ...defaultDocument(), updatedAt: 1, values: { ...DEFAULT_SETTINGS, bubbleMin: 40, timeZone: "Asia/Tokyo" as const } };
  const s = resolveSettings(doc, "?bubbleMin=2000&bigTop=25&bigMinSec=0&tz=ct");
  assert.deepEqual(s.values, { ...DEFAULT_SETTINGS, bubbleMin: 2000, bigTopPct: 25, bigMinSec: 0 });
  assert.equal(s.sources.bubbleMin, "URL"); assert.equal(s.sources.timeZone, "保存");
  const invalid = resolveSettings(doc, "?bubbleMin=x"); assert.equal(invalid.values.bubbleMin, 10);
  assert.deepEqual(invalid.invalid, ["bubbleMin 無効"]);
  assert.equal(resolveSettings(defaultDocument(), "").sources.heatTopPct, "初期値");
});

test("ダミー：設定ごとの層だけを要求、色更新は価格軸/約定/VP/デルタへ波及しない", () => {
  let queued: (() => void) | undefined; const seen: string[] = [];
  const s = new LayerScheduler(cb => { queued = cb; }, {
    depth: axes => seen.push(`heat:${axes}`), book: () => seen.push("book"), trades: () => seen.push("trades"),
    big: () => seen.push("big"), vp: () => seen.push("vp"), delta: () => seen.push("delta"), after: () => {},
  });
  s.request("heat"); queued!(); assert.deepEqual(seen, ["heat:false", "book"]); seen.length = 0;
  s.request("trades"); queued!(); assert.deepEqual(seen, ["trades"]); seen.length = 0;
  s.request("big"); queued!(); assert.deepEqual(seen, ["big"]);
  for (const [key, expected] of [["heatTopPct", "heat"], ["bubbleMin", "bubbles"], ["bigTopPct", "big"], ["bigMinSec", "big"], ["timeZone", "time"]] as const) {
    const next = { ...DEFAULT_SETTINGS, [key]: key === "timeZone" ? "America/Chicago" : 3 };
    assert.deepEqual(Object.entries(settingsChanges(DEFAULT_SETTINGS, next as typeof DEFAULT_SETTINGS)).filter(([, v]) => v).map(([k]) => k), [expected]);
  }
});

test("ダミー：再構築用の最新列と表示列は同一オブジェクト、過去閲覧でも最新位置、2時間上限", () => {
  const cache = new ColumnCache(), feed = new BigOrderFeed(2);
  const columns = Array.from({ length: 7202 }, (_, i) => column(i));
  feed.beginInitial(1800e6); const initial = columns.slice(0, 1801);
  cache.addColumns(initial); feed.accept(initial, 2, 0); feed.completeInitial();
  for (const c of columns.slice(1801)) { cache.addColumn(c); feed.accept([c], 1, 0); }
  assert.deepEqual(feed.sharing(cache.columns), { retained: 7200, overlap: 7200, shared: 7200 });
  const cloned = column(7201), shared = feed.shareColumn(cloned);
  assert.equal(shared, columns[7201]); assert.equal(shared.bids.prices, columns[7201]!.bids.prices);
  cache.addColumn(shared);
  cache.setRetentionAnchor(-10000e6, -9000e6, false, cache.latestTimeUs);
  const head = feed.tracker.snapshot().timeUs, rebuilds = feed.tracker.metrics.rebuildCount;
  feed.reconfigure(20);
  assert.equal(feed.tracker.snapshot().timeUs, head);
  assert.equal(feed.tracker.metrics.rebuildCount, rebuilds + 1);
  assert.equal(feed.retainedColumns.at(-1), columns[7201]);
});

test("ダミー：ライブ/リプレイのリセット位置、現在約定中心、時刻表示だけ切替", () => {
  for (const mode of ["live", "replay"] as const) for (const anchor of [1000e6, 1000.5e6]) {
    const v = resetViewport(anchor, 119001, 800, mode);
    assert.equal(v.durationSec, 600); assert.equal(v.priceSpanTicks, 160); assert.equal(v.centerPriceTicks, 119001);
    assert.ok(Math.abs(timeUsToX(anchor + (mode === "live" ? 1e6 : 0), v, 800) - 640) <= 1);
  }
  const time = Date.parse("2026-10-27T13:00:00Z") * 1000;
  assert.equal(formatTimeUs(time, "jst"), "22:00:00");
  assert.equal(formatTimeUs(time, "ct"), "08:00:00");
});
