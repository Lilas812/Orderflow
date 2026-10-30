import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStore, includeRange, ranges } from "../src/store/local.ts";
import type { Range } from "../src/store/local.ts";
import type { Trade } from "../src/types.ts";
import type { Column } from "../src/aggregate/columns.ts";

const column = (tsSec: number): Column => ({
  tsSec, source: "live", bids: [{ price: 400, size: 17 }], asks: [{ price: 401, size: 23 }],
});
const trade = (sec: number, seq: number): Trade => ({
  tsUs: sec * 1e6, recvUs: (sec + 1) * 1e6, seq, price: 401, size: 3, side: "buy",
});

test("ダミー：incremental union matches full union for bridges, adjacency and rollbacks", () => {
  const actual: Range[] = [], history: Range[] = [];
  let seed = 4129;
  for (let i = 0; i < 2000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const a = seed % 5000, b = a + 1 + seed % 30;
    const before = JSON.stringify(actual);
    const changed = includeRange(actual, a, b);
    history.push([a, b]);
    assert.deepEqual(actual, ranges(history.map(([x, y]) => [x, y])));
    assert.equal(changed, before !== JSON.stringify(actual));
  }
  const a: Range[] = [[1, 2], [4, 5], [8, 10]];
  assert.equal(includeRange(a, 2, 8), true);
  assert.deepEqual(a, [[1, 10]]);
  assert.equal(includeRange(a, 3, 7), false);
});

test("ダミー：idle maintenance skips coverage writes/full stats; live mutations remain exact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "store-cpu-"));
  let now = 10000 * 1000;
  const store = new LocalStore(root, () => now);
  try {
    await store.initialize();
    await store.addColumns([column(9900)]);
    const same = trade(9900, 1);
    await store.addTrades([same, same, trade(9899, 2)]);
    await store.maintenance();
    const index = path.join(root, "coverage.json");
    const before = await fs.stat(index, { bigint: true }), contents = await fs.readFile(index);
    const expectedStats = { files: store.stats.files, bytes: store.stats.bytes };
    for (let i = 0; i < 5; i++) await store.maintenance();
    const after = await fs.stat(index, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(await fs.readFile(index), contents);
    assert.deepEqual({ files: store.stats.files, bytes: store.stats.bytes }, expectedStats);
    const full = store.refreshStats.bind(store);
    store.refreshStats = async () => { throw Error("unexpected_full_stats"); };
    await store.addColumns([column(9901)]);
    await store.addTrades([trade(9901, 3)]);
    await store.maintenance();
    const incremental = { files: store.stats.files, bytes: store.stats.bytes };
    await full();
    assert.deepEqual({ files: store.stats.files, bytes: store.stats.bytes }, incremental);
    assert.deepEqual(await store.readTrades(9890, 9902), [same, same, trade(9899, 2), trade(9901, 3)]);
    now = 10800 * 1000;
    await store.maintenance(); // Rotation removes the plain file and adds gzip.
    const rotated = { files: store.stats.files, bytes: store.stats.bytes };
    await full();
    assert.deepEqual({ files: store.stats.files, bytes: store.stats.bytes }, rotated);
    assert.deepEqual(await store.readColumns(9900, 9902), [column(9900), column(9901)]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("ダミー：hold/release, empty coverage, restart and retained-file expiry stay correct", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "store-cpu-held-"));
  let now = 10000 * 1000;
  const store = new LocalStore(root, () => now);
  try {
    await store.initialize();
    store.hold(7200, 10800);
    await store.addColumns([column(9900)]);
    await store.addTrades([trade(9900, 1)]);
    store.markCovered("tick", 9800, 9805);
    await store.maintenance();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "coverage.json"), "utf8")), { book: [], tick: [] });
    await store.releaseHour(7200);
    const covered = JSON.parse(await fs.readFile(path.join(root, "coverage.json"), "utf8"));
    assert.deepEqual(covered.tick, [[9800, 9805], [9900, 9901]]);
    const restarted = new LocalStore(root, () => now);
    await restarted.initialize();
    assert.deepEqual(await restarted.recordedTickCoverage(), covered.tick);
    now += 8 * 86400 * 1000;
    await store.maintenance();
    assert.equal(store.stats.files, 0); assert.equal(store.stats.bytes, 0);
    assert.deepEqual(await store.recordedTickCoverage(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("ダミー：coverage changed during atomic await remains dirty for the next maintenance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "store-cpu-revision-"));
  const store = new LocalStore(root, () => 10000 * 1000);
  try {
    await store.initialize();
    // Instrument existing private method solely in this isolated test.
    const internal = store as unknown as { atomic(file: string, bytes: Buffer | string): Promise<void> };
    const atomic = internal.atomic.bind(store);
    let injected = false;
    internal.atomic = async (file, bytes) => {
      if (file.endsWith("coverage.json") && !injected) { injected = true; store.markCovered("tick", 9900, 9901); }
      await atomic(file, bytes);
    };
    await store.maintenance();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "coverage.json"), "utf8")).tick, []);
    await store.maintenance();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "coverage.json"), "utf8")).tick, [[9900, 9901]]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
