import assert from "node:assert/strict";
import test from "node:test";
import { FootprintStore, MAX_TRADES, buildBar, subtractRanges, mergeRanges, type FpTrade } from "../src/footprint/model.ts";
import { FootprintClient, footprintSocketUrl, type FpEnv } from "../src/footprint/client.ts";
import { clampView, detailMode, priceToY, yToPrice, zoomTimeAt, cellWidth, MIN_CELL_W } from "../src/footprint/view.ts";
import { decodeTrades } from "../src/data/protocol.ts";

const U = 1_000_000;
let seq = 0;
const tr = (sec: number, price: number, size: number, side: "buy" | "sell", contract?: string): FpTrade =>
  ({ tsUs: Math.round(sec * U), recvUs: 5_000_000_000 + seq, seq: seq++, price, size, side, ...(contract ? { contract } : {}) });
const bar = (s: FootprintStore, start: number, contract = "UNKNOWN") => s.bars(start, start + s.timeframe)[0]!.group.get(contract) ?? null;

test("ダミー：価格別売買・総量・デルタ・OHLC・POC（同数は高い価格）", () => {
  const s = new FootprintStore();
  s.appendLive([tr(100.1, 10, 3, "buy"), tr(101, 12, 2, "sell"), tr(102, 11, 4, "buy"), tr(103, 12, 3, "buy"), tr(104.9, 9, 5, "sell")]);
  const b = bar(s, 100)!;
  assert.deepEqual([...b.prices], [9, 10, 11, 12]);
  assert.deepEqual([...b.buy], [0, 3, 4, 3]);
  assert.deepEqual([...b.sell], [5, 0, 0, 2]);
  assert.equal(b.volume, 17); assert.equal(b.delta, 10 - 7);
  assert.deepEqual([b.open, b.high, b.low, b.close], [10, 12, 9, 9]);
  assert.equal(b.poc, 12); // 10:3, 11:4, 12:5, 9:5 -> tie 5, higher price 12
});

test("ダミー：5秒足12本の合計が同じ1分足と一致、境界は半開区間", () => {
  const s = new FootprintStore(), rows: FpTrade[] = [];
  for (let i = 0; i < 240; i++) rows.push(tr(600 + i * 0.25, 100 + (i % 7), 1 + (i % 3), i % 2 ? "buy" : "sell"));
  rows.push(tr(660, 100, 9, "buy")); // exactly the next minute
  s.appendLive(rows);
  let buy = 0, sell = 0;
  for (let k = 0; k < 12; k++) { const b = bar(s, 600 + k * 5)!; buy += b.buyTotal; sell += b.sellTotal; }
  s.setTimeframe(60);
  const m = bar(s, 600)!;
  assert.equal(m.buyTotal, buy); assert.equal(m.sellTotal, sell);
  assert.equal(bar(s, 660)!.volume, 9);
});

test("ダミー：内容が同じ別約定は両方数え、同一配信IDは一度だけ", () => {
  const s = new FootprintStore();
  const a = tr(10, 50, 2, "buy"), b = { ...a, seq: a.seq + 1000, recvUs: a.recvUs + 1000 };
  s.appendLive([a, b, a]);
  assert.equal(bar(s, 10)!.buyTotal, 4);
  assert.equal(s.tradeCount, 2);
});

test("ダミー：履歴の旧seqを現世代liveと並べ替えず、同秒の入力順序を保持", () => {
  const s = new FootprintStore(); s.hello("new", 1000);
  const old = { ...tr(20, 70, 1, "buy"), seq: 999 };
  const live = { ...tr(20, 71, 2, "sell"), seq: 1 };
  s.appendLive([live]); s.beginRange(1, 20, 21); s.appendRange(1, [old]);
  s.commitRange(1, { coverage: [[20, 21]], gaps: [], noData: [] });
  const b = bar(s, 20)!;
  assert.equal(b.open, 70); assert.equal(b.close, 71); assert.equal(b.volume, 3);
});

