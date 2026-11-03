import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { encodeColumns, decodeColumns } from "../src/store/binary.ts";
import { columnRecords, decodeColumnRange, scanColumnFile, tradeFileRows, mergeColumnRecords } from "../src/store/records.ts";
import { MemoryMonitor } from "../src/diagnostics/memory.ts";
import type { Column } from "../src/aggregate/columns.ts";
import type { Trade } from "../src/types.ts";
import { LocalStore } from "../src/store/local.ts";
import { measurementLogWriter } from "../src/diagnostics/measurement-log.ts";
import { createLogger } from "../src/logger.ts";

const columns: Column[] = [100, 101, 105].map(tsSec => ({
  tsSec, source: "history", bids: [{ price: 100, size: 2 }], asks: [{ price: 101, size: 3 }],
}));
test("column range decoding preserves exact saved records and half-open bounds", () => {
  const bytes = encodeColumns(columns), records: Buffer[] = [];
  columnRecords(bytes, (_sec, record) => records.push(record));
  assert.deepEqual(Buffer.concat(records), bytes);
  assert.deepEqual(decodeColumnRange(bytes, 101, 105), [columns[1]]);
  assert.deepEqual(decodeColumnRange(bytes, 110, 120), []);
});
test("range scan still rejects malformed records outside the requested range", () => {
  const bytes = encodeColumns(columns); bytes[4] = 9;
  assert.throws(() => decodeColumnRange(bytes, 101, 105), /invalid_column_record/);
  assert.throws(() => columnRecords(encodeColumns(columns).subarray(0, -1), () => {}), /invalid_column_record/);
});
test("binary-only merge preserves disk precedence and exact record content", () => {
  const incoming = { ...columns[1], bids: [{ price: 10, size: 50 }] } as Column;
  const pending = new Map([[101, encodeColumns([incoming])], [105, encodeColumns([columns[2]])]]);
  const merged = mergeColumnRecords(encodeColumns(columns.slice(0, 2)), pending);
  assert.deepEqual(decodeColumns(merged.bytes), columns);
  assert.equal(merged.freshCount, 1); assert.equal(merged.appendOnly, true); assert.equal(merged.lastSecond, 105);
  const older = mergeColumnRecords(encodeColumns(columns.slice(1)), new Map([[100, encodeColumns([columns[0]])]]));
  assert.equal(older.appendOnly, false); assert.deepEqual(decodeColumns(older.bytes), columns);
});
test("streamed startup scan matches full decoding for plain and gzip files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "heatmap-record-test-"));
  try {
    const bytes = encodeColumns(columns);
    for (const suffix of [".bin", ".bin.gz"]) {
      const file = path.join(root, "columns" + suffix);
      await fs.writeFile(file, suffix.endsWith("gz") ? gzipSync(bytes) : bytes);
      const seconds: number[] = [];
      await scanColumnFile(file, sec => seconds.push(sec));
      assert.deepEqual(seconds, decodeColumns(bytes).map(c => c.tsSec));
    }
    const bad = path.join(root, "bad.bin.gz");
    await fs.writeFile(bad, gzipSync(bytes.subarray(0, -1)));
    await assert.rejects(scanColumnFile(bad, () => {}), /invalid_column_record/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("streamed JSONL reader handles concatenated gzip members without deduplication", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "heatmap-trade-test-"));
  try {
    const file = path.join(root, "trades.jsonl.gz");
    const a = { seq: 2, tsUs: 2000000 }, b = { seq: 3, tsUs: 1000000 };
    await fs.writeFile(file, Buffer.concat([gzipSync(JSON.stringify(a) + "\n"), gzipSync(JSON.stringify(b) + "\n")]));
    const rows: unknown[] = [];
    for await (const row of tradeFileRows(file)) rows.push(row);
    assert.deepEqual(rows, [a, b]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("memory diagnostics contain numeric process measurements, not configuration", () => {
  const snapshot = new MemoryMonitor(() => {}).snapshot();
  assert.ok(snapshot.pid > 0 && snapshot.rss > 0 && snapshot.heapUsed > 0);
  assert.ok(snapshot.sampledAtUs > 0);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "arrayBuffers", "automaticCpuProfile", "cpu", "cpuBreakdown", "cpuPressure", "eventLoop", "external", "heapTotal", "heapUsed", "mainThread", "pid", "rss", "rssMaxBytes", "sampledAtUs",
  ]);
});

test("ダミー：streamed trades reject gzip and file errors instead of returning partial success", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "heatmap-trade-error-"));
  try {
    const file = path.join(root, "bad.jsonl.gz");
    await fs.writeFile(file, "not a gzip stream");
    const read = async (file: string) => { for await (const _row of tradeFileRows(file)) { /* consume */ } };
    await assert.rejects(read(file));
    await assert.rejects(read(path.join(root, "missing.jsonl.gz")), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("ダミー：measurement lifecycle log is opt-in, scrubbed and survives admission release", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "heatmap-measure-log-"));
  try {
    assert.equal(measurementLogWriter(root), undefined);
    const flag = path.join(root, "isolation.json");
    await fs.writeFile(flag, "{}");
    const log = createLogger("dummy-test-key", measurementLogWriter(root));
    log("hub_connected", { label: "ダミー", secret: "dummy-test-key" });
    log("process_memory", { label: "ダミー" });
    await fs.unlink(flag);
    log("hub_closed", { label: "ダミー" });
    const text = await fs.readFile(path.join(root, `connections-${process.pid}.jsonl`), "utf8");
    assert.ok(!text.includes("dummy-test-key"));
    assert.deepEqual(text.trim().split("\n").map(line => JSON.parse(line).event), ["hub_connected", "hub_closed"]);
    assert.equal(measurementLogWriter(root), undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("ダミー：bounded store reads preserve held writes, disk precedence, gzip bytes and trade duplicates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "heatmap-store-memory-"));
  const store = new LocalStore(root, () => 10020 * 1000);
  const col = (tsSec: number, size = 1): Column => ({ tsSec, source: "live",
    bids: [{ price: 400, size }], asks: [{ price: 401, size: 2 }] });
  const trade = (second: number, seq: number): Trade => ({
    tsUs: second * 1e6, recvUs: second * 1e6, seq, price: 401, size: 1, side: "buy",
  });
  try {
    await store.initialize();
    await store.addColumns([col(7199), col(7200)]);
    await store.addTrades([trade(7201, 3)]);
    store.hold(7199, 7203);
    await store.addColumns([col(7199, 99), col(7201), col(7202)]);
    await store.addTrades([trade(7200, 2), trade(7200, 2)]);
    const expected = { columns: [col(7199), col(7200), col(7201), col(7202)],
      trades: [trade(7200, 2), trade(7200, 2), trade(7201, 3)] };
    assert.deepEqual(await store.readView(7199, 7203), expected);
    assert.deepEqual((await store.readView(7200, 7201)).columns, [col(7200)]);
    assert.deepEqual(await store.readColumns(7200, 7203), [col(7200)]);
    await store.flush();
    assert.deepEqual(await store.readView(7199, 7203), expected);
    assert.deepEqual(await store.readTrades(7200, 7202), expected.trades);
    const closed = path.join(root, "columns/NQ/1s/1970-01-01/01.bin.gz");
    const current = path.join(root, "columns/NQ/1s/1970-01-01/02.bin");
    assert.deepEqual(gunzipSync(await fs.readFile(closed)), encodeColumns([col(7199)]));
    const prefix = await fs.readFile(current);
    assert.deepEqual(prefix, encodeColumns([col(7200), col(7201), col(7202)]));
    const restarted = new LocalStore(root, () => 10020 * 1000);
    await restarted.initialize(); await restarted.addColumns([col(7203)]);
    assert.deepEqual(await fs.readFile(current), Buffer.concat([prefix, encodeColumns([col(7203)])]));
    assert.deepEqual(await restarted.readView(7201, 7203), {
      columns: [col(7201), col(7202)], trades: [trade(7201, 3)],
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
