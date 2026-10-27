import assert from "node:assert/strict";
import test from "node:test";
import { BigOrderFeed, BigOrderTracker, bigOrderThreshold, parseBigOrderOptions } from "../src/data/big-orders.ts";
import { BigOrderRenderer, bigOrderOpacity, bigOrderRows, visibleBigOrders } from "../src/chart/big-orders.ts";
import { currentBookRows } from "../src/chart/current-book.ts";
import type { BigOrder } from "../src/data/big-orders.ts";
import type { Viewport } from "../src/domain.ts";
import { column } from "./helpers.ts";

const input = (second: number, size = 10) => column(second, {
  bids: [[100, size], [99, 10], [98, 1]], asks: [[101, 1], [102, 1]],
});
const outside = (second: number) => column(second, {
  bids: [[90, 10], [89, 1]], asks: [[91, 1], [92, 1]],
});
const target = (tracker: BigOrderTracker) => tracker.snapshot().orders.find(order => order.price === 100);
const view: Viewport = { startUs: 0, durationSec: 600, centerPriceTicks: 100, priceSpanTicks: 20 };

test("ダミー：両側の正の枚数だけの98パーセンタイル、nearest rank、全空", () => {
  const c = column(0, { bids: Array.from({ length: 50 }, (_, i) => [100 - i, i + 1]),
    asks: [...Array.from({ length: 50 }, (_, i): [number, number] => [101 + i, i + 51]), [151, 0]] });
  assert.equal(bigOrderThreshold(c), 98);
  assert.equal(bigOrderThreshold(c, 1), 99);
  assert.equal(bigOrderThreshold(c, 5), 95);
  assert.equal(bigOrderThreshold(c, 100), 1);
  assert.equal(bigOrderThreshold(column(0, { bids: [[100, 0]] })), null);
});

test("ダミー：URL初期値、小数のbigTop、0秒、有効上限、無効表示用フラグ", () => {
  assert.deepEqual(parseBigOrderOptions(""), { top: { value: 2, invalid: false }, minSec: { value: 5, invalid: false } });
  for (const value of ["", "x", "NaN", "Infinity", "-1", "0", "100.1"]) {
    assert.deepEqual(parseBigOrderOptions(`?bigTop=${value}`).top, { value: 2, invalid: true });
  }
  assert.equal(parseBigOrderOptions("?bigTop=0.5").top.value, 0.5);
  assert.equal(parseBigOrderOptions("?bigTop=100").top.value, 100);
  for (const value of ["", "x", "NaN", "Infinity", "-1", "1.5"]) {
    assert.deepEqual(parseBigOrderOptions(`?bigMinSec=${value}`).minSec, { value: 5, invalid: true });
  }
  for (const value of [0, 30, 1e15]) {
    assert.deepEqual(parseBigOrderOptions(`?bigMinSec=${value}`).minSec, { value, invalid: false });
  }
});

test("ダミー：閾値で開始、0.8ちょうどは継続、未満で終了、再開は新しい秒", () => {
  const tracker = new BigOrderTracker();
  tracker.append(input(0, 9)); assert.equal(target(tracker), undefined);
  tracker.append(input(1)); assert.equal(target(tracker)?.startedUs, 1_000_000);
  tracker.append(input(2, 8)); assert.equal(target(tracker)?.startedUs, 1_000_000);
  tracker.append(input(3, 7)); assert.equal(target(tracker), undefined);
  tracker.append(input(4, 9)); assert.equal(target(tracker), undefined);
  tracker.append(input(5)); assert.equal(target(tracker)?.startedUs, 5_000_000);
  tracker.append(input(5, 1)); assert.equal(target(tracker)?.size, 10); // confirmed duplicate cannot rewind state
});