test("ダミー：取得中の一時約定も上限を超えて保持しない", () => {
  const s = new FootprintStore(); s.beginRange(1, 20, 21);
  assert.throws(() => s.appendRange(1, Array(MAX_TRADES + 1).fill(tr(20, 70, 1, "buy"))), /capacity/);
  s.abortRange(1, "footprint_range_capacity");
  assert.equal(s.tradeCount, 0); assert.equal(s.stateOf(20, 21, 30), "gap");
});

test("ダミー：履歴置換は単純加算せず、ライブとの重複・遅着を一度だけ", () => {
  const s = new FootprintStore();
  s.hello("g1", 1000);
  const old = tr(20, 70, 5, "buy"), live = tr(21, 71, 1, "sell");
  s.appendLive([old, live]);
  s.beginRange(1, 15, 25);
  const late = tr(22, 72, 3, "sell");
  s.appendLive([late]); // arrives while request pending
  s.appendRange(1, [old, live, tr(23, 73, 4, "buy")]);
  s.commitRange(1, { coverage: [[15, 25]], gaps: [], noData: [] });
  const b = bar(s, 20)!;
  assert.equal(b.buyTotal, 5 + 4); assert.equal(b.sellTotal, 1 + 3);
  // repeat the same range: still not doubled
  s.beginRange(2, 15, 25); s.appendRange(2, [old, live, late, tr(23.5, 73, 4, "buy")]);
  s.commitRange(2, { coverage: [[15, 25]], gaps: [], noData: [] });
  assert.equal(bar(s, 20)!.volume, 5 + 1 + 3 + 4); // prior history row replaced, not added
  assert.equal(s.stateOf(15, 20, 30), "recorded");
});

test("ダミー：未報告・既知の未取得は0扱いにせずgap、無約定は確認済みとして区別", () => {
  const s = new FootprintStore();
  s.hello("g", 10_000);
  s.beginRange(1, 100, 130);
  s.commitRange(1, { coverage: [[100, 110]], gaps: [{ startSec: 110, endSec: 120, reason: "upstream_gap" }], noData: [] });
  assert.equal(s.stateOf(100, 105, 9_000), "recorded");
  assert.equal(s.stateOf(110, 115, 9_000), "gap");
  assert.deepEqual(s.gapReasons(120, 130), ["unreported"]);
  s.beginRange(2, 200, 210); s.commitRange(2, { coverage: [], gaps: [], noData: [[200, 210]] });
  assert.equal(s.stateOf(200, 205, 9_000), "empty");
  assert.equal(s.stateOf(300, 305, 9_000), "unloaded");
  s.clearFailures(100, 130);
  assert.deepEqual(s.missing(100, 130, 1_000), [[110, 130]]);
});

test("ダミー：世代変更で全消去、同世代の再接続は保持して切断区間を未取得に", () => {
  const s = new FootprintStore();
  s.hello("a", 100); s.appendLive([tr(101.5, 1, 1, "buy")]);
  s.disconnect(150);
  s.hello("a", 200);
  assert.equal(s.tradeCount, 1);
  assert.deepEqual(s.missing(100, 210, 210), [[100, 101], [150, 201]]);
  s.hello("b", 300);
  assert.equal(s.tradeCount, 0);
});

test("ダミー：限月ごとに別系列、不明限月は UNKNOWN", () => {
  const s = new FootprintStore();
  s.appendLive([tr(10, 100, 1, "buy", "GCJ6"), tr(11, 300, 2, "sell", "GCM6"), tr(12, 200, 3, "buy")]);
  const g = s.bars(10, 15)[0]!.group;
  assert.deepEqual([...g.keys()].sort(), ["GCJ6", "GCM6", "UNKNOWN"]);
  assert.equal(g.get("GCJ6")!.volume, 1); assert.equal(g.get("GCM6")!.high, 300);
});

test("ダミー：容量上限超過で古い秒を破棄し明示的に不完全", () => {
  const s = new FootprintStore();
  s.hello("g", 0);
  const rows: FpTrade[] = [];
  for (let i = 0; i < MAX_TRADES + 10; i++) rows.push(tr(1 + Math.floor(i / 100), 10, 1, "buy"));
  s.appendLive(rows);
  assert.ok(s.tradeCount <= MAX_TRADES);
  assert.equal(s.stateOf(1, 2, 100_000), "overflow");
  assert.equal(s.evictions, 1);
});

