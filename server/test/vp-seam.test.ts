import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pipeline } from "../src/pipeline.ts";
import { LocalStore } from "../src/store/local.ts";
import type { BookSnapshot, Trade } from "../src/types.ts";

test("ダミー：L未確定中の巻き戻り約定を境界で分離し、VP・範囲・保存に一度だけ保持", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-vp-seam-"));
  const L = Math.floor(Date.now() / 1000), U = 1_000_000;
  const p = new Pipeline("dummy-no-network", () => 999, () => {});
  const store = new LocalStore(root);
  // Exercise the real pipeline/aggregator callback without touching the real
  // store, timers, or provider. No production dependency/configuration changes.
  Object.defineProperty(p, "store", { value: store });
  t.mock.method(p.backfill, "start", () => {});
  t.mock.method(p.vpHistory, "start", () => {});
  const row = (offsetUs: number, seq: number, size: number, side: "buy" | "sell" = "buy"): Trade =>
    ({ tsUs: L * U + offsetUs, recvUs: L * U + seq, seq, price: 400, size, side });
  const initial = [row(200000, 1, 3), row(-1, 2, 7, "sell"), row(0, 3, 2),
    row(100000, 4, 5, "sell"), row(-200000, 5, 11), row(0, 6, 13, "sell")];
  const live = [initial[0]!, initial[2]!, initial[3]!, initial[5]!];
  const historical = [initial[1]!, initial[4]!];
  const book = (second: number): BookSnapshot => ({ tsUs: second * U, recvUs: second * U, source: "live",
    bids: [{ price: 400, size: 1 }], asks: [{ price: 401, size: 1 }] });
  try {
    await store.initialize();
    for (const trade of initial) p.trade(trade);
    assert.equal(p.vp.summary().total, 0, "unknown L must not count yet");
    p.book(book(L)); assert.equal(p.status().seamL, null);
    p.book(book(L + 1));
    assert.equal(p.status().seamL, L);
    assert.deepEqual(p.vp.message().levels, [[400, 5, 18]]);
    assert.deepEqual((await p.readRange(L, L + 2)).trades, live, "buffered initial range has no loss or duplicate");
    p.book(book(L + 2));
    assert.deepEqual(p.vp.message().levels, [[400, 5, 18]], "later columns must not add initial batch twice");
    const after = row(50000, 7, 17, "sell"); p.trade(after);
    const lateHistory = row(-10, 8, 19);
    p.trade(lateHistory); // Late timestamp crossing L is history-owned.
    assert.deepEqual(p.vp.message().levels, [[400, 5, 35]]);
    // Model the history side once; the live path did not count these rows.
    for (const trade of [...historical, lateHistory]) p.vp.add(trade);
    assert.deepEqual(p.vp.message().levels, [[400, 35, 42]]);
    await p.stop();
    assert.deepEqual(await store.readTrades(L, L + 3), [...live, after]);
    assert.deepEqual((await p.readRange(L, L + 3)).trades, [...live, after],
      "after flush the same range is identical to the buffered range");
  } finally { await p.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
