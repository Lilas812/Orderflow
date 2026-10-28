import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { LocalStore, hourOf } from "../src/store/local.ts";
import { encodeColumns } from "../src/store/binary.ts";
import { scanColumnFile, tradeFileRows } from "../src/store/records.ts";
import type { Trade } from "../src/types.ts";

const trade = (sec: number, seq: number): Trade => ({
  tsUs: sec * 1e6, recvUs: sec * 1e6, seq, price: 400, size: 1, side: "buy",
});
const column = (tsSec: number) => ({ tsSec, source: "history" as const,
  bids: [{ price: 400, size: 2 }], asks: [{ price: 401, size: 3 }] });

test("ダミー：断片化した被覆は行ごとに統合せず復旧。逆行・重複・VPの完全性と元バイトを保持", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "startup-recovery-"));
  const second = Date.parse("2026-10-28T10:00:00Z") / 1000;
  try {
    const bookFile = path.join(root, "columns/NQ/1s/2026-10-28/10.bin.gz");
    const tickFile = path.join(root, "trades/NQ/2026-10-28/10.jsonl.gz");
    await fs.mkdir(path.dirname(bookFile), { recursive: true });
    await fs.mkdir(path.dirname(tickFile), { recursive: true });
    const books = [column(second + 2), column(second + 4)];
    const duplicate = trade(second + 5, 2);
    const ticks = [trade(second + 6, 1), duplicate, duplicate, trade(second + 2, 3)];
    const index = JSON.stringify({ book: [[second, second + 1]], tick: [[second, second + 1]] });
    await fs.writeFile(bookFile, gzipSync(encodeColumns(books)));
    await fs.writeFile(tickFile, gzipSync(ticks.map(t => JSON.stringify(t) + "\n").join("")));
    await fs.writeFile(path.join(root, "coverage.json"), index);
    const originalBook = await fs.readFile(bookFile), originalTick = await fs.readFile(tickFile);
    class NoRowMerges extends LocalStore {
      override markCovered(): never { throw Error("unexpected_per_row_merge"); }
    }
    const store = new NoRowMerges(root, () => (second + 3700) * 1000);
    await store.initialize();
    for (const s of [0, 2, 4]) assert.equal(store.covered("book", second + s), true);
    for (const s of [0, 2, 5, 6]) assert.equal(store.covered("tick", second + s), true);
    for (const s of [1, 3, 4, 7]) assert.equal(store.covered("tick", second + s), false);
    assert.deepEqual(store.savedRange, { fromSec: second + 2, toSec: second + 7 });
    assert.equal(store.stats.latestColumnSec, second + 4);
    assert.deepEqual(await store.readColumns(second, second + 3600), books);
    assert.deepEqual(await store.readTrades(second, second + 3600), ticks.slice().sort((a, b) => a.seq - b.seq));
    assert.deepEqual(await store.recordedTickCoverage(), [[second, second + 1]]);
    assert.equal(await fs.readFile(path.join(root, "coverage.json"), "utf8"), index);
    await store.maintenance();
    assert.deepEqual(await store.recordedTickCoverage(), [[second, second + 1]]);
    assert.deepEqual(await fs.readFile(bookFile), originalBook);
    assert.deepEqual(await fs.readFile(tickFile), originalTick);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("ダミー：初期化済み時間への追記は既存秒優先を維持", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "startup-append-"));
  const h = hourOf(Date.now() / 1000);
  try {
    const writer = new LocalStore(root, () => (h + 10) * 1000);
    await writer.initialize(); await writer.addColumns([column(h + 1)]);
    const reader = new LocalStore(root, () => (h + 10) * 1000);
    await reader.initialize();
    await reader.addColumns([column(h + 2)]);
    await reader.addColumns([{ ...column(h + 1), bids: [{ price: 400, size: 99 }] }]);
    assert.deepEqual(await reader.readColumns(h, h + 10), [column(h + 1), column(h + 2)]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("ダミー：走査途中の中断は列・約定ストリームを拒否し、元バイトを変更しない", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "startup-abort-"));
  try {
    const book = path.join(root, "book.bin.gz"), tick = path.join(root, "tick.jsonl.gz");
    const originalBook = gzipSync(encodeColumns(Array.from({ length: 3000 }, (_, i) => column(i))));
    const originalTick = gzipSync(Array.from({ length: 10000 }, (_, i) => JSON.stringify(trade(i, i)) + "\n").join(""));
    await fs.writeFile(book, originalBook); await fs.writeFile(tick, originalTick);
    const a = new AbortController();
    let visited = 0;
    await assert.rejects(scanColumnFile(book, () => {
      if (++visited === 10) a.abort();
    }, a.signal), { name: "AbortError" });
    const b = new AbortController();
    await assert.rejects(async () => {
      let count = 0;
      for await (const _row of tradeFileRows(tick, b.signal)) if (++count === 10) b.abort();
    }, { name: "AbortError" });
    const c = new AbortController(); c.abort();
    await assert.rejects(new LocalStore(root).initialize(c.signal), { name: "AbortError" });
    assert.deepEqual(await fs.readFile(book), originalBook);
    assert.deepEqual(await fs.readFile(tick), originalTick);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
