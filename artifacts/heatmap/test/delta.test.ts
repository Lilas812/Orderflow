import assert from "node:assert/strict";
import test from "node:test";
import { TradeAggregator } from "../src/data/trade-aggregate.ts";
import { deltaBounds, deltaGeometry, deltaSeconds } from "../src/chart/delta-geometry.ts";
import { DeltaRenderer } from "../src/chart/delta.ts";
import { LayerScheduler } from "../src/chart/layer-scheduler.ts";
import { timeUsToX, followStartUs } from "../src/chart/coordinates.ts";
import { FrameProfile } from "../src/chart/frame-profile.ts";
import { ColumnCache } from "../src/data/cache.ts";
import type { Trade, Viewport } from "../src/domain.ts";

const U = 1_000_000;
const view = (startSec = 0, durationSec = 100): Viewport =>
  ({ startUs: startSec * U, durationSec, centerPriceTicks: 0, priceSpanTicks: 8 });
const emptyLevels = () => ({ prices: new Int32Array(), sizes: new Uint32Array() });
let seq = 0;
const trade = (second: number, size: number, side: Trade["side"] = "buy", price = 100): Trade =>
  ({ tsUs: Math.round(second * U), size, side, price, recvUs: seq, seq: seq++ });
function range(a: TradeAggregator, from: number, to: number, trades: Trade[] = [], id = 1) {
  a.beginRange(id, from * U, to * U); a.appendRangeChunk(id, trades); a.commitRange(id);
}

test("ダミー：3 CSS px以上となる最小秒数、閾値の直前・ちょうど・拡縮の切替", () => {
  for (const [duration, expected] of [[100, 1], [101, 5], [500, 5], [501, 15],
    [1500, 15], [1501, 60], [6000, 60], [6001, 300]] as const) {
    assert.equal(deltaSeconds(duration, 300), expected);
  }
  assert.equal(deltaSeconds(100, 299.99), 5);
  assert.equal(deltaSeconds(7200, 100), 300);
  assert.equal(deltaSeconds(7200, 1), 300); // candidate cap in an extremely narrow panel
});

test("ダミー：実Unix秒で15秒境界、半開区間・買い−売り・無約定非描画・価格範囲非依存", () => {
  const base = 1793022000, a = new TradeAggregator();
  range(a, base, base + 150, [
    trade(base, 10), trade(base + 14.999999, 3, "sell", 200),
    trade(base + 15, 8, "sell"), trade(base + 29.5, 2), trade(base + 45, 7),
  ]);
  const g = deltaGeometry(a, view(base, 150), 100, 100, Infinity, Infinity);
  assert.equal(g.seconds, 5);
  const fifteen = deltaGeometry(a, view(base, 150), 50, 100, Infinity, Infinity);
  assert.equal(fifteen.seconds, 15);
  assert.deepEqual(fifteen.bars.map(b => [b.startUs / U, b.buy, b.sell, b.delta]),
    [[base, 10, 3, 7], [base + 15, 2, 8, -6], [base + 45, 7, 0, 7]]);
  assert.equal(fifteen.maximum, 7);
  assert.deepEqual(deltaBounds(view(base + 1, 148), 15), { fromUs: base * U, toUs: (base + 150) * U });
});

test("ダミー：可視の|デルタ|最大を上下半分へ、部分可視の棒は区間全体を使う", () => {
  const a = new TradeAggregator();
  range(a, 0, 180, [trade(1, 1000), trade(31, 12), trade(45, 3, "sell"),
    trade(60, 6, "sell"), trade(179, 999)]);
  const v = view(32, 100);
  const g = deltaGeometry(a, v, 20, 80, Infinity, Infinity); // 15s
  assert.equal(g.seconds, 15); assert.equal(g.maximum, 12);
  assert.deepEqual(g.bars.map(b => [b.delta, b.y, b.height]), [[12, 0, 40], [-3, 40, 10], [-6, 40, 20]]);
  assert.ok(g.bars[0]!.x < 0);
  assert.equal(g.bars[0]!.width, 3);
});

