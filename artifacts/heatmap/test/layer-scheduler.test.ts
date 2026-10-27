import assert from "node:assert/strict";
import test from "node:test";
import { LayerScheduler } from "../src/chart/layer-scheduler.ts";

test("ダミー：250msの板更新だけではheatmap/約定/現在値層に触れない", () => {
  const queued: (() => void)[] = [], calls: string[] = [];
  const scheduler = new LayerScheduler(fn => queued.push(fn), {
    depth: () => calls.push("depth"), book: () => calls.push("book"),
    trades: () => calls.push("trades"), after: () => {},
  });
  for (let elapsed = 0; elapsed < 1000; elapsed += 250) {
    scheduler.request("book"); queued.shift()!();
  }
  assert.deepEqual(calls, ["book", "book", "book", "book"]);
  scheduler.request("trades"); queued.shift()!();
  assert.deepEqual(calls.slice(4), ["trades"]); // trade-only must not repaint book either
});

test("ダミー：viewport/resize/列/P99更新は共通基準を先に更新して全層を描く", () => {
  const queued: (() => void)[] = [], calls: string[] = [];
  let p99 = 5, consumed = 0;
  const scheduler = new LayerScheduler(fn => queued.push(fn), {
    depth: () => { calls.push("depth"); p99 = 20; },
    book: () => { calls.push("book"); consumed = p99; },
    trades: () => calls.push("trades"),
    after: (depth, _start, trades) => { assert.ok(depth && trades); },
  });
  scheduler.request("book"); scheduler.request("all"); scheduler.request("trades");
  assert.equal(queued.length, 1);
  queued.shift()!();
  assert.deepEqual(calls, ["depth", "book", "trades"]);
  assert.equal(consumed, 20);
});

test("ダミー：板と約定の同一フレーム更新はheatmapを描かず各層1回", () => {
  const queued: (() => void)[] = [], calls: string[] = [];
  const scheduler = new LayerScheduler(fn => queued.push(fn), {
    depth: () => calls.push("depth"), book: () => calls.push("book"),
    trades: () => calls.push("trades"), after: () => {},
  });
  scheduler.request("book"); scheduler.request("trades"); scheduler.request("book");
  queued.shift()!();
  assert.deepEqual(calls, ["book", "trades"]);
});
