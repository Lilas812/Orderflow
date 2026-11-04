import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { AppStore } from "../src/store/app.ts";
import { LocalStore, hourOf } from "../src/store/local.ts";
import type { Objects } from "../src/store/objects.ts";
import type { Column } from "../src/aggregate/columns.ts";
import { ColumnAggregator } from "../src/aggregate/columns.ts";
import { auditStoredBoards } from "../src/store/board-audit.ts";
import { encodeColumns } from "../src/store/binary.ts";
import { Pipeline } from "../src/pipeline.ts";
import { Receiver } from "../src/ingest/receiver.ts";
import { Upstream } from "../src/upstream/connection.ts";
import { BoardStageLogger } from "../src/diagnostics/board-stages.ts";
import { fork } from "node:child_process";
import { once } from "node:events";

/** ダミー: no real network, bucket, credentials, or market data. */
class DummyObjects implements Objects {
  files = new Map<string, Buffer>(); failIndex = false; uploads: string[] = [];
  async exists(name: string) { return this.files.has(name); }
  async list(prefix: string) { return [...this.files.keys()].filter(n => n.startsWith(prefix)); }
  async download(name: string, file: string) {
    if (!this.files.has(name)) throw Error("dummy_missing");
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, this.files.get(name)!);
  }
  async upload(name: string, file: string) {
    this.uploads.push(name);
    if (this.failIndex && name.endsWith("coverage.json")) throw Error("dummy_index_failure");
    this.files.set(name, await fs.readFile(file));
  }
}
const h = Date.UTC(2026, 10, 4, 3) / 1000;
const root = () => fs.mkdtemp(path.join(os.tmpdir(), "dummy-board-save-"));
const column = (tsSec: number): Column => ({ tsSec, source: "live", bids: [{ price: 100, size: 2 }],
  asks: [{ price: 101, size: 3 }] });
const trade = (s: number, seq: number) =>
  ({ tsUs: s * 1e6, recvUs: s * 1e6, price: 100, size: 2, side: "buy" as const, seq });

