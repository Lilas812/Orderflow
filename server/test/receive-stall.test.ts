import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { HistoryProcess } from "../src/history/process.ts";
import { decodedColumns, decodedTrades } from "../src/history/prepared.ts";
import { historyColumns, historyTrades } from "../src/history/decode.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import { encodeColumns } from "../src/store/binary.ts";
import { CpuPressure, cgroupV2, procSteal } from "../src/diagnostics/cpu-pressure.ts";
import { LocalStore } from "../src/store/local.ts";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trade } from "../src/types.ts";
import { LiveGapRepair } from "../src/history/live-gap.ts";
import { WorkCpu } from "../src/diagnostics/work-cpu.ts";

const metrics = () => new Metrics(() => {});
test("ダミー：CPUは同期thread時間のみを帰属し、入れ子を二重計上せず非同期分はother", async t => {
  let us = 0;
  const counter = (previous?: NodeJS.CpuUsage) => ({ user: us - (previous?.user ?? 0), system: 0 });
  t.mock.method(process, "cpuUsage", counter);
  t.mock.method(process, "threadCpuUsage", counter);
  const cpu = new WorkCpu();
  cpu.measure("live", () => { us += 10; cpu.measure("delivery", () => { us += 5; }); us += 10; });
  await cpu.measure("storage", async () => { await Promise.resolve(); us += 100; });
  cpu.sample();
  const snapshot = cpu.snapshot(), value = (cores: number | null) =>
    Math.round(cores! * snapshot.observedSeconds * 1e6);
  assert.equal(value(snapshot.live), 20);
  assert.equal(value(snapshot.deliverySync), 5);
  assert.equal(value(snapshot.storageSync), 0);
  assert.equal(value(snapshot.otherParent), 100);
  assert.equal(value(snapshot.parentTotal), 125);
});
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: Server) {
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
}
function bookRows(symbol: "NQ" | "GC", ts: number) {
  const tick = symbol === "NQ" ? .25 : .1, center = symbol === "NQ" ? 80000 : 40000;
  return ["bid", "ask"].flatMap(side => Array.from({ length: 400 }, (_, i) => ({
    ts, side, level: i + 1, flag: 0, price: (center + (side === "bid" ? -1 : 1) * (i + 1)) * tick, size: i + 1,
  })));
}
test("ダミー：cgroup v2・v1、stealの窓と取得不能を区別", async () => {
  const missing = new CpuPressure(async () => { throw Error("missing"); });
  await missing.sample();
  assert.equal(missing.snapshot().cgroup.available, false);
  assert.equal(missing.snapshot().steal.available, false);
  assert.equal(missing.snapshot().throttledRatio, null);
  assert.equal(cgroupV2("50000 100000", "usage_usec 20\nnr_periods 10\nnr_throttled 3\nthrottled_usec 4").limitCores, .5);
  assert.deepEqual(procSteal("cpu 10 20 30 40 5 6 7 8 999 999"), { total: 126, steal: 8 });
  let at = 0;
  const pressure = new CpuPressure(async p => p.endsWith("cpu.max") ? "50000 100000"
    : p.endsWith("cpu.stat") ? `usage_usec ${at}\nnr_periods 10\nnr_throttled 3\nthrottled_usec ${at * 250}`
    : "cpu 10 20 30 40 5 6 7 8", () => at);
  await pressure.sample(); at = 60000; await pressure.sample();
  assert.equal(pressure.snapshot().throttledRatio, .25);
  const v1 = new CpuPressure(async p => {
    if (p.endsWith("cpu.cfs_quota_us")) return "50000";
    if (p.endsWith("cpu.cfs_period_us")) return "100000";
    if (p === "/sys/fs/cgroup/cpu/cpu.stat") return "nr_periods 5\nnr_throttled 2\nthrottled_time 2000";
    if (p.endsWith("cpuacct.usage")) return "3000";
    throw Error("missing");
  });
  await v1.sample(); assert.equal((v1.snapshot().cgroup as { version: number }).version, 1);
});

