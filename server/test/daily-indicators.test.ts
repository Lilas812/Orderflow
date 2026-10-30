import { test } from "node:test";
import assert from "node:assert/strict";
import { VolumeProfile, sessionStartSec } from "../src/vp/state.ts";
import { DailyState } from "../../artifacts/heatmap/src/data/daily.ts";
import { LayerScheduler } from "../../artifacts/heatmap/src/chart/layer-scheduler.ts";
import type { Trade } from "../src/types.ts";
const at = Date.parse("2026-10-30T14:00:00Z") / 1000;
const start = sessionStartSec(at);
const trade = (ts: number, size = 1, side: "buy" | "sell" = "buy", price = 84000, seq = 1): Trade =>
  ({ tsUs: ts * 1e6, recvUs: at * 1e6, seq, price, size, side, contract: "NQZ26" });
const wire = (p: VolumeProfile, after?: number, symbol = "NQ") => ({ ...p.dailyMessage(after), symbol });

test("全日VPと同一入力・閾値前の小口も採用、後着・同内容の別約定・巻戻り", () => {
  const p = new VolumeProfile(at), c = new DailyState("NQ");
  p.add(trade(start + 1, 40)); p.add(trade(at, 10, "sell", 84004, 2));
  p.add(trade(at - 1, 2, "buy", 84000, 3));
  p.add(trade(at - 1, 2, "buy", 84000, 4));
  assert(c.accept(wire(p))); c.series();
  assert.equal(c.snapshot().total, 54); assert.equal(c.snapshot().cvd, 34);
  assert.equal(c.snapshot().vwapTicks, (44 * 84000 + 10 * 84004) / 54);
  const revision = p.revision;
  p.add(trade(start + 2, 7, "sell", 83996, 5)); // older than browser's 2h window
  assert(c.accept(wire(p, revision))); c.series();
  assert.equal(c.snapshot().cvd, 27); assert.equal(c.snapshot().total, 61);
  assert.equal(c.series().at(-1)!.cvd, 27);
  c.accept(wire(p, revision)); c.series();
  assert.equal(c.snapshot().total, p.summary().total); // absolute replacement, not additive
});

test("NQ/GC銘柄・古いrevision・不正/未来の応答を採用しない・限月不明を明示", () => {
  const p = new VolumeProfile(at), nq = new DailyState("NQ"), gc = new DailyState("GC");
  const t = trade(at, 3); delete t.contract; p.add(t);
  assert.equal(gc.accept(wire(p)), false);
  assert(gc.accept(wire(p, undefined, "GC"))); gc.series();
  assert.equal(gc.snapshot().unknownQuantity, 3); assert.equal(gc.snapshot().adjusted, false);
  assert(nq.accept(wire(p))); nq.series();
  assert.equal(nq.accept({ ...wire(p), revision: 0 }), false);
  assert.equal(nq.accept({ ...wire(p), points: [[(at + 1) * 1e6, 1, 0, 84000, 0]] }), false);
  assert.equal(nq.snapshot().total, 3);
});

test("CT17:00 reset と DST（23/25h日）、セッション前・次セッションの未来を除外", () => {
  for (const date of ["2026-03-08T21:59:59Z", "2026-11-01T22:59:59Z"]) {
    const now = Date.parse(date) / 1000, s = sessionStartSec(now), p = new VolumeProfile(now);
    p.add(trade(s - 1, 999)); p.add(trade(s, 4)); p.add(trade(now + 1, 999));
    assert.equal(p.summary().total, 4);
    const next = sessionStartSec(now + 1);
    assert.notEqual(next, s); p.advance(now + 1); p.add(trade(now + 1, 2));
    assert.equal(p.summary().total, 2);
    assert.equal(p.dailyMessage().points.length, 1);
  }
  assert.equal(sessionStartSec(Date.parse("2026-03-08T22:00:00Z") / 1000) -
    sessionStartSec(Date.parse("2026-03-07T23:00:00Z") / 1000), 23 * 3600);
  assert.equal(sessionStartSec(Date.parse("2026-11-01T23:00:00Z") / 1000) -
    sessionStartSec(Date.parse("2026-10-31T22:00:00Z") / 1000), 25 * 3600);
});

test("差分はbounded journalのみ、古いpeerは全量再同期・非描画観測は再集計しない", () => {
  const p = new VolumeProfile(at), c = new DailyState("NQ");
  for (let i = 0; i < 600; i++) p.add(trade(start + i, 1, "buy", 84000, i));
  assert.equal(p.dailyMessage(0).full, true);
  assert.equal(p.dailyMessage(p.revision - 1).points.length, 1);
  c.accept(wire(p));
  assert(c.snapshot().derivedPending); assert.equal(c.snapshot().total, 0);
  c.series(); assert.equal(c.snapshot().total, 600);
});

test("latest Canvas優先、重いheatは次フレーム、再描画要求はcoalesce", () => {
  const q: (() => void)[] = [], calls: string[] = [];
  const s = new LayerScheduler(f => q.push(f), {
    depth: () => calls.push("depth"), trades: () => calls.push("trade"), book: () => calls.push("book"),
    daily: () => calls.push("daily"), after: () => {},
  }, true);
  s.request("all"); s.request("trades");
  q.shift()!(); assert.deepEqual(calls, ["trade", "daily"]);
  q.shift()!(); assert.deepEqual(calls, ["trade", "daily", "depth", "book"]);
  assert.equal(q.length, 0);
});
