import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { AppStore } from "../src/store/app.ts";
import type { Objects } from "../src/store/objects.ts";
import type { Trade } from "../src/types.ts";
import { readTradeRange } from "../src/vp/trade-history.ts";
import { Metrics } from "../src/ingest/metrics.ts";

const H = Date.UTC(2026, 9, 25) / 1000;
const noop = () => {};
const tick = (sec: number, seq: number, contract?: string): Trade => ({
  tsUs: Math.round(sec * 1e6), recvUs: H * 1e6 + seq, price: 20000 + seq,
  size: seq % 7 + 1, side: seq % 2 ? "buy" : "sell", seq, ...(contract ? { contract } : {}),
});
const encode = (rows: Trade[]) => gzipSync(rows.map(t => JSON.stringify(t) + "\n").join(""));
const name = (symbol: string, h = H) => `dev/${symbol === "GC" ? "instruments/GC/" : ""}trades/${symbol}/${new Date(h * 1000).toISOString().slice(0, 10)}/${String(new Date(h * 1000).getUTCHours()).padStart(2, "0")}.jsonl.gz`;
/** ダミー専用：ネットワークも本番オブジェクトも利用しない。 */
class DummyObjects implements Objects {
  files = new Map<string, Buffer>();
  reads: string[] = [];
  bytes = 0;
  before?: (name: string, file: string) => Promise<void>;
  async exists(n: string) { return this.files.has(n); }
  async list(p: string) { return [...this.files.keys()].filter(n => n.startsWith(p)); }
  async upload() { throw Error("dummy_read_only"); }
  async download(n: string, file: string) {
    this.reads.push(n); await this.before?.(n, file);
    const bytes = this.files.get(n); if (!bytes) throw Error("dummy_missing");
    await fs.writeFile(file, bytes); this.bytes += bytes.length;
  }
}
async function fixture(t: any, rows: Trade[], symbol: "NQ" | "GC" = "NQ",
  coverage: [number, number][] = [[H, H + 3600]], now = H + 80 * 3600) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-trade-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const objects = new DummyObjects(), prefix = symbol === "NQ" ? "dev/" : "dev/instruments/GC/";
  objects.files.set(prefix + "coverage.json", Buffer.from(JSON.stringify({ book: [], tick: coverage })));
  objects.files.set(name(symbol), encode(rows));
  const store = new AppStore(root, objects, prefix, noop, () => now * 1000, symbol);
  await store.initialize(); objects.reads = []; objects.bytes = 0;
  return { root, objects, store };
}
async function oldRead(store: AppStore, start: number, end: number) {
  const result: Trade[] = [];
  for (let a = start; a < end; a += 900) await store.visitTrades(a, Math.min(end, a + 900), t => result.push(t));
  return result;
}
async function history(store: AppStore, start = H, end = H + 3600, signal = new AbortController().signal,
  visit?: (t: Trade) => void) {
  const rows: Trade[] = [];
  const state = await readTradeRange({ store, start, end, signal, metrics: new Metrics(noop), nextSeq: () => 1,
    source: { get: async () => { throw Error("unexpected_dummy_REST"); } },
    visit: t => { rows.push(t); visit?.(t); } });
  return { rows, state };
}
async function empty(store: AppStore, root: string) {
  await store.tradeReadsSettled();
  assert.equal(store.tradeReadStats.activeRefs, 0);
  assert.equal(store.tradeReadStats.activeSnapshots, 0);
  assert.equal(store.tradeReadStats.cleanupFailures, 0);
  assert.deepEqual(await fs.readdir(path.join(root, ".trade-read-temporary")).catch(() => []), []);
}

test("ダミー：4窓の結果・件数・枚数・同内容別約定・巻戻り・限月を維持、取得/展開1回", async t => {
  const a = tick(H + 5, 1, "GCZ6");
  const rows = [a, tick(H + 1805, 2), { ...a }, tick(H + 900, 3, "GCG7"),
    tick(H + 899.999999, 4), tick(H + 2700, 5), tick(H + 905, 6), tick(H + 3599.999999, 7)];
  const { store, objects, root } = await fixture(t, rows, "GC");
  const expected = await oldRead(store, H, H + 3600);
  assert.equal(objects.reads.length, 4);
  const oldBytes = objects.bytes; objects.reads = []; objects.bytes = 0;
  const actual = await history(store);
  assert.deepEqual(actual.rows, expected);
  assert.equal(actual.rows.length, rows.length);
  assert.equal(actual.rows.reduce((n, t) => n + t.size, 0), rows.reduce((n, t) => n + t.size, 0));
  assert.equal(actual.state.fileWindows, 4);
  assert.equal(objects.reads.length, 1); assert.equal(objects.bytes * 4, oldBytes);
  assert.equal(store.tradeReadStats.gzipScans, 1);
  assert.match(store.tradeReadStats.lastSnapshotSha256!, /^[0-9a-f]{64}$/);
  await empty(store, root);
});