test("ダミー：4秒は非表示、5秒は表示、0秒は即表示、価格外は非表示", () => {
  const tracker = new BigOrderTracker();
  for (let s = 0; s <= 4; s++) tracker.append(input(s));
  assert.equal(visibleBigOrders(tracker.snapshot(), view, 5).length, 0);
  assert.equal(visibleBigOrders(tracker.snapshot(), view, 0).length, 2);
  tracker.append(input(5));
  assert.equal(visibleBigOrders(tracker.snapshot(), view, 5).length, 2);
  assert.equal(visibleBigOrders(tracker.snapshot(), { ...view, centerPriceTicks: 200 }, 5).length, 0);
});

test("ダミー：400段外は保留して非表示、5分未満の復帰はヒステリシスで継続", () => {
  const tracker = new BigOrderTracker();
  tracker.append(input(0));
  for (let s = 1; s < 300; s++) tracker.append(outside(s));
  assert.equal(target(tracker)?.outsideSinceUs, 1_000_000);
  assert.equal(target(tracker)?.startedUs, 0);
  assert.ok(visibleBigOrders(tracker.snapshot(), view, 5).every(order => order.price !== 100));
  tracker.append(input(300, 8));
  assert.equal(target(tracker)?.outsideSinceUs, null);
  assert.equal(target(tracker)?.startedUs, 0);
  tracker.append(outside(301)); tracker.append(input(302, 7));
  assert.equal(target(tracker), undefined);
});

test("ダミー：範囲外で300秒経過した列で終了、期限での復帰は数え直す", () => {
  for (const returnAtDeadline of [false, true]) {
    const tracker = new BigOrderTracker();
    tracker.append(input(0));
    for (let s = 1; s <= 300; s++) tracker.append(outside(s));
    assert.equal(target(tracker)?.startedUs, 0);
    tracker.append(returnAtDeadline ? input(301) : outside(301));
    if (returnAtDeadline) assert.equal(target(tracker)?.startedUs, 301_000_000);
    else {
      assert.equal(target(tracker), undefined);
      tracker.append(input(302));
      assert.equal(target(tracker)?.startedUs, 302_000_000);
    }
  }
});

test("ダミー：2秒以下の欠けは継続、3秒以上の欠けは新規開始", () => {
  for (const missing of [1, 2, 3, 10]) {
    const tracker = new BigOrderTracker();
    tracker.append(input(0)); tracker.append(input(missing + 1));
    assert.equal(target(tracker)?.startedUs, missing <= 2 ? 0 : (missing + 1) * 1_000_000);
  }
  const tracker = new BigOrderTracker();
  tracker.append(input(0)); tracker.append(input(3, 7));
  assert.equal(target(tracker), undefined); // carried seconds don't hide the drop on return
});

test("ダミー：再構築は順次処理と一致、リプレイ位置より先を使わない", () => {
  const columns = Array.from({ length: 30 }, (_, s) => input(s, s < 20 ? 10 : 7))
    .filter(c => ![4, 5, 12, 13, 14].includes(c.timeUs / 1_000_000));
  const sequential = new BigOrderTracker(), rebuilt = new BigOrderTracker();
  for (const c of columns.filter(c => c.timeUs <= 19_000_000)) sequential.append(c);
  rebuilt.rebuild([...columns].reverse(), 19_000_000);
  assert.deepEqual(rebuilt.snapshot(), sequential.snapshot());
  assert.equal(target(rebuilt)?.startedUs, 15_000_000);
  assert.equal(rebuilt.metrics.rebuildCount, 1);
});

