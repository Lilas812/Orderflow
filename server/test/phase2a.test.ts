import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { ColumnAggregator } from "../src/aggregate/columns.ts";
import type { Column } from "../src/aggregate/columns.ts";
import { Receiver } from "../src/ingest/receiver.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import { historyColumns, historyTrades } from "../src/history/decode.ts";
import type { HistoryRow } from "../src/history/decode.ts";
import { HistoryClient } from "../src/history/client.ts";
import { Backfill } from "../src/history/backfill.ts";
import { LocalStore, hourOf } from "../src/store/local.ts";
import { encodeColumns, decodeColumns } from "../src/store/binary.ts";
import type { BookSnapshot, Trade } from "../src/types.ts";

const dummy = (tsUs: number, size = 1, source: "live" | "history" = "live"): BookSnapshot => ({
  tsUs, recvUs: tsUs, source, bids: [{ price: 400, size }], asks: [{ price: 401, size }],
});
const column = (tsSec: number, size = 1): Column => ({ tsSec, source: "history", bids: [{ price: 400, size }], asks: [{ price: 401, size }] });
const trade = (sec: number, seq: number): Trade => ({ tsUs: sec * 1_000_000, recvUs: sec * 1_000_000, price: 400, size: 1, side: "buy", seq });
const rows800 = (ts: number, size = 1): HistoryRow[] =>
  ["bid", "ask"].flatMap(side => Array.from({ length: 400 }, (_, i) => ({
    ts, side, level: i + 1, price: side === "bid" ? 100 - i / 4 : 100.25 + i / 4, size, flag: 0,
  })));