test("ダミー：時間座標は本体と同じ、66%枠と80%追尾、DPRに依存せず秒数を選ぶ", () => {
  const a = new TradeAggregator(); range(a, 0, 1000, [trade(600, 12)]);
  const width = 801.234;
  const v = { ...view(0, 600), startUs: followStartUs(600 * U, 600, Math.round(width * 2)) };
  const g = deltaGeometry(a, v, width, 100, 601 * U, 0);
  const b = g.bars.find(b => b.startUs === 600 * U)!;
  assert.equal(b.x, timeUsToX(600 * U, v, width));
  assert.equal(b.x + b.width, timeUsToX((600 + g.seconds) * U, v, width));
  assert.ok(Math.abs(timeUsToX(601 * U, v, width) / width - 0.8) < 0.002);
});

test("ダミー：最新区間は約定毎に伸びる、同秒の未来を除外、ゼロ差は有限の高さ", () => {
  const a = new TradeAggregator();
  a.appendLive([trade(10.1, 4), trade(10.9, 9, "sell")]);
  const first = deltaGeometry(a, view(10, 10), 300, 100, 10.2 * U, 10 * U);
  assert.deepEqual(first.bars.map(b => b.delta), [4]);
  const next = deltaGeometry(a, view(10, 10), 300, 100, 10.9 * U, 10 * U);
  assert.deepEqual(next.bars.map(b => b.delta), [-5]);
  a.appendLive([trade(10.95, 5)]);
  const zero = deltaGeometry(a, view(10, 10), 300, 100, 11 * U, 10 * U);
  assert.equal(zero.maximum, 0); assert.equal(zero.bars[0]!.height, 0);
  assert.equal(zero.bars[0]!.y, 50);
});

test("ダミー：取得中・中断・不足・保持外は描かず、rangeDone後に表示し再取得は置換", () => {
  const a = new TradeAggregator();
  a.appendLive([trade(14, 3)]);
  a.beginRange(1, 10 * U, 15 * U);
  a.appendRangeChunk(1, [trade(14, 7)]);
  const geometry = () => deltaGeometry(a, view(10, 5), 300, 100, 15 * U - 1, Infinity);
  assert.equal(geometry().bars.length, 0);
  a.abortRange(1); assert.equal(geometry().bars.length, 0);
  range(a, 10, 15, [trade(14, 7)]);
  assert.deepEqual(geometry().bars.map(b => b.delta), [7]);
  range(a, 10, 15, [trade(14, 4, "sell")]);
  assert.deepEqual(geometry().bars.map(b => b.delta), [-4]);
  a.retain(12 * U, 100 * U);
  assert.equal(a.coversRange(10 * U, 15 * U), false);
  assert.equal(a.coversRange(10 * U, 15 * U, { fromUs: 0, toUs: 100 * U }), false);
  a.retain(0, 100 * U);
  assert.equal(a.coversRange(10 * U, 15 * U), false, "evicted coverage cannot reappear on pan");
  a.reset(); assert.equal(a.coversRange(12 * U, 15 * U), false);
});

test("ダミー：隣接範囲とストリームの被覆は合流し、途中の1µs不足は隠さない", () => {
  const a = new TradeAggregator(); range(a, 0, 5); range(a, 5, 10);
  assert.equal(a.coversRange(0, 15 * U, { fromUs: 10 * U, toUs: 15 * U }), true);
  assert.equal(a.coversRange(0, 15 * U, { fromUs: 10 * U + 1, toUs: 15 * U }), false);
  range(a, 20, 25);
  assert.equal(a.coversRange(0, 25 * U), false);
  assert.equal(a.coversRange(0, 10 * U), true, "zero trades still has committed coverage");
});