test("ダミー：子でNQ/GCの取得・正規化、優先度19、結果のバイト・正当な重複・巻戻りを維持", async () => {
  const start = 100000, end = start + 60;
  const server = await listen((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"), symbol = url.searchParams.get("symbol") as "NQ" | "GC";
    const rows = url.pathname.endsWith("book") ? bookRows(symbol, start * 1e6)
      : [{ ts: start * 1e6 + 2, price: 2000, size: 3, side: "buy", contract: "GCZ6" },
        { ts: start * 1e6 + 2, price: 2000, size: 3, side: "buy", contract: "GCZ6" },
        { ts: start * 1e6 + 1, price: 2000, size: 2, side: "sell", contract: "GCZ6" }];
    res.end(JSON.stringify({ [url.pathname.endsWith("book") ? "book" : "ticks"]: rows, truncated: false }));
  });
  const pool = new HistoryProcess("dummy-only", () => {}, undefined, server.origin);
  let pid: number | null = null;
  try {
    for (const symbol of ["NQ", "GC"] as const) {
      const source = pool.source(symbol), response = await source.get("book", start, end, new AbortController().signal);
      pid = pool.snapshot().childPid;
      assert.equal(pool.snapshot().priority, 19);
      assert.equal(pool.snapshot().heapLimitMiB, 256);
      assert.deepEqual(encodeColumns(decodedColumns(response, start, end, metrics(), symbol)),
        encodeColumns(historyColumns(bookRows(symbol, start * 1e6), start, end, metrics(), symbol)));
      const tick = await source.get("tick", start, end, new AbortController().signal);
      let a = 100, b = 100;
      const data = decodedTrades(tick, start, end, metrics(), () => ++a, symbol);
      assert.deepEqual(Buffer.from(JSON.stringify(data)), Buffer.from(JSON.stringify(historyTrades([
        { ts: start * 1e6 + 2, price: 2000, size: 3, side: "buy", contract: "GCZ6" },
        { ts: start * 1e6 + 2, price: 2000, size: 3, side: "buy", contract: "GCZ6" },
        { ts: start * 1e6 + 1, price: 2000, size: 2, side: "sell", contract: "GCZ6" },
      ], start, end, metrics(), () => ++b, symbol))));
      assert.equal(data.length, 3);
    }
  } finally { await pool.stop(); await close(server.server); }
  assert.equal(pool.snapshot().childPid, null);
  if (pid) assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
});

test("ダミー：子の異常終了で親を止めず、同じ窓を新しい子へ再要求", async () => {
  let requests = 0, pool: HistoryProcess;
  const server = await listen((_req, res) => {
    if (++requests === 1) { process.kill(pool.snapshot().childPid!, "SIGKILL"); return; }
    res.end('{"ticks":[],"truncated":false}');
  });
  pool = new HistoryProcess("dummy-only", () => {}, undefined, server.origin);
  try {
    await pool.source("GC").get("tick", 1, 2, new AbortController().signal);
    assert.equal(requests, 2); assert.equal(pool.snapshot().restarts, 1);
  } finally { await pool.stop(); await close(server.server); }
});

test("ダミー：受入制御は100ms/20%超で10秒ずつ待機し、復帰後だけ窓を要求", async () => {
  let requested = 0, waited = 0, loop = 101, throttle = .21;
  const server = await listen((_req, res) => { requested++; res.end('{"ticks":[],"truncated":false}'); });
  const pool = new HistoryProcess("dummy-only", () => {}, () => ({ loopP99Ms: loop, throttledRatio: throttle }),
    server.origin, async ms => {
      assert.equal(ms, 10000); assert.equal(requested, 0);
      if (++waited === 1) loop = 100;
      else throttle = .2;
    });
  try {
    await pool.source("NQ").get("tick", 1, 2, new AbortController().signal);
    assert.equal(waited, 2); assert.equal(requested, 1); assert.equal(pool.snapshot().admissionWaits, 2);
  } finally { await pool.stop(); await close(server.server); }
});