const newMetrics = () => new Metrics(() => {});
async function temporary<T>(fn: (store: LocalStore, root: string) => Promise<T>, now = Date.now()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-phase2a-"));
  try { const store = new LocalStore(root, () => now); await store.initialize(); return await fn(store, root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("ダミー：同秒は最後の板、同tsは最後の受信。次秒で確定、空秒は作らない", () => {
  const out: Column[] = [], a = new ColumnAggregator(c => out.push(c));
  a.accept(dummy(10_000_000)); a.accept(dummy(10_000_000, 2));
  assert.equal(out.length, 0);
  a.accept(dummy(13_000_000, 3));
  assert.deepEqual(out.map(c => [c.tsSec, c.bids[0].size]), [[10, 2]]);
  a.finish(); assert.deepEqual(out.map(c => c.tsSec), [10, 13]);
});
test("ダミー：S+3秒の確定と、履歴は秒内の最大tsを使う", () => {
  const out: Column[] = [], a = new ColumnAggregator(c => out.push(c));
  a.accept(dummy(10_100_000, 1, "history")); a.accept(dummy(10_900_000, 2, "history"));
  a.expire(12_999_999); assert.equal(out.length, 0);
  a.expire(13_000_000); assert.equal(out[0].bids[0].size, 2);
  a.accept(dummy(10_900_000, 3)); assert.equal(out.length, 1);
});
test("ダミー：Phase 1採用通知だけ集計に渡り、交差板は列に使わない", () => {
  const out: Column[] = [], a = new ColumnAggregator(c => out.push(c));
  const r = new Receiver(() => {}, { book: b => a.accept(b) });
  const send = (ts: number, bid: number) => r.receive(JSON.stringify({
    type: "book", symbol: "NQ", ts, bids: [[bid, 1]], asks: [[100.25, 1]],
  }), ts * 1_000_000, () => {});
  send(10, 100); send(10, 101); send(12, 100);
  assert.equal(out[0].bids[0].price, 400); assert.equal(r.metrics.counts.rejectedBook, 1);
  a.finish(); assert.deepEqual(out.map(c => c.tsSec), [10, 12]);
});
test("ダミー：履歴800行・同一1600行・異なる1600行は後半、件数と実例", () => {
  const m = newMetrics(), ts = 10_250_000;
  assert.equal(historyColumns(rows800(ts), 10, 11, m)[0].bids.length, 400);
  assert.equal(historyColumns([...rows800(ts), ...rows800(ts)], 10, 11, m)[0].bids[0].size, 1);
  assert.equal(historyColumns([...rows800(ts), ...rows800(ts, 2)], 10, 11, m)[0].bids[0].size, 2);
  assert.equal(m.counts.historyRepeated2Same, 1); assert.equal(m.counts.historyRepeated2Different, 1);
  assert.equal(m.examples.historyRepeated2Different.length, 1);
});
test("ダミー：履歴半開区間・同じ検査・巻き戻り・段の構造違反", () => {
  const m = newMetrics();
  const crossed = rows800(11_000_000); crossed[0].price = 200;
  const result = historyColumns([...rows800(9_999_999), ...rows800(10_000_000), ...crossed, ...rows800(12_000_000)], 10, 12, m);
  assert.deepEqual(result.map(c => c.tsSec), [10]); assert.equal(m.counts.crossedBook, 1);
  assert.equal(historyColumns(rows800(10_000_000).slice(1), 10, 11, m).length, 0);
  historyColumns([...rows800(11_000_000), ...rows800(10_000_000)], 10, 12, m);
  assert.equal(m.counts.bookTimestampRollback, 1);
});
test("ダミー：履歴約定は単位を保持し、内容が同一でも別seqで残す", () => {
  let seq = 0;
  const row = { ts: 10_123_456, price: 100, size: 1, side: "sell" };
  const trades = historyTrades([row, row, { ...row, ts: 11_000_000 }], 10, 11, newMetrics(), () => ++seq);
  assert.equal(trades.length, 2); assert.deepEqual(trades.map(t => t.seq), [1, 2]);
  assert.equal(trades[0].recvUs, 10_123_456); assert.equal(trades[0].price, 400);
});
test("ダミー：バイナリは指定LE形式で往復、非昇順・壊れたレコードは拒否", () => {
  const c = column(100); c.bids[0].price = -10;
  const bytes = encodeColumns([c]); assert.equal(bytes.length, 25);
  assert.equal(bytes.readUInt32LE(0), 100); assert.equal(bytes[4], 1);
  assert.deepEqual(decodeColumns(bytes), [c]);
  assert.throws(() => encodeColumns([column(100), column(99)]));
  assert.throws(() => decodeColumns(bytes.subarray(0, -1)));
  assert.throws(() => encodeColumns([column(1, 1.5)]));
});
test("ダミー：過去向き列を保留後に秒順で保存。gzip読戻し・約定の同内容を保持", async () => {
  const h = hourOf(Math.floor(Date.now() / 1000)) - 3600;
  await temporary(async (store, root) => {
    store.hold(h, h + 3600);
    await store.addColumns([column(h + 200), column(h + 201)]);
    await store.addColumns([column(h + 1), column(h + 2)]);
    await store.addTrades([trade(h + 200, 1), trade(h + 1, 2), trade(h + 1, 3)]);
    await store.releaseHour(h);
    assert.deepEqual((await store.readColumns(h, h + 3600)).map(c => c.tsSec - h), [1, 2, 200, 201]);
    assert.equal((await store.readTrades(h + 1, h + 2)).length, 2);
    const date = new Date(h * 1000).toISOString();
    const gz = path.join(root, "columns/NQ/1s", date.slice(0, 10), date.slice(11, 13) + ".bin.gz");
    assert.equal(decodeColumns(gunzipSync(await fs.readFile(gz))).length, 4);
    await assert.rejects(fs.access(gz.slice(0, -3)));
    assert.ok(store.covered("book", h + 1));
    const reopened = new LocalStore(root); await reopened.initialize();
    assert.ok(reopened.covered("book", h + 1));
    assert.deepEqual(await reopened.readColumns(h, h + 3600), await store.readColumns(h, h + 3600));
  });
});
test("ダミー：既存列は上書きしない・同UTC時間の履歴とライブを整列・gzip約定追記", async () => {
  const h = hourOf(Math.floor(Date.now() / 1000));
  await temporary(async store => {
    await store.addColumns([column(h + 20)]);
    store.hold(h, h + 30);
    await store.addColumns([column(h + 20, 9), column(h + 1)]);
    await store.releaseHour(h);
    await store.addColumns([column(h + 21)]);
    const c = await store.readColumns(h, h + 30);
    assert.deepEqual(c.map(c => c.tsSec - h), [1, 20, 21]); assert.equal(c[1].bids[0].size, 1);
    await store.addTrades([trade(h + 1, 1)]); await store.addTrades([trade(h + 1, 2)]);
    assert.equal((await store.readTrades(h, h + 30)).length, 2);
  });
});
test("ダミー：7日より古い保存だけ削除、検証記録は消さない", async () => {
  const now = Date.now(), old = hourOf(Math.floor(now / 1000)) - 8 * 86400;
  await temporary(async (store, root) => {
    await fs.mkdir(path.join(root, "probe"));
    await fs.writeFile(path.join(root, "probe", "keep.json"), "{}");
    await store.addColumns([column(old)]); await store.addTrades([trade(old, 1)]); await store.flush();
    assert.equal(store.stats.files, 0); assert.equal(await fs.readFile(path.join(root, "probe/keep.json"), "utf8"), "{}");
  }, now);
});
test("ダミー：HTTPはlimit=500000、429 Retry-After後に再開、認証値をログに出さない", async () => {
  const waits: number[] = []; const logs: unknown[] = []; let calls = 0;
  const request: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).searchParams.get("limit"), "500000");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer dummy-key");
    return ++calls === 1 ? new Response("", { status: 429, headers: { "Retry-After": "2" } })
      : Response.json({ book: [], truncated: false });
  };
  const client = new HistoryClient("dummy-key", (e, d) => logs.push({ e, d }), request, async ms => { waits.push(ms); });
  assert.deepEqual(await client.get("book", 10, 70, new AbortController().signal), { rows: [], truncated: false });
  assert.deepEqual(waits, [2000]); assert.equal(client.stats.errors, 1);
  assert.equal(JSON.stringify(logs).includes("dummy-key"), false);
});
test("ダミー：保存済み秒を再取得せず、0行を記録、切詰めを新しい半窓から逐次再取得", async () => {
  const L = Math.floor(Date.now() / 1000), start = L - 10800, calls: [string, number, number][] = [];
  await temporary(async store => {
    for (const kind of ["book", "tick"] as const) store.markCovered(kind, start, L - 2);
    let active = 0;
    const source = { get: async (kind: "book" | "tick", a: number, b: number) => {
      assert.equal(active++, 0); calls.push([kind, a, b]); await Promise.resolve(); active--;
      return { rows: [], truncated: b - a > 1 };
    } };
    let now = (L + 300) * 1000;
    const clock = { now: () => now, wait: async (ms: number) => { now += ms; } };
    const backfill = new Backfill(source, store, newMetrics(), () => 1, () => {}, clock);
    backfill.start(L); await backfill.settled();
    assert.equal(backfill.status.state, "complete"); assert.equal(backfill.status.completedWindows, 180);
    assert.deepEqual(calls.slice(0, 3), [["book", L - 2, L], ["book", L - 1, L], ["book", L - 2, L - 1]]);
    assert.ok(calls.every(([, a]) => a >= L - 2)); assert.ok(store.covered("tick", L - 1));
    const again = new Backfill(source, store, newMetrics(), () => 1, () => {});
    const count = calls.length; again.start(L); await again.settled(); assert.equal(calls.length, count);
  });
});
test("ダミー：1秒窓でもtruncatedなら失敗し、不完全な窓を取得済みにしない", async () => {
  const L = Math.floor(Date.now() / 1000) - 301;
  await temporary(async store => {
    store.markCovered("book", L - 10800, L - 1);
    const source = { get: async () => ({ rows: [], truncated: true }) };
    const backfill = new Backfill(source, store, newMetrics(), () => 1, () => {});
    backfill.start(L); await backfill.settled();
    assert.equal(backfill.status.state, "failed"); assert.equal(backfill.status.lastError, "history_truncated_at_one_second");
    assert.equal(store.covered("book", L - 1), false);
  });
});