test("ダミー：デルタ単独は他層を描かず、他層単独もデルタを描かない", () => {
  const queued: (() => void)[] = [], calls: string[] = [];
  const scheduler = new LayerScheduler(fn => queued.push(fn), {
    depth: () => calls.push("depth"), trades: () => calls.push("trades"), book: () => calls.push("book"),
    big: () => calls.push("big"), vp: () => calls.push("vp"), delta: () => calls.push("delta"),
    after() {},
  });
  scheduler.request("delta"); scheduler.request("delta"); queued.shift()!();
  assert.deepEqual(calls, ["delta"]);
  for (const layer of ["book", "vp", "big", "trades"] as const) {
    calls.length = 0; scheduler.request(layer); queued.shift()!(); assert.deepEqual(calls, [layer]);
  }
  calls.length = 0; scheduler.request("all"); scheduler.request("delta"); queued.shift()!();
  assert.deepEqual(calls, ["depth", "book", "trades", "big", "vp", "delta"]);
});

test("ダミー：DPR2でもCSS寸法・白/紫・中央線・目盛り・空データを独立描画", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 2 }, configurable: true });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "window", descriptor)
    : Reflect.deleteProperty(globalThis, "window"));
  const fills: { color: string; x: number; y: number; width: number; height: number }[] = [];
  const labels: string[] = [], lines: number[][] = [];
  const textCalls: { text: string; x: number; y: number; color: string; font: string; align: string; maxWidth: number }[] = [];
  const ctx = { fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "",
    setTransform() {}, clearRect() { fills.length = 0; }, beginPath() {}, stroke() {},
    moveTo(x: number, y: number) { lines.push([x, y]); }, lineTo(x: number, y: number) { lines.push([x, y]); },
    fillRect(x: number, y: number, width: number, height: number) {
      fills.push({ color: this.fillStyle, x, y, width, height });
    }, measureText(text: string) { return { width: text.length * 7.2 }; },
    fillText(text: string, x: number, y: number, maxWidth: number) {
      labels.push(text); textCalls.push({ text, x, y, color: this.fillStyle, font: this.font, align: this.textAlign, maxWidth });
    } };
  const canvas = { width: 0, height: 0, getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 300, height: 100 }) };
  const scale = { ...canvas, getContext: () => ({ ...ctx, clearRect() {} }) };
  const a = new TradeAggregator(); range(a, 0, 100, [trade(1, 8), trade(2, 4, "sell")]);
  const renderer = new DeltaRenderer(canvas as unknown as HTMLCanvasElement, scale as unknown as HTMLCanvasElement);
  renderer.draw(a, view(), Infinity, Infinity);
  assert.equal(canvas.width, 600); assert.equal(canvas.height, 200);
  assert.deepEqual(fills.map(b => [b.color, b.y, b.width, b.height]), [
    ["#ece9f5", 0, 3, 50], ["#b13cff", 50, 3, 25],
  ]);
  assert.deepEqual(lines, [[0, 50], [300, 50]]);
  assert.equal(ctx.strokeStyle, "#252431"); assert.equal(ctx.lineWidth, 1);
  assert.deepEqual(labels, ["+8", "0", "−8", "1s"]);
  assert.ok(textCalls.slice(0, 3).every(c => c.color === "#d9d9d9" && c.font.startsWith("12px")));
  const zeroLabel = textCalls[1]!, secondsLabel = textCalls[3]!;
  assert.equal(secondsLabel.color, "#8a8a8a"); assert.ok(secondsLabel.font.startsWith("11px"));
  assert.equal(zeroLabel.y, secondsLabel.y); assert.equal(secondsLabel.align, "right");
  assert.ok(secondsLabel.x - secondsLabel.maxWidth + 1e-9 >= zeroLabel.x + 7.2);
  assert.equal(renderer.metrics.visibleCount, 2);
  const snapshot = renderer.snapshot(); snapshot[0]!.delta = 999;
  assert.equal(renderer.snapshot()[0]!.delta, 8);
  a.reset(); renderer.draw(a, view(), Infinity, Infinity);
  assert.equal(fills.length, 0); assert.equal(renderer.metrics.maximum, 0);
  assert.equal(renderer.metrics.visibleCount, 0);
});