test("ダミー：任意15分窓と時間境界、spillの行順・半開境界を旧経路と一致", async t => {
  const rows = [tick(H + 3700, 9), tick(H + 3599, 2), tick(H + 3450, 1), tick(H + 3300, 3)];
  const f = await fixture(t, rows, "NQ", [[H, H + 7200]]);
  f.objects.files.set(name("NQ", H + 3600), encode([
    tick(H + 3600, 4), tick(H + 3598, 5), tick(H + 3900, 6), tick(H + 4400, 7),
  ]));
  const expected = await oldRead(f.store, H + 3300, H + 4400);
  const result = await history(f.store, H + 3300, H + 4400);
  assert.deepEqual(result.rows, expected);
  assert.equal(result.rows.some(x => x.tsUs === (H + 4400) * 1e6), false);
  assert.equal(f.store.tradeReadStats.gzipScans, 2);
  await empty(f.store, f.root);
});

test("ダミー：NQ/GC分離、同じ時刻・異なる本文を混ぜない", async t => {
  const nq = await fixture(t, [tick(H + 10, 1)]), gc = await fixture(t, [tick(H + 10, 8, "GCZ6")], "GC");
  const [a, b] = await Promise.all([history(nq.store), history(gc.store)]);
  assert.deepEqual(a.rows, [tick(H + 10, 1)]); assert.deepEqual(b.rows, [tick(H + 10, 8, "GCZ6")]);
  assert.notEqual(nq.store.tradeReadStats.lastSnapshotSha256, gc.store.tradeReadStats.lastSnapshotSha256);
  await empty(nq.store, nq.root); await empty(gc.store, gc.root);
});

test("ダミー：並行scopeは取得・走査を共有、先行closeが他の一時ファイルを消さない", async t => {
  const f = await fixture(t, [tick(H + 3, 1), tick(H + 900, 2)]);
  const a = f.store.tradeReadSession(new AbortController().signal), b = f.store.tradeReadSession(new AbortController().signal);
  try {
    await Promise.all([a.visit(H, H + 900, noop), b.visit(H, H + 900, noop)]);
    assert.equal(f.objects.reads.length, 1); assert.equal(f.store.tradeReadStats.gzipScans, 1);
    await a.close();
    assert.equal(f.store.tradeReadStats.activeRefs, 1);
    const rows: Trade[] = []; await b.visit(H + 900, H + 1800, x => rows.push(x));
    assert.deepEqual(rows, [tick(H + 900, 2)]);
  } finally { await a.close(); await b.close(); }
  await empty(f.store, f.root);
});

test("ダミー：scope中の版は固定、全解放後の次scopeは新本文を取得", async t => {
  const old = [tick(H + 3, 1), tick(H + 900, 2)], newer = [tick(H + 3, 8), tick(H + 900, 9)];
  const f = await fixture(t, old), a = f.store.tradeReadSession(new AbortController().signal);
  const rows: Trade[] = [];
  await a.visit(H, H + 900, x => rows.push(x));
  const sha = f.store.tradeReadStats.lastSnapshotSha256;
  f.objects.files.set(name("NQ"), encode(newer));
  await a.visit(H + 900, H + 1800, x => rows.push(x)); await a.close();
  assert.deepEqual(rows, old);
  assert.deepEqual((await history(f.store)).rows, newer);
  assert.notEqual(f.store.tradeReadStats.lastSnapshotSha256, sha);
  await empty(f.store, f.root);
});

test("ダミー：callback例外・読取中abortで解放し、後続読取を壊さない", async t => {
  const f = await fixture(t, Array.from({ length: 300 }, (_, i) => tick(H + i, i + 1)));
  await assert.rejects(history(f.store, H, H + 3600, undefined, () => { throw Error("dummy_visitor"); }), /dummy_visitor/);
  await empty(f.store, f.root);
  const abort = new AbortController();
  await assert.rejects(history(f.store, H, H + 3600, abort.signal, () => abort.abort()), { name: "AbortError" });
  await empty(f.store, f.root);
  assert.equal((await history(f.store)).rows.length, 300);
  await empty(f.store, f.root);
});

