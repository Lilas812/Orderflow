import assert from "node:assert/strict";
import test from "node:test";
import { TradeAggregator, CurrentTradeState } from "../src/data/trade-aggregate.ts";
import { ColumnCache } from "../src/data/cache.ts";
import type { Trade } from "../src/domain.ts";
const U = 1_000_000;
let seq = 0;
const row = (seconds: number, price = 100, size = 1, side: "buy" | "sell" = "buy"): Trade =>
  ({ tsUs: Math.round(seconds * U), recvUs: 1_000_000_000 + seq, seq: seq++, price, size, side });

test("ダミー：秒×1tick、両side、内容同一の別約定を残す", () => {
  const a = new TradeAggregator();
  a.appendLive([row(10.1, 100, 6), row(10.1, 100, 6), row(10.3, 100, 7, "sell"), row(11.1, 101)]);
  assert.deepEqual(a.cells(10 * U, 11 * U), [{ secondUs: 10 * U, price: 100, buy: 12, sell: 7 }]);
  assert.equal(a.size, 4);
});
test("ダミー：同秒で時刻が逆行しても受信順の最後の価格、無約定秒はcarry", () => {
  const a = new TradeAggregator();
  a.appendLive([row(10.9, 101), row(10.1, 99), row(13.1, 103)]);
  assert.deepEqual(a.lastPrices(8 * U, 15 * U), [
    { secondUs: 10 * U, price: 99 }, { secondUs: 11 * U, price: 99 },
    { secondUs: 12 * U, price: 99 }, { secondUs: 13 * U, price: 103 }, { secondUs: 14 * U, price: 103 },
  ]);
  assert.equal(a.latestAt(10.5 * U)?.price, 99);
  assert.equal(a.latestAt(9 * U), null);
});
test("ダミー：rangeDoneまで旧集計を保ち、再取得は置換、重複配信IDだけ消す", () => {
  const a = new TradeAggregator(), old = row(10, 100, 12), replacement = row(10.2, 102, 20);
  a.appendLive([old, row(12)]);
  a.beginRange(1, 10 * U, 11 * U); a.appendRangeChunk(1, [replacement, replacement]);
  assert.equal(a.cells(10 * U, 11 * U)[0]!.price, 100);
  a.commitRange(1);
  assert.equal(a.size, 2); assert.equal(a.cells(10 * U, 11 * U)[0]!.buy, 20);
  a.beginRange(2, 10 * U, 11 * U); a.appendRangeChunk(2, [replacement]); a.commitRange(2);
  assert.equal(a.size, 2); assert.equal(a.cells(10 * U, 11 * U)[0]!.buy, 20);
});
test("ダミー：rangeと同時に届いたliveを失わず、同一IDは二重計上しない", () => {
  const a = new TradeAggregator(), before = row(10, 101, 12), live = row(10.1, 99, 13);
  a.appendLive([before]); a.beginRange(1, 10 * U, 11 * U);
  a.appendLive([live]); a.appendRangeChunk(1, [before, live]); a.commitRange(1);
  assert.equal(a.size, 2); assert.equal(a.lastPrices(10 * U, 11 * U)[0]!.price, 99);
  a.beginRange(2, 10 * U, 11 * U); a.appendRangeChunk(2, [row(10, 900)]);
  a.abortRange(2); assert.equal(a.size, 2);
});
test("ダミー：初期L前後の巻き戻り約定をrangeとliveで重ねても、別IDは保持し同一IDは一度だけ", () => {
  const a = new TradeAggregator(), L = 100;
  const trades = [row(L + 0.2, 400, 3), row(L - 0.000001, 400, 7, "sell"),
    row(L, 400, 2), row(L + 0.1, 400, 5, "sell"), row(L - 0.2, 400, 11),
    row(L, 400, 13, "sell")];
  a.beginRange(0, (L - 1) * U, (L + 1) * U);
  a.appendLive(trades);
  a.appendRangeChunk(0, trades);
  a.commitRange(0);
  assert.equal(a.size, 6);
  assert.deepEqual(a.cells((L - 1) * U, (L + 1) * U), [
    { secondUs: L * U, price: 400, buy: 5, sell: 18 },
    { secondUs: (L - 1) * U, price: 400, buy: 11, sell: 7 },
  ]);
  a.beginRange(1, (L - 1) * U, (L + 1) * U);
  a.appendRangeChunk(1, trades); a.commitRange(1);
  assert.equal(a.size, 6, "a repeated range replacement cannot double the aggregate");
});
test("ダミー：列と同じ2h保持範囲・半開区間、範囲取り直しでも外へ戻さない", () => {
  const cache = new ColumnCache();
  cache.setRetentionAnchor(10_000 * U, 17_200 * U, false, null);
  cache.addTrades([row(9_999.99), row(10_000), row(17_199.99), row(17_200)]);
  assert.equal(cache.tradeCount, 2);
  cache.tradeAggregation.beginRange(1, 9_900 * U, 10_100 * U);
  cache.tradeAggregation.appendRangeChunk(1, [row(9_999), row(10_000)]);
  cache.tradeAggregation.commitRange(1);
  assert.equal(cache.tradeCount, 2);
  cache.setRetentionAnchor(20_000 * U, 27_200 * U, false, null);
  assert.equal(cache.tradeCount, 0);
});
test("ダミー：replay cutoffより未来の同秒価格・枚数を出さない", () => {
  const a = new TradeAggregator();
  a.appendLive([row(10.1, 100, 12), row(10.8, 200, 30)]);
  assert.deepEqual(a.cells(10 * U, 11 * U, 10.5 * U), [{ secondUs: 10 * U, price: 100, buy: 12, sell: 0 }]);
  assert.equal(a.lastPrices(10 * U, 11 * U, 10.5 * U)[0]!.price, 100);
  assert.equal(a.latestAt(10.5 * U)?.price, 100);
});
test("ダミー：現在値はviewport/保持とは独立し、受信順・replay時刻を守る", () => {
  const current = new CurrentTradeState(), cache = new ColumnCache();
  const trades = [row(10.9, 101), row(10.1, 99), row(11.2, 200)];
  current.accept(trades, 11 * U); assert.equal(current.trade?.price, 99);
  cache.setRetentionAnchor(20_000 * U, 27_200 * U, false, null);
  assert.equal(current.trade?.price, 99);
  current.accept([trades[2]!]); assert.equal(current.trade?.price, 200);
  current.accept([row(10.9, 201)]); assert.equal(current.trade?.price, 201, "current follows receive order across timestamp rollback too");
  current.reset(); assert.equal(current.trade, null);
});
