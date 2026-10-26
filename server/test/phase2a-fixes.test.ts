import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gunzipSync } from "node:zlib";
import { historyColumns, historyTrades } from "../src/history/decode.ts";
import type { HistoryRow } from "../src/history/decode.ts";
import { HistoryClient } from "../src/history/client.ts";
import { Backfill } from "../src/history/backfill.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import { LocalStore } from "../src/store/local.ts";

const metrics = () => new Metrics(() => {});
const rows800 = (ts: number, size = 1): HistoryRow[] =>
  ["bid", "ask"].flatMap(side => Array.from({ length: 400 }, (_, i) => ({
    ts, side, level: i + 1, price: side === "bid" ? 100 - i / 4 : 100.25 + i / 4, size, flag: 0,
  })));
async function temporary(fn: (store: LocalStore, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-phase2a-fixes-"));
  try { const store = new LocalStore(root); await store.initialize(); await fn(store, root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("ダミー：履歴逆行約定を全件採用しseq順でgzip保存・読戻し、ts順に並べ替えない", async () => {
  const sec = Math.floor(Date.now() / 1000) - 3600;
  const m = metrics(); let seq = 0;
  const input = [sec * 1e6 + 30, sec * 1e6 + 10, sec * 1e6 + 20]
    .map(ts => ({ ts, price: 100, size: 1, side: "buy" }));
  const trades = historyTrades(input, sec, sec + 1, m, () => ++seq);
  assert.equal(m.counts.tradeTimestampRollback, 1);
  assert.equal(m.counts.rejectedTrade, 0);
  assert.deepEqual(trades.map(t => t.tsUs), input.map(r => r.ts));
  await temporary(async (store, root) => {
    store.hold(sec, sec + 1);
    await store.addTrades(trades);
    await store.flush();
    assert.deepEqual(await store.readTrades(sec, sec + 1), trades);
    const date = new Date(sec * 1000).toISOString();
    const contents = gunzipSync(await fs.readFile(path.join(root, "trades/NQ", date.slice(0, 10), date.slice(11, 13) + ".jsonl.gz")));
    assert.deepEqual(contents.toString().trim().split("\n").map(s => JSON.parse(s).tsUs), input.map(r => r.ts));
  });
});

for (const n of [2, 3]) for (const same of [true, false]) {
  test(`ダミー：800×${n} ${same ? "同じ" : "違う"}、最後の組を採用しN別件数・実例`, () => {
    const m = metrics();
    const chunks = Array.from({ length: n }, (_, i) => rows800(10_250_000, same ? 1 : i + 1));
    const result = historyColumns(chunks.flat(), 10, 11, m);
    assert.equal(result[0].bids[0].size, same ? 1 : n);
    const key = `historyRepeated${n}${same ? "Same" : "Different"}`;
    assert.equal(m.counts[key], 1); assert.equal(m.examples[key].length, 1);
  });
}
test("ダミー：800倍数でない・前の組が不完全・最後の組が不完全、全体を拒否", () => {
  for (const input of [
    rows800(10_250_000).slice(1),
    [...rows800(10_250_000).map((r, i) => i === 1 ? { ...r, level: 1 } : r), ...rows800(10_250_000)],
    [...rows800(10_250_000), ...rows800(10_250_000).map((r, i) => i === 2 ? { ...r, side: "unknown" } : r)],
  ]) {
    const m = metrics();
    assert.deepEqual(historyColumns(input, 10, 11, m), []);
    assert.equal(m.counts.rejectedBook, 1); assert.equal(m.counts.historyInvalidGroups, 1);
  }
});
test("ダミー：過去板を拒否し、約定の巻き戻りとは別件数", () => {
  const m = metrics();
  historyColumns([...rows800(11_250_000), ...rows800(10_250_000)], 10, 12, m);
  assert.equal(m.counts.bookTimestampRollback, 1);
  assert.equal(m.counts.tradeTimestampRollback, 0);
  assert.equal(m.counts.rejectedBook, 1);
});

test("ダミー：通信/5xxを合計3回失敗した窓は欠け、次の窓へ。60秒待ち2回", async () => {
  const L = Math.floor(Date.now() / 1000); let now = (L + 300) * 1000;
  const waits: number[] = [], calls: number[] = []; let failures = 0;
  await temporary(async store => {
    store.markCovered("book", L - 10800, L - 120);
    store.markCovered("tick", L - 10800, L);
    const request: typeof fetch = async input => {
      const start = Number(new URL(String(input)).searchParams.get("start")); calls.push(start);
      if (start === L - 60) {
        if (++failures === 2) throw new TypeError("dummy network failure");
        return new Response("", { status: 503, headers: { "Retry-After": "1" } });
      }
      return Response.json({ book: rows800(start * 1e6), truncated: false });
    };
    const client = new HistoryClient("dummy-key", () => {}, request, async ms => { waits.push(ms); now += ms; });
    const backfill = new Backfill(client, store, metrics(), () => 1, () => {}, {
      now: () => now, wait: async ms => { now += ms; },
    });
    backfill.start(L); await backfill.settled();
    assert.equal(backfill.status.state, "complete");
    assert.deepEqual(waits, [60000, 60000]);
    assert.deepEqual(calls, [L - 60, L - 60, L - 60, L - 120]);
    assert.deepEqual(backfill.status.gaps, [{ kind: "book", startSec: L - 60, endSec: L, reason: "http_503" }]);
    assert.equal(store.covered("book", L - 60), false);
    assert.equal(store.covered("book", L - 120), true);
    assert.equal(client.stats.errors, 3); assert.equal(client.stats.retries, 2);
  });
});
for (const fillOnRetry of [1, 3, null]) {
  test(`ダミー：直近0行を後回し、2分間隔・再取得${fillOnRetry ?? "3回とも空"}・板約定は独立`, async () => {
    const L = Math.floor(Date.now() / 1000); let now = (L + 300) * 1000, latestBookCalls = 0, seq = 0;
    const calls: { kind: string; start: number; at: number }[] = [];
    const waits: number[] = [];
    await temporary(async store => {
      store.markCovered("book", L - 10800, L - 120);
      store.markCovered("tick", L - 10800, L - 60);
      const source = { get: async (kind: "book" | "tick", start: number) => {
        calls.push({ kind, start, at: now });
        if (kind === "book" && start === L - 60) {
          latestBookCalls++;
          if (fillOnRetry === null || latestBookCalls <= fillOnRetry) return { rows: [], truncated: false };
        }
        return { rows: kind === "book" ? rows800(start * 1e6)
          : [{ ts: start * 1e6, price: 100, size: 1, side: "buy" }], truncated: false };
      } };
      const backfill = new Backfill(source, store, metrics(), () => ++seq, () => {}, {
        now: () => now, wait: async ms => { waits.push(ms); now += ms; },
      });
      backfill.start(L); await backfill.settled();
      assert.equal(backfill.status.state, "complete");
      assert.equal(latestBookCalls, fillOnRetry === null ? 4 : fillOnRetry + 1);
      const latest = calls.filter(c => c.kind === "book" && c.start === L - 60);
      for (let i = 1; i < latest.length; i++) assert.equal(latest[i].at - latest[i - 1].at, 120000);
      assert.ok(calls.findIndex(c => c.start === L - 120) < calls.indexOf(latest[1]));
      assert.equal(calls.filter(c => c.kind === "tick").length, 1);
      assert.ok(waits.every(ms => ms === 120000));
      assert.equal(backfill.status.pendingEmpty.length, 0);
      assert.equal(backfill.status.noData.length, fillOnRetry === null ? 1 : 0);
      if (fillOnRetry === null) assert.equal(backfill.status.noData[0].attempts, 4);
      assert.equal(store.covered("book", L - 60), true);
    });
  });
}

test("ダミー：その他4xxはバックフィル停止、欠けとして通過させない", async () => {
  const L = Math.floor(Date.now() / 1000) - 301;
  await temporary(async store => {
    const client = new HistoryClient("dummy-key", () => {}, async () => new Response("", { status: 403 }));
    const backfill = new Backfill(client, store, metrics(), () => 1, () => {});
    backfill.start(L); await backfill.settled();
    assert.equal(backfill.status.state, "failed"); assert.equal(backfill.status.lastError, "http_403");
    assert.equal(backfill.status.gaps.length, 0);
  });
});