test("ダミー process: actual SIGTERM checkpoints open book/trade, restores fresh disk, process exits", { timeout: 15000 }, async () => {
  const dir = await root();
  const child = fork(new URL("./fixtures/board-sigterm.ts", import.meta.url), [dir], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit");
  try {
    const [ready] = await once(child, "message"); assert.equal(ready.ready, true);
    const reply = once(child, "message"); child.kill("SIGTERM");
    const [result] = await reply;
    assert.equal(result.stopped, true); assert.equal(result.columns, 1); assert.equal(result.trades, 1);
    assert.equal(result.remaining, 0); assert.ok(result.elapsedMs < 9000);
    const [code] = await exited; assert.equal(code, 0);
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    console.log("dummy_sigterm_result", JSON.stringify(result));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const symbol of ["NQ", "GC"] as const) for (const failIndex of [false, true]) {
  test(`ダミー ${symbol}: open-hour shutdown, wiped disk restart, orphan=${failIndex}`, async () => {
    const a = await root(), b = await root(), c = await root(), objects = new DummyObjects();
    const prefix = symbol === "NQ" ? "dev/" : "dev/instruments/GC/";
    const now = () => (h + 1800) * 1000;
    try {
      const one = new AppStore(a, objects, prefix, () => {}, now, symbol);
      await one.initialize(); await one.addColumns([column(h + 1), column(h + 2)]);
      // Identical time/price/size but distinct trades must remain distinct.
      await one.addTrades([trade(h + 1, 1), trade(h + 1, 2)]);
      objects.failIndex = failIndex;
      one.beginShutdown(new AbortController().signal); await one.flush();
      assert.equal(one.shutdownSummary().remaining.length, failIndex ? 2 : 0);
      if (failIndex) assert.equal(objects.files.has(prefix + "coverage.json"), false);
      objects.failIndex = false;
      const two = new AppStore(b, objects, prefix, () => {}, now, symbol); await two.initialize();
      await two.addColumns([column(h + 3)]);
      await two.addTrades([trade(h + 3, 3), trade(h + 2, 4)]); // exchange time rollback retained
      two.beginShutdown(new AbortController().signal); await two.flush();
      const three = new AppStore(c, objects, prefix, () => {}, now, symbol); await three.initialize();
      const view = await three.readView(h, h + 3600);
      assert.deepEqual(view.columns.map(c => c.tsSec), [h + 1, h + 2, h + 3]);
      assert.deepEqual(view.trades.map(t => t.seq), [1, 2, 3, 4]);
      assert.equal(view.trades.reduce((n, t) => n + t.size, 0), 8);
      assert.equal((await three.actualBookSeconds(h, h + 3600))[0].count, 3);
      // Existing coverage is exact observed intervals, not a fabricated full hour.
      assert.equal(three.covered("book", h + 100), false);
      assert.equal(three.covered("tick", h + 100), false);
    } finally { for (const dir of [a, b, c]) await fs.rm(dir, { recursive: true, force: true }); }
  });
}

test("ダミー: old no-checkpoint policy reproduces current-hour loss on wiped disk without REST", async () => {
  const a = await root(), b = await root(), objects = new DummyObjects();
  try {
    const one = new AppStore(a, objects, "dev/", () => {}, () => (h + 10) * 1000);
    await one.initialize(); await one.addColumns([column(h + 1)]); await one.addTrades([trade(h + 1, 1)]);
    // Ordinary flush is intentionally still closed-hour-only: this is the old
    // shutdown publication policy, used as the controlled negative comparison.
    await one.flush(); assert.equal(objects.files.size, 0);
    const fresh = new AppStore(b, objects, "dev/", () => {}, () => (h + 20) * 1000);
    await fresh.initialize();
    assert.equal((await fresh.actualBookSeconds(h, h + 3600))[0].count, 0);
    assert.equal((await fresh.readTrades(h, h + 3600)).length, 0);
  } finally { for (const dir of [a, b]) await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: stop flushes last actual snapshot even before +3s, no REST/no fabricated seconds", async () => {
  const dir = await root(); let requests = 0;
  const sec = Math.floor(Date.now() / 1000) + 1;
  const store = new LocalStore(dir), pipeline = new Pipeline("dummy", () => 1, () => {}, () => {},
    store, "NQ", async () => { requests++; throw Error("dummy_no_network"); });
  try {
    await pipeline.initialize();
    pipeline.trade(trade(sec - 1, 1));
    pipeline.book({ tsUs: sec * 1e6, recvUs: sec * 1e6, source: "live",
      bids: [{ price: 100, size: 4 }], asks: [{ price: 101, size: 5 }] });
    pipeline.book({ tsUs: sec * 1e6, recvUs: sec * 1e6 + 1, source: "live",
      bids: [{ price: 100, size: 8 }], asks: [{ price: 101, size: 9 }] });
    await pipeline.stop();
    assert.equal(requests, 0);
    const columns = await store.readColumns(sec - 1, sec + 4);
    assert.equal(columns.length, 1); assert.equal(columns[0].tsSec, sec); assert.equal(columns[0].bids[0].size, 8);
    assert.equal((await store.readTrades(sec - 1, sec + 1)).length, 1);
    assert.equal(store.boardWrites.columns, 1); assert.equal(pipeline.boardStages.finalizedColumns, 1);
  } finally { await pipeline.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: received trades survive shutdown even when no book/seam has arrived", async () => {
  const dir = await root(), sec = Math.floor(Date.now() / 1000);
  const p = new Pipeline("dummy", () => 1, () => {}, () => {}, new LocalStore(dir));
  try {
    await p.initialize(); p.trade(trade(sec, 1)); await p.stop();
    assert.equal((await p.store.readTrades(sec, sec + 1)).length, 1);
    assert.equal((await p.store.actualBookSeconds(hourOf(sec), hourOf(sec) + 3600))[0].count, 0);
  } finally { await p.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: actual-book inspection preserves coverage for empty/sparse/cross-hour input", async () => {
  const dir = await root(), s = new LocalStore(dir, () => (h + 7200) * 1000);
  try {
    await s.initialize();
    s.markCovered("book", h, h + 7200);
    await s.addColumns([column(h + 3599), column(h + 3600), column(h + 3602)]);
    await s.flush(); const index = await fs.readFile(path.join(dir, "coverage.json"));
    assert.deepEqual((await s.actualBookSeconds(h, h + 10800)).map(x => x.count), [1, 2, 0]);
    assert.deepEqual((await s.actualBookSeconds(h + 3601, h + 3603))[0].intervals, [[h + 3602, h + 3603]]);
    await s.addColumns([column(h + 3599)]); assert.equal(s.boardWrites.columns, 3);
    assert.deepEqual(await fs.readFile(path.join(dir, "coverage.json")), index);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: 64 trailing real seconds missing from cloud index are detected and republished", async () => {
  const dir = await root(), objects = new DummyObjects(), now = () => (h + 7200) * 1000;
  try {
    const s = new AppStore(dir, objects, "dev/", () => {}, now); await s.initialize();
    await s.addColumns([column(h), ...Array.from({ length: 64 }, (_, i) => column(h + 3536 + i))]); await s.flush();
    const bookName = "dev/columns/NQ/1s/2026-11-04/03.bin.gz";
    const bytes = objects.files.get(bookName)!;
    const index = JSON.parse(objects.files.get("dev/coverage.json")!.toString());
    index.book = [[h, h + 1]]; objects.files.set("dev/coverage.json", Buffer.from(JSON.stringify(index)));
    assert.equal((await auditStoredBoards(objects, h, h + 3600, "dev/", ["NQ"])).rows[0].actualOutsideCoverage, 64);
    const recovered = new AppStore(dir, objects, "dev/", () => {}, now); await recovered.initialize(); await recovered.flush();
    const after = (await auditStoredBoards(objects, h, h + 3600, "dev/", ["NQ"])).rows[0];
    assert.equal(after.actualOutsideCoverage, 0); assert.equal(after.actualSeconds, 65);
    assert.deepEqual(objects.files.get(bookName), bytes);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: coverage-only shutdown failure is listed even when gzip body was verified", async () => {
  const dir = await root(), objects = new DummyObjects(), now = () => (h + 7200) * 1000;
  try {
    const s = new AppStore(dir, objects, "dev/", () => {}, now); await s.initialize();
    await s.addColumns([column(h + 3599)]); await s.flush();
    // This fetched-range update changes only the index, not the gzip body.
    s.markCovered("book", h + 3598, h + 3600); objects.failIndex = true;
    s.beginShutdown(new AbortController().signal); await s.flush();
    const remaining = s.shutdownSummary().remaining;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].reason, "upload_or_index_failed");
    assert.equal(JSON.parse(objects.files.get("dev/coverage.json")!.toString()).book[0][0], h + 3599);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ダミー: CLI core never uploads, distinguishes sparse/empty/missing/corrupt files", async () => {
  const objects = new DummyObjects();
  objects.upload = async () => { throw Error("dummy_read_only_violation"); };
  objects.files.set("prod/coverage.json", Buffer.from(JSON.stringify({ tick: [[h, h + 14400]], book: [[h, h + 14400]] })));
  const base = "prod/columns/NQ/1s/2026-11-04/";
  objects.files.set(base + "03.bin.gz", gzipSync(encodeColumns([column(h), column(h + 2)])));
  objects.files.set(base + "04.bin.gz", gzipSync(""));
  objects.files.set(base + "06.bin.gz", Buffer.from("dummy-corrupt"));
  const before = new Map(objects.files), result = await auditStoredBoards(objects, h, h + 14400, "prod/", ["NQ"]);
  assert.deepEqual(result.rows.map(x => x.actualSeconds), [2, 0, 0, null]);
  assert.deepEqual(result.rows.map(x => x.filePresent), [true, true, false, true]);
  assert.equal(result.rows[0].coverageWithoutActual, 3598);
  assert.equal(result.rows[3].error, "object_read_or_decode_failed");
  assert.deepEqual(objects.files, before);
});

test("ダミー: stages log once/minute/symbol, rejection reasons partition rejected books; bounded shared counters", async () => {
  const dir = await root(), events: any[] = []; let now = 0;
  const receiver = new Receiver(() => {}), gc = new Receiver(() => {}, {}, "GC");
  const p = new Pipeline("dummy", () => 1, () => {}, () => {}, new LocalStore(dir));
  const upstream = new Upstream({ apiKey: "dummy", receiver, log: () => {},
    createSocket: () => { throw Error("dummy_no_network"); } });
  const logger = new BoardStageLogger(receiver, p, () => upstream, (event, detail) => events.push({ event, detail }), () => now);
  const gcLogger = new BoardStageLogger(gc, p, () => upstream, (event, detail) => events.push({ event, detail }), () => now);
  try {
    const msg = { type: "book", symbol: "NQ", ts: h, bids: [[100, 2]], asks: [[100.25, 3]] };
    receiver.receive(JSON.stringify(msg), h * 1e6, () => {});
    receiver.receive(JSON.stringify({ ...msg, bids: [[101, 2]] }), h * 1e6, () => {});
    receiver.receive(JSON.stringify({ ...msg, ts: h - 1 }), h * 1e6, () => {});
    receiver.metrics.count("watchdog"); receiver.metrics.count("disconnects"); upstream.status.reconnectCount = 1;
    now = 59999; logger.emit(); assert.equal(events.length, 0);
    now = 60000; logger.emit(); gcLogger.emit(); logger.emit(); assert.equal(events.length, 2);
    const totals = events[0].detail.total;
    assert.equal(totals.receivedBooks, 3); assert.equal(totals.acceptedBooks, 1); assert.equal(totals.rejectedBooks, 2);
    assert.equal(totals.reject_crossed_book, 1); assert.equal(totals.reject_timestamp_rollback, 1);
    assert.equal(totals.watchdog, 1); assert.equal(totals.disconnects, 1); assert.equal(totals.reconnects, 1);
    assert.equal(events[1].detail.total.watchdog, 1); assert.equal(events[1].detail.total.receivedBooks, 0);
    now = 120000; logger.emit(); assert.equal(events[2].detail.delta.receivedBooks, 0);
    const out: Column[] = [], aggregator = new ColumnAggregator(c => out.push(c));
    aggregator.accept({ ...column(h), tsUs: h * 1e6, recvUs: h * 1e6 });
    aggregator.flushObserved(); aggregator.flushObserved(); assert.equal(out.length, 1);
  } finally { logger.stop(); gcLogger.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});
