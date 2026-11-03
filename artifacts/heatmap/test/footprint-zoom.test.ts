import { test } from "node:test";
import assert from "node:assert/strict";
import { FootprintStore, DISPLAY_TIMEFRAMES } from "../src/footprint/model.ts";
import { adaptTime, zoomTimeAt, xToSec, zoomPriceAt, priceGroupTicks, clampView, cellWidth, type FpView } from "../src/footprint/view.ts";
import { groupPriceRows } from "../src/footprint/rows.ts";
import { zoomPriceAt as heatZoom } from "../src/chart/coordinates.ts";
import { bookGroupTicks } from "../src/chart/book-numbers.ts";
import type { Trade } from "../src/domain.ts";

test("時間足は最小選択を下回らず、28pxセルを保ち、15分で縮小停止し戻る", () => {
  for (const selected of [5, 15, 30, 60] as const) {
    let v: FpView = { endSec: 3000, barW: 92, rowH: 16, centerPrice: 100, follow: false };
    for (let i = 0; i < 45; i++) {
      v = zoomTimeAt(v, .8, 234, selected, 800);
      assert.ok(v.displayTf! >= selected);
      assert.ok(cellWidth(v.barW) >= 28 - 1e-8);
      const finer = DISPLAY_TIMEFRAMES.filter(t => t >= selected && t < v.displayTf!);
      assert.ok(finer.every(t => cellWidth(v.barW * t / v.displayTf!) < 28 + 1e-8));
    }
    assert.equal(v.displayTf, 900);
    assert.ok(Math.abs(v.barW - 65) < 1e-7);
    for (let i = 0; i < 50; i++) v = zoomTimeAt(v, 1.25, 234, selected, 800);
    assert.equal(v.displayTf, selected);
  }
});

test("自動足切替・clamp・ピンチ中点の平行移動で時刻固定、後戻り時も保つ", () => {
  let v: FpView = { endSec: 5000, barW: 66, rowH: 16, centerPrice: 100, follow: false };
  for (const factor of [.95, .4, .4, .4, .4, .01, 3, 10, 30]) {
    const anchor = xToSec(257, v, v.displayTf ?? 5, 800);
    let n = zoomTimeAt(v, factor, 257, 5, 800);
    n = clampView(n, n.displayTf!, null);
    assert.ok(Math.abs(xToSec(257, n, n.displayTf!, 800) - anchor) < .001);
    n.endSec += (257 - 300) * n.displayTf! / n.barW;
    assert.ok(Math.abs(xToSec(300, n, n.displayTf!, 800) - anchor) < .001);
    v = n;
  }
  assert.equal(adaptTime({ ...v, displayTf: 900, barW: 65 }, 60).displayTf, 900);
});

test("全自動足は秒基礎から枚数・delta・OHLC・POC一致、履歴補正を再加算しない", () => {
  const rows: Trade[] = Array.from({ length: 900 }, (_, s) => ({
    tsUs: s * 1e6, recvUs: s * 1e6 + 1, seq: s,
    price: 100 + s % 17, size: 1 + s % 3, side: s % 7 === 0 ? "unknown" : s % 2 ? "buy" : "sell", contract: "GCZ6",
  }));
  const store = new FootprintStore(); store.hello("isolated", 900); store.appendLive(rows);
  for (const tf of DISPLAY_TIMEFRAMES) {
    store.setTimeframe(tf);
    for (const { startSec, group } of store.bars(0, 900)) {
      const b = group.get("GCZ6")!, source = rows.filter(t => t.tsUs >= startSec * 1e6 && t.tsUs < (startSec + tf) * 1e6);
      assert.equal(b.volume, source.reduce((n, t) => n + t.size, 0));
      assert.equal(b.delta, source.reduce((n, t) => n + (t.side === "buy" ? t.size : t.side === "sell" ? -t.size : 0), 0));
      assert.deepEqual([b.open, b.close, b.high, b.low], [source[0]!.price, source.at(-1)!.price, Math.max(...source.map(t => t.price)), Math.min(...source.map(t => t.price))]);
      const qty = new Map<number, number>();
      for (const t of source) qty.set(t.price, (qty.get(t.price) ?? 0) + t.size);
      const poc = [...qty].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
      assert.equal(b.poc, poc);
    }
    store.beginRange(1, 0, 900); store.appendRange(1, rows);
    store.commitRange(1, { coverage: [[0, 900]], gaps: [{ startSec: 301, endSec: 302, reason: "known" }], noData: [] });
    assert.equal(store.bars(0, 900).reduce((n, b) => n + (b.group.get("GCZ6")?.volume ?? 0), 0), rows.reduce((n, t) => n + t.size, 0));
    assert.equal(store.stateOf(300, 300 + Math.max(tf, 5), 900), "gap");
  }
});

test("価格行の最小幅・負価格を含む倍数・Nを含むPOC同数高価格・OHLC不変", () => {
  for (const h of [120, 300, 480, 800]) {
    const v = zoomPriceAt({ endSec: 1, barW: 92, rowH: 16, centerPrice: 100, follow: false }, 1e-8, h / 3, h);
    assert.equal(h / v.rowH, 8000);
    assert.ok(priceGroupTicks(v.rowH) * v.rowH >= 12);
    assert.ok(bookGroupTicks(h / 8000) * h / 8000 >= 11);
    assert.equal(h / clampView({ ...v, follow: true }, 5, 1000, h).rowH, 8000);
  }
  for (const g of [1, 2, 4, 5, 10, 20, 40, 50, 100, 200, 400, 800]) assert.equal(priceGroupTicks(12 / g), g);
  const s = new FootprintStore(); s.appendLive([
    { tsUs: 0, recvUs: 1, seq: 1, price: -1, size: 10, side: "buy" },
    { tsUs: 1, recvUs: 2, seq: 2, price: 0, size: 1, side: "sell" },
    { tsUs: 2, recvUs: 3, seq: 3, price: 1, size: 9, side: "unknown" },
  ]);
  const b = s.bars(0, 5)[0]!.group.get("UNKNOWN")!, before = JSON.stringify(b);
  const grouped = groupPriceRows(b, 4);
  assert.deepEqual(grouped.rows, [{ price: -4, buy: 10, sell: 0, undirected: 0 }, { price: 0, buy: 0, sell: 1, undirected: 9 }]);
  assert.equal(grouped.poc, 0); assert.equal(JSON.stringify(b), before);
});

test("HEATMAP価格zoomは8〜8000ティック、anchor固定", () => {
  const v = { startUs: 0, durationSec: 300, centerPriceTicks: 84000, priceSpanTicks: 1600 };
  for (const f of [1e-8, 5, 1e8]) {
    const n = heatZoom(v, 84100, f);
    assert.ok(n.priceSpanTicks >= 8 && n.priceSpanTicks <= 8000);
    assert.equal((84100 - n.centerPriceTicks) / n.priceSpanTicks, (84100 - v.centerPriceTicks) / v.priceSpanTicks);
  }
});