test("ダミー：受入待機中の停止は10秒待たず、キュー・子参照を解放", async () => {
  const pool = new HistoryProcess("dummy-only", () => {}, () => ({ loopP99Ms: 101, throttledRatio: null }));
  const jobs = [pool.source("NQ"), pool.source("GC")].map(s =>
    s.get("tick", 1, 2, new AbortController().signal).catch(() => {}));
  await new Promise<void>(r => setImmediate(r));
  const before = performance.now(); await pool.stop(); await Promise.all(jobs);
  assert(performance.now() - before < 500);
  assert.equal(pool.snapshot().childPid, null);
});

test("ダミー：中断した子の終了を待って並行要求の子を作る", async () => {
  let called!: () => void, firstPid: number | null = null, requests = 0;
  const entered = new Promise<void>(r => { called = r; });
  const server = await listen((_req, res) => {
    if (++requests === 1) { called(); return; }
    res.end('{"ticks":[],"truncated":false}');
  });
  const pool = new HistoryProcess("dummy-only", () => {}, undefined, server.origin);
  const abort = new AbortController();
  try {
    const first = pool.source("NQ").get("tick", 1, 2, abort.signal).catch(() => {});
    await entered; firstPid = pool.snapshot().childPid;
    const second = pool.source("GC").get("tick", 1, 2, new AbortController().signal);
    abort.abort(); await first; await second;
    assert.notEqual(pool.snapshot().childPid, firstPid);
    assert.throws(() => process.kill(firstPid!, 0), { code: "ESRCH" });
  } finally { await pool.stop(); await close(server.server); }
});

test("ダミー：並行要求の待ち列だけを中断しても、先行する別銘柄の取得を待たない", async () => {
  let entered!: () => void;
  const active = new Promise<void>(r => { entered = r; });
  const server = await listen(() => { entered(); });
  const pool = new HistoryProcess("dummy-only", () => {}, undefined, server.origin);
  try {
    const first = pool.source("NQ").get("tick", 1, 2, new AbortController().signal).catch(() => {});
    await active;
    const abort = new AbortController();
    const second = pool.source("GC").get("tick", 1, 2, abort.signal).catch(() => {});
    const start = performance.now(); abort.abort(); await second;
    assert(performance.now() - start < 500);
    await pool.stop(); await first;
  } finally { await pool.stop(); await close(server.server); }
});