test("ダミー：フレーム内訳はデルタを二重加算しない", () => {
  const p = new FrameProfile();
  p.record({ at: 1, totalMs: 10, heatmapMs: 2, tradesMs: 1, bookMs: 1, bigMs: 1, vpMs: 1,
    deltaMs: 2, priceAxisMs: 0, timeAxisMs: 0, depth: true,
    aggregationMs: 0, scaleMs: 0, rasterMs: 0, colorMs: 0, uploadMs: 0, tileSyncMs: 0 });
  assert.equal(p.snapshot()[0]!.otherMs, 2);
});

test("ダミー：ライブ確定列の先の秒を加算し、過去閲覧中も最新約定を保持する", () => {
  const c = new ColumnCache();
  c.startLiveTradeRetention(10_000);
  c.addColumn({ timeUs: 9999 * U, source: "live", bids: emptyLevels(), asks: emptyLevels() });
  c.setRetentionAnchor(9400 * U, 10_000 * U, true, c.latestTimeUs);
  c.addTrades([trade(10_000, 7)]);
  assert.equal(c.tradeCount, 1);
  assert.equal(c.tradeAggregation.cells(10_000 * U, 10_001 * U)[0]!.buy, 7);
  c.setRetentionAnchor(100 * U, 700 * U, false, c.latestTimeUs); // much older than two hours
  c.addTrades([trade(10_001, 4, "sell")]);
  assert.equal(c.tradeCount, 2);
  assert.equal(c.tradeAggregation.cells(10_001 * U, 10_002 * U)[0]!.sell, 4);
  c.addColumn({ timeUs: 10_000 * U, source: "live", bids: emptyLevels(), asks: emptyLevels() });
  assert.equal(c.tradeCount, 2, "depth trimming while browsing must not discard received live trades");
  const g = deltaGeometry(c.tradeAggregation, view(10_000, 10), 300, 100, 10_001 * U, 10_000 * U);
  assert.deepEqual(g.bars.map(b => b.delta), [7, -4]);
});

test("ダミー：ライブ約定は追尾・過去閲覧とも2時間を超えず、逆行で保持窓を戻さない", () => {
  const c = new ColumnCache(); c.startLiveTradeRetention(10_000);
  c.addColumn({ timeUs: 9999 * U, source: "live", bids: emptyLevels(), asks: emptyLevels() });
  c.setRetentionAnchor(9400 * U, 10_000 * U, true, c.latestTimeUs);
  c.addTrades([trade(9999, 3)]);
  c.setRetentionAnchor(0, 600 * U, false, c.latestTimeUs);
  c.addTrades([trade(17_199, 4), trade(17_200, 5), trade(10_001, 6)]);
  assert.deepEqual(c.trades.map(t => [t.tsUs / U, t.size]), [[10_001, 6], [17_199, 4], [17_200, 5]]);
  c.addTrades([trade(17_201, 7), trade(9999, 8)]);
  assert.deepEqual(c.trades.map(t => t.size), [4, 5, 7]);
  c.reset();
  assert.equal(c.tradeCount, 0);
});

test("ダミー：リプレイは既存の再生列上限を維持し、先の秒を保持せず未来の同秒約定を描かない", () => {
  const c = new ColumnCache(); // replay does not call startLiveTradeRetention
  c.addColumn({ timeUs: 100 * U, source: "history", bids: emptyLevels(), asks: emptyLevels() });
  c.setRetentionAnchor(0, 101 * U, true, c.latestTimeUs);
  c.addTrades([trade(100.1, 3), trade(100.9, 20), trade(101, 500)]);
  assert.equal(c.tradeCount, 2);
  const g = deltaGeometry(c.tradeAggregation, view(100, 10), 300, 100, 100.2 * U, 100 * U);
  assert.deepEqual(g.bars.map(b => b.delta), [3]);
  assert.equal(c.trades.some(t => t.tsUs >= 101 * U), false);
});