test("ダミー：初回rangeのみ再構築、同時ライブを適用、過去rangeや持ち替えは状態不変", () => {
  const feed = new BigOrderFeed();
  feed.beginInitial(5_999_999);
  feed.accept(Array.from({ length: 10 }, (_, s) => input(s)), 2, 0);
  feed.accept([input(6), input(7)], 1, 0);
  feed.completeInitial();
  assert.equal(target(feed.tracker)?.durationSec, 7);
  assert.equal(feed.tracker.metrics.rebuildCount, 1);
  const before = feed.tracker.snapshot();
  feed.accept([input(-100, 7), input(1000, 7)], 2, 9);
  feed.completeInitial();
  assert.deepEqual(feed.tracker.snapshot(), before);
  for (let s = 8; s <= 7300; s++) feed.accept([input(s)], 1, 0);
  assert.equal(target(feed.tracker)?.durationSec, 7300); // longer than a viewport cache
  assert.equal(feed.tracker.metrics.rebuildCount, 1);
  feed.beginInitial(49_999_999); // reconnect or changed replay start is a new bootstrap
  feed.accept([input(40), input(41)], 2, 0);
  feed.accept([input(50)], 1, 0);
  feed.completeInitial();
  assert.equal(target(feed.tracker)?.startedUs, 50_000_000); // long missing run resets
  assert.equal(feed.tracker.metrics.rebuildCount, 2);
});

test("ダミー：濃さは5秒0.35・300秒1・中間線形、5秒未満と300秒超は頭打ち", () => {
  assert.equal(bigOrderOpacity(0), 0.35);
  assert.equal(bigOrderOpacity(5), 0.35);
  assert.equal(bigOrderOpacity(152.5), 0.675);
  assert.equal(bigOrderOpacity(300), 1);
  assert.equal(bigOrderOpacity(600), 1);
});

test("ダミー：縮小は最大枚数とその継続時間、現在板と同じ価格投影、時間panは不変", () => {
  const orders: BigOrder[] = [
    { price: 99, size: 5, durationSec: 300, startedUs: 0, outsideSinceUs: null },
    { price: 100, size: 20, durationSec: 5, startedUs: 0, outsideSinceUs: null },
  ];
  const single = bigOrderRows(orders, view, 1);
  assert.equal(single[0], orders[1]); assert.equal(bigOrderOpacity(single[0]!.durationSec), 0.35);
  for (const height of [1, 3, 200, 400]) {
    const rows = bigOrderRows(orders, view, height);
    const book = column(0, { bids: orders.map(o => [o.price, o.size]) });
    assert.deepEqual(Array.from(rows, o => o?.size ?? 0),
      [...currentBookRows(book, view, height)]);
    assert.deepEqual(rows, bigOrderRows(orders, { ...view, startUs: -1e12, durationSec: 7200 }, height));
  }
});

test("ダミー：専用Canvas、表示中の最大だけで長さ計算、色・濃さ・DPR・全消去", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 2 }, configurable: true });
  const events: unknown[][] = [];
  const ctx = { fillStyle: "", globalAlpha: 1,
    clearRect: (...args: number[]) => events.push(["clear", ...args]),
    fillRect: (...args: number[]) => events.push(["rect", ctx.fillStyle, ctx.globalAlpha, ...args]) };
  const canvas = { width: 0, height: 0, getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 100, height: 200 }) };
  try {
    const renderer = new BigOrderRenderer(canvas as unknown as HTMLCanvasElement);
    renderer.draw({ timeUs: 10e6, threshold: 5, orders: [
      { price: 99, size: 5, startedUs: 0, durationSec: 5, outsideSinceUs: null },
      { price: 101, size: 10, startedUs: 0, durationSec: 300, outsideSinceUs: null },
      { price: 150, size: 1000, startedUs: 0, durationSec: 300, outsideSinceUs: null },
    ] }, view, 5);
    assert.equal(canvas.width, 200); assert.equal(canvas.height, 400);
    const rects = events.filter(e => e[0] === "rect");
    assert.ok(rects.some(e => e[2] === 0.35 && e[3] === 100 && e[5] === 100));
    assert.ok(rects.some(e => e[2] === 1 && e[3] === 0 && e[5] === 200));
    assert.ok(rects.every(e => e[1] === "#e040fb" && Number(e[3]) + Number(e[5]) === 200));
    assert.equal(renderer.metrics.visibleCount, 2);
    events.length = 0;
    renderer.draw({ timeUs: null, threshold: null, orders: [] }, view, 5);
    assert.deepEqual(events, [["clear", 0, 0, 200, 400]]);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