test("ダミー：range helpers", () => {
  assert.deepEqual(mergeRanges([[5, 8], [1, 3], [3, 4]]), [[1, 4], [5, 8]]);
  assert.deepEqual(subtractRanges([[0, 10]], [[2, 3], [5, 12]]), [[0, 2], [3, 5]]);
  assert.equal(buildBar("X", 0, 5, []), null);
});

test("ダミー：decodeTrades は任意のcontractを保持し、無ければ付けない", () => {
  const [a, b] = decodeTrades([{ tsUs: 1, recvUs: 2, seq: 3, price: 4, size: 1, side: "buy", contract: "GCJ6" },
    { tsUs: 1, recvUs: 2, seq: 4, price: 4, size: 1, side: "sell" }]);
  assert.equal(a!.contract, "GCJ6"); assert.equal("contract" in b!, false);
});

test("view：数字表示の閾値、価格⇔y、ズーム固定点", () => {
  assert.equal(detailMode({ barW: 92, rowH: 16 }), true);
  assert.equal(detailMode({ barW: 40, rowH: 16 }), false);
  assert.ok(cellWidth(92) >= MIN_CELL_W);
  const v = { endSec: 1000, barW: 50, rowH: 10, centerPrice: 500, follow: false };
  assert.equal(yToPrice(priceToY(503, v, 400), v, 400), 503);
  const z = zoomTimeAt(v, 2, 300, 5, 600);
  assert.ok(Math.abs((z.endSec - ((600 - 300) / z.barW) * 5) - (v.endSec - (300 / 50) * 5)) < 1e-9);
  assert.equal(clampView({ ...v, barW: 1 }, 5, null).barW, 65);
});

class FakeSocket {
  readyState = 1; sent: string[] = []; onopen = null; onmessage = null; onerror = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
}
function harness(now = 10_000_000) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const env: FpEnv = { createSocket: url => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s as never; },
    setTimeout: () => 0, clearTimeout: () => {}, now: () => now };
  const store = new FootprintStore();
  const client = new FootprintClient("NQ", store, { onData() {}, onState() {} }, { protocol: "http:", host: "h" }, env);
  return { client, store, sockets, urls };
}
const hello = (gen: string, sec: number) => JSON.stringify({ type: "hello", symbol: "NQ", tickSize: 0.25, serverTimeUs: sec * U, mode: "live", savedRange: null, generation: gen });

test("ダミー client：URL、op:range は3600秒以下に分割、旧reqIdの遅延応答は無視", () => {
  assert.equal(footprintSocketUrl({ protocol: "https:", host: "x" }, "GC"), "wss://x/api/ws?view=footprint&symbol=GC");
  const { client, store, sockets } = harness();
  client.start();
  client.handle(hello("g1", 10_000));
  client.setVisible(10_000 - 5_000, 10_010);
  const first = JSON.parse(sockets[0]!.sent[0]!);
  assert.equal(first.op, "range");
  assert.ok(first.toSec - first.fromSec <= 3_600);
  client.handle(JSON.stringify({ type: "rangeTrades", reqId: 999, trades: [{ tsUs: first.fromSec * U, recvUs: 1, seq: 1, price: 1, size: 7, side: "buy" }] }));
  client.handle(JSON.stringify({ type: "rangeTrades", reqId: first.reqId, trades: [{ tsUs: first.fromSec * U, recvUs: 1, seq: 1, price: 1, size: 2, side: "buy" }] }));
  client.handle(JSON.stringify({ type: "rangeDone", reqId: first.reqId, fromSec: first.fromSec, toSec: first.toSec, trades: 1,
    footprint: { coverage: [[first.fromSec, first.toSec]], gaps: [], noData: [], quality: "recorded_not_guaranteed" } }));
  assert.equal(store.tradeCount, 1);
  assert.equal(client.quality, "recorded_not_guaranteed");
  // generation change drops data and pending
  client.handle(hello("g2", 10_001));
  assert.equal(store.tradeCount, 0); assert.equal(store.generation, "g2");
});