test("ダミー：DL待機中の片方のabortは参照だけ解放、他の読取を中断しない", async t => {
  const f = await fixture(t, [tick(H + 3, 1)]);
  let resume!: () => void, started!: () => void;
  const gate = new Promise<void>(r => resume = r), began = new Promise<void>(r => started = r);
  f.objects.before = async n => { if (n.endsWith(".gz")) { started(); await gate; } };
  const abort = new AbortController(), a = f.store.tradeReadSession(abort.signal),
    b = f.store.tradeReadSession(new AbortController().signal);
  const first = a.visit(H, H + 900, noop);
  await began;
  const second = b.visit(H, H + 900, noop);
  // Allow the second resolver/acquire to join before cancelling the first reference.
  while (f.store.tradeReadStats.activeRefs < 2) await new Promise(r => setImmediate(r));
  abort.abort(); await assert.rejects(first, { name: "AbortError" }); await a.close();
  assert.equal(f.store.tradeReadStats.activeRefs, 1);
  resume(); await second; await b.close();
  assert.equal(f.objects.reads.length, 1); await empty(f.store, f.root);
});

test("ダミー：単独DL待機のabort後も遅いSDK完了を待って安全に削除", async t => {
  const f = await fixture(t, [tick(H + 3, 1)]);
  let resume!: () => void, started!: () => void;
  const gate = new Promise<void>(r => resume = r), began = new Promise<void>(r => started = r);
  f.objects.before = async () => { started(); await gate; };
  const abort = new AbortController(), pending = history(f.store, H, H + 3600, abort.signal);
  await began; abort.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.store.tradeReadStats.activeRefs, 0);
  resume(); await empty(f.store, f.root);
});

test("ダミー：部分DL失敗・gzip破損・JSON破損は共有成功にせずcleanup後再取得", async t => {
  const f = await fixture(t, [tick(H + 3, 1)]), original = f.objects.files.get(name("NQ"))!;
  f.objects.before = async (_, file) => { await fs.writeFile(file, "partial"); throw Error("dummy_download"); };
  await assert.rejects(history(f.store), /dummy_download/); await empty(f.store, f.root);
  f.objects.before = undefined;
  f.objects.files.set(name("NQ"), original.subarray(0, original.length - 5));
  await assert.rejects(history(f.store)); await empty(f.store, f.root);
  f.objects.files.set(name("NQ"), gzipSync("{invalid}\n"));
  await assert.rejects(history(f.store)); await empty(f.store, f.root);
  f.objects.files.set(name("NQ"), original);
  assert.equal((await history(f.store)).rows.length, 1); await empty(f.store, f.root);
});

test("ダミー：直近・書込中・partial coverageは既存経路、起動SHA照合は別計数", async t => {
  const rows = [tick(H + 3, 1)];
  const recent = await fixture(t, rows, "NQ", [[H, H + 3600]], H + 2 * 3600);
  await history(recent.store); assert.equal(recent.store.tradeReadStats.gzipScans, 0);
  const partial = await fixture(t, rows, "NQ", [[H, H + 900]]);
  assert.equal((await history(partial.store, H, H + 900)).rows.length, 1);
  assert.equal(partial.store.tradeReadStats.gzipScans, 0);
  const cached = await fixture(t, rows);
  const file = path.join(cached.root, "trades/NQ/2026-10-25/00.jsonl.gz");
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, encode(rows));
  const restarted = new AppStore(cached.root, cached.objects, "dev/", noop, () => (H + 80 * 3600) * 1000);
  cached.objects.reads = []; await restarted.initialize();
  assert.equal(cached.objects.reads.filter(n => n.endsWith(".gz")).length, 1); // existing SHA verification
  cached.objects.reads = []; await history(restarted);
  assert.equal(cached.objects.reads.length, 0); assert.equal(restarted.tradeReadStats.gzipScans, 1);
  await empty(restarted, cached.root);
  // A locally modified/unconfirmed closed file must not reuse the cloud snapshot.
  await fs.writeFile(file, encode([tick(H + 3, 7)]));
  assert.deepEqual((await history(restarted)).rows, [tick(H + 3, 7)]);
  assert.equal(restarted.tradeReadStats.gzipScans, 1);
  await empty(restarted, cached.root);
});