const trade = (tsUs: number, seq: number, size = 1): Trade => ({
  tsUs, seq, recvUs: tsUs, price: 80000, size, side: "buy", contract: "NQZ6",
});
test("隔離保存：既存列・既存秒の巻戻り/同内容別約定を保護し、空秒だけ補完・再実行で加算なし", async () => {
  const root = await mkdtemp(join(tmpdir(), "gap-repair-")), start = 100000;
  const store = new LocalStore(root, () => (start + 1000) * 1000), m = metrics();
  try {
    await store.initialize();
    const original = historyColumns(bookRows("NQ", (start + 1) * 1e6), start, start + 3, m);
    await store.addColumns(original);
    const live = [trade((start + 1) * 1e6 + 2, 1, 5), trade((start + 1) * 1e6 + 2, 2, 5),
      trade((start + 1) * 1e6 + 1, 3, 7)];
    await store.addTrades(live); await store.flush();
    const columns = [0, 1, 2].flatMap(offset =>
      historyColumns(bookRows("NQ", (start + offset) * 1e6), start, start + 3, metrics()));
    columns[1].bids[0].size = 999;
    assert.equal(await store.repairMissingColumns(start, start + 3, columns), 2);
    let adopted: Trade[] = [];
    const incoming = [trade(start * 1e6 + 2, 11, 2), trade(start * 1e6 + 2, 12, 2),
      trade((start + 1) * 1e6, 13, 999), trade((start + 2) * 1e6, 14, 3)];
    const seams = await store.repairEmptyTradeSeconds(start, start + 3, incoming, saved => { adopted.push(...saved); });
    assert.deepEqual(seams, [{ startSec: start + 1, endSec: start + 2 }]);
    assert.equal(adopted.length, 3);
    const view = await store.readView(start, start + 3);
    assert.deepEqual(view.trades.filter(t => t.seq <= 3), live);
    assert.equal(view.trades.reduce((n, t) => n + t.size, 0), 24);
    assert.deepEqual(encodeColumns([view.columns[1]]), encodeColumns(original));
    await store.repairEmptyTradeSeconds(start, start + 3, incoming, saved => { adopted.push(...saved); });
    assert.equal(adopted.length, 3);
    assert.equal((await store.readView(start, start + 3)).trades.length, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("隔離保存：保留中のライブ秒も保護し、時間境界の空秒だけ確定する", async () => {
  const root = await mkdtemp(join(tmpdir(), "gap-boundary-")), start = 3600 - 1;
  const store = new LocalStore(root);
  try {
    await store.initialize(); store.hold(0, 3600);
    await store.addTrades([trade(start * 1e6, 1, 9)]);
    let count = 0;
    const seams = await store.repairEmptyTradeSeconds(start, start + 3,
      [trade(start * 1e6, 2, 999), trade((start + 1) * 1e6, 3), trade((start + 2) * 1e6, 4)],
      saved => { count += saved.length; });
    assert.deepEqual(seams, [{ startSec: start, endSec: start + 1 }]); assert.equal(count, 2);
    assert.deepEqual((await store.readView(start, start + 3)).trades.map(t => t.size), [9, 1, 1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("隔離保存：置換失敗では元約定・coverageを変えず、集計へ通知しない", async () => {
  const root = await mkdtemp(join(tmpdir(), "gap-failed-")), start = 100000;
  try {
    const initial = new LocalStore(root, () => (start + 1000) * 1000); await initial.initialize();
    await initial.addTrades([trade(start * 1e6, 1)]); await initial.flush();
    const directory = join(root, "trades/NQ/1970-01-02");
    const file = join(directory, (await readdir(directory))[0]);
    const bytes = await readFile(file), coverage = await readFile(join(root, "coverage.json"));
    const failed = new LocalStore(root, () => (start + 1000) * 1000, async () => { throw Error("dummy_rename_failed"); });
    await failed.initialize();
    let adopted = false;
    await assert.rejects(failed.repairEmptyTradeSeconds(start + 1, start + 2,
      [trade((start + 1) * 1e6, 2)], () => { adopted = true; }), /dummy_rename_failed/);
    assert.equal(adopted, false);
    assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(await readFile(join(root, "coverage.json")), coverage);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("隔離補完：5分成熟前は取得せず、取得成功分を1回採用し、既存LiveGapは消さない", async () => {
  const root = await mkdtemp(join(tmpdir(), "gap-service-")), start = 100000, end = start + 2;
  let now = (end + 299) * 1000, requests = 0, adopted = 0;
  const store = new LocalStore(root, () => now);
  const source = { symbol: "NQ" as const, async get(kind: string) {
    requests++;
    return { truncated: false, rows: kind === "book"
      ? [0, 1].flatMap(i => bookRows("NQ", (start + i) * 1e6))
      : [0, 1].map(i => ({ ts: (start + i) * 1e6, price: 20000, size: 5, side: "buy" })) };
  } };
  const repair = new LiveGapRepair(source, store, metrics(), () => 1, () => {},
    trades => { adopted += trades.reduce((n, t) => n + t.size, 0); }, () => now);
  const gaps = [{ startSec: start, endSec: end, reason: "no_accepted_live_book" }];
  try {
    await store.initialize(); repair.tick(gaps);
    assert.equal(requests, 0);
    now += 1000; repair.tick(gaps); await repair.settled();
    assert.equal(requests, 2); assert.equal(adopted, 10);
    repair.tick(gaps); await repair.settled();
    assert.equal(requests, 2); assert.equal(adopted, 10);
    assert.equal(gaps.length, 1); assert.equal(repair.status.columns, 2); assert.equal(repair.status.trades, 2);
    assert.equal(repair.status.unresolved.length, 0);
  } finally { await repair.stop(); await rm(root, { recursive: true, force: true }); }
});