test("リプレイ client：再接続URLに位置を渡し、カーソルより先の約定を採らず、live復帰で共有状態を切る", () => {
  const { client, store, sockets, urls } = harness();
  client.startReplay(100, 5, true, 100_500_000);
  const replayUrl = new URL(urls[0]!);
  assert.equal(replayUrl.searchParams.get("view"), "footprint");
  assert.equal(replayUrl.searchParams.get("mode"), "replay");
  assert.equal(replayUrl.searchParams.get("from"), "100");
  assert.equal(replayUrl.searchParams.get("headUs"), "100500000");
  assert.equal(replayUrl.searchParams.get("speed"), "5");
  assert.equal(replayUrl.searchParams.get("paused"), "1");
  client.handle(JSON.stringify({ type: "hello", symbol: "NQ", tickSize: .25, columnSeconds: 1,
    serverTimeUs: 999_000_000, mode: "replay", savedRange: { fromSec: 100, toSec: 200 },
    generation: "server-generation", replayControlled: true, replayFromSec: 100,
    replayGeneration: 1, replayHeadUs: 100_500_000 }));
  assert.equal(client.nowSec(), 100);
  assert.equal(store.liveOpenSec, null);
  client.handle(JSON.stringify({ type: "trades", replayGeneration: 1, replayHeadUs: 100_750_000,
    trades: [tr(100.6, 50, 2, "buy"), tr(100.8, 51, 3, "sell")] }));
  assert.equal(store.tradeCount, 1);
  assert.equal(store.latest?.price, 50);
  const state = JSON.stringify({ type: "replayState", replayGeneration: 1, replayHeadUs: 100_750_000,
    state: "paused", positionUs: 100_750_000, speed: 5, fromSec: 100, toSec: 200 });
  client.handle(state);
  assert.equal(client.replayPositionUs, 100_750_000);
  assert.equal(client.replayControl("step", 1), true);
  assert.equal(JSON.parse(sockets[0]!.sent.at(-1)!).action, "step");
  client.returnLive();
  assert.equal(client.isReplay, false);
  assert.equal(store.tradeCount, 0);
  assert.equal(new URL(urls[1]!).searchParams.has("mode"), false);
  client.stop();
});

test("ダミー client：不正なhello（generation無し・別銘柄）は受け付けない", () => {
  const { client, store } = harness();
  client.start();
  client.handle(JSON.stringify({ type: "hello", symbol: "NQ", tickSize: 0.25, serverTimeUs: 1, mode: "live", savedRange: null }));
  assert.equal(client.connected, false);
  client.handle(JSON.stringify({ type: "hello", symbol: "GC", tickSize: 0.1, serverTimeUs: 1, mode: "live", savedRange: null, generation: "x" }));
  assert.equal(client.connected, false);
  client.handle(JSON.stringify({ type: "trades", trades: [{ tsUs: 1, recvUs: 1, seq: 1, price: 1, size: 1, side: "buy" }] }));
  assert.equal(store.tradeCount, 0);
});

test("ダミー client：初回取得中のbackfill完了をrangeDone後に一度だけ再確認", () => {
  const { client, store, sockets } = harness();
  client.start(); client.handle(hello("g", 10_000)); client.setVisible(9900, 9950);
  const first = JSON.parse(sockets[0]!.sent[0]!);
  client.handle(JSON.stringify({ type: "status", status: { phase2a: { backfill: {
    state: "complete", startedAtUs: 1, finishedAtUs: 2, startSec: 9900, endSec: 9950,
  } } } }));
  const done = (r: typeof first) => ({ type: "rangeDone", reqId: r.reqId,
    fromSec: r.fromSec, toSec: r.toSec, trades: 0,
    footprint: { coverage: [[9900, 9950]], gaps: [], noData: [] } });
  client.handle(JSON.stringify(done(first)));
  assert.equal(sockets[0]!.sent.length, 2);
  const second = JSON.parse(sockets[0]!.sent[1]!);
  assert.deepEqual([second.fromSec, second.toSec], [9900, 9950]);
  client.handle(JSON.stringify(done(second)));
  assert.equal(sockets[0]!.sent.length, 2); assert.equal(store.tradeCount, 0);
});
