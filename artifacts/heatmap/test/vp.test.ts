import { test } from "node:test";
import assert from "node:assert/strict";
import { VpState, valueArea } from "../src/data/vp.ts";
import { vpRows } from "../src/chart/vp.ts";
import { LayerScheduler } from "../src/chart/layer-scheduler.ts";
import type { Viewport } from "../src/domain.ts";

test("ダミー：VP全置換・更新は加算でなく新合計、別セッションと不正値を拒否", () => {
  const state = new VpState();
  state.accept({ type: "vp", sessionStartSec: 100, upToSec: 200, loading: true, levels: [[400, 2, 3]] });
  state.accept({ type: "vpUpdate", sessionStartSec: 100, upToSec: 201, levels: [[400, 4, 3]] });
  assert.equal(state.levels.get(400)?.[1], 4); assert.equal(state.loading, true);
  assert.throws(() => state.accept({ type: "vpUpdate", sessionStartSec: 101, upToSec: 202, levels: [] }));
  assert.throws(() => state.accept({ type: "vp", sessionStartSec: 100, upToSec: 202, loading: false, levels: [[400, -1, 0]] }));
  state.accept({ type: "vp", sessionStartSec: 300, upToSec: 301, loading: false, levels: [] });
  assert.equal(state.levels.size, 0); assert.equal(state.loading, false);
});
test("ダミー：POC同数は高価格、VA70%以上・上下同数は上優先・端POC", () => {
  const a = valueArea([[100, 20, 0], [101, 30, 0], [102, 20, 0], [103, 0, 30]]);
  assert.equal(a.poc, 103);
  assert.deepEqual([a.low, a.high, a.included, a.total], [101, 103, 80, 100]);
  const b = valueArea([[99, 20, 0], [100, 30, 0], [101, 20, 0]]);
  assert.deepEqual([b.poc, b.low, b.high, b.included], [100, 100, 101, 50]);
  assert.equal(valueArea([]).poc, null);
  const gaps = valueArea([[1, 10, 0], [10000000, 12, 0], [20000000, 10, 0]]);
  assert.deepEqual([gaps.low, gaps.high], [1, 20000000]);
});
test("ダミー：縮小は1ティックを1画素行へ1回だけ合算、POC/VA優先、最大行を幅基準", () => {
  const levels: [number, number, number][] = [[100, 10, 0], [101, 8, 0], [102, 8, 0], [103, 8, 0]];
  const area = valueArea(levels);
  const view = { centerPriceTicks: 101.5, priceSpanTicks: 4, durationSec: 600, startUs: 0 } as Viewport;
  const rows = vpRows(levels, view, 1, area);
  assert.equal(rows.totals[0], 34); assert.equal(rows.maximum, 34); assert.equal(rows.colors[0], 2);
  const many = vpRows(levels, view, 2, area);
  assert.equal(many.totals.reduce((a, b) => a + b, 0), 34);
});
test("ダミー：非縮小は画面外POCも全幅基準、分数画素の隣接価格を二重合算しない", () => {
  const levels: [number, number, number][] = [[100, 30, 0], [101, 20, 0], [200, 100, 0]];
  const area = valueArea(levels);
  const view = { centerPriceTicks: 101, priceSpanTicks: 3, durationSec: 600, startUs: 0 } as Viewport;
  const rows = vpRows(levels, view, 10, area);
  assert.equal(rows.scaleMaximum, 100);
  assert.equal(rows.maximum, 30);
  assert.ok(rows.totals.every(x => x === 0 || x === 30 || x === 20));
});
test("ダミー：VP単独更新では他層を描かない", () => {
  let draw!: () => void; const calls: string[] = [];
  const scheduler = new LayerScheduler(fn => { draw = fn; }, {
    depth: () => calls.push("depth"), trades: () => calls.push("trades"), book: () => calls.push("book"),
    big: () => calls.push("big"), vp: () => calls.push("vp"), after: () => {},
  });
  scheduler.request("vp"); draw(); assert.deepEqual(calls, ["vp"]);
});
