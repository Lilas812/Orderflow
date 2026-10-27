import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { encodeColumns, decodeColumns } from "../src/store/binary.ts";
import { columnRecords, decodeColumnRange, scanColumnFile, tradeFileRows, mergeColumnRecords } from "../src/store/records.ts";
import { MemoryMonitor } from "../src/diagnostics/memory.ts";
import type { Column } from "../src/aggregate/columns.ts";

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
    "arrayBuffers", "external", "heapTotal", "heapUsed", "pid", "rss", "sampledAtUs",
  ]);
});
