import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as wait, setImmediate as turn } from "node:timers/promises";
import { coverageSegments } from "../src/vp/trade-history.ts";
import { readRecordedTradeRange } from "../src/vp/trade-history.ts";
import type { LocalStore } from "../src/store/local.ts";
import type { Trade } from "../src/types.ts";
import { MainThreadMonitor, namedWork } from "../src/diagnostics/main-thread.ts";
import { AutoCpuProfile, profileJson, profileSummary, type CpuProfile } from "../src/diagnostics/cpu-profile.ts";
import { atET } from "../src/long-vp/calendar.ts";
import { dayBounds, tradingGaps, nextFinalizeUs, serializeDay } from "../src/long-vp/day.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";

function reference(ranges: [number, number][], start: number, end: number) {
  const result = [];
  for (let a = start; a < end;) {
    const covered = ranges.some(([x, y]) => x <= a && a < y);
    const b = Math.min(end, ...ranges.flat().filter(x => x > a && x < end));
    result.push({ start: a, end: b, covered }); a = b;
  }
  return result;
}
test("ダミー：coverage sweepは重複・半開境界・逆順・ゼロ長も旧結果と一致", () => {
  for (let seed = 0; seed < 100; seed++) {
    const ranges: [number, number][] = Array.from({ length: 30 }, (_, i) => {
      const a = ((i * 17 + seed * 23) % 120) - 10;
      return [a, a + ((i * 7 + seed) % 31) - 3];
    });
    assert.deepEqual(coverageSegments(ranges, 0, 100), reference(ranges, 0, 100));
    assert.deepEqual(coverageSegments(ranges, 10, 10), []);
  }
});
test("ダミー：3730区間を一回のsweepで扱い、入力を変更しない", () => {
  const ranges: [number, number][] = Array.from({ length: 3730 }, (_, i) => [i * 20, i * 20 + 10]);
  const copy = structuredClone(ranges);
  assert.equal(coverageSegments(ranges, 0, 74600).length, 7460);
  assert.deepEqual(ranges, copy);
});
test("ダミー：1000個のcoverage境界でも物理窓は1回、巻戻り・同内容別約定・限月を維持、例外もclose", async () => {
  const trades = [7, 8, 9].map((seq, i) => ({ tsUs: (i === 1 ? 200 : 201) * 1e6,
    recvUs: 300e6 + seq, seq, price: 400, size: 3, side: "buy", contract: "GCZ6" } as Trade));
  let reads = 0, closes = 0;
  const store = {
    recordedTickCoverage: async () => Array.from({ length: 1000 }, (_, i) => [i / 2, i / 2 + .25]),
    tradeReadSession: () => ({ visit: async (_a: number, _b: number, visit: (t: Trade) => void) => {
      reads++; trades.forEach(visit);
    }, close: async () => { closes++; } }),
  } as unknown as LocalStore;
  const output: Trade[] = [];
  await readRecordedTradeRange({ store, start: 0, end: 500,
    signal: new AbortController().signal, visit: t => output.push(t) });
  assert.equal(reads, 1); assert.equal(closes, 1); assert.deepEqual(output, trades);
  await assert.rejects(readRecordedTradeRange({ store, start: 0, end: 500,
    signal: new AbortController().signal, visit: () => { throw Error("dummy_interrupt"); } }), /dummy_interrupt/);
  assert.equal(closes, 2);
});
test("ダミー：休止は欠けから除外し、日次の帰属境界とDST・17:05は維持", () => {
  for (const date of ["2026-10-30", "2026-11-02", "2026-11-03"]) {
    const b = dayBounds(date), close = atET(date, 17) / 1e6;
    assert.deepEqual(tradingGaps(date, [[close, b.endUs / 1e6]]), []);
    assert.deepEqual(tradingGaps(date, [[close - 10, b.endUs / 1e6]]), [[close - 10, close]]);
    assert.equal(serializeDay(date, new LongAggregate(), [], [[close, b.endUs / 1e6]], b.endUs + 300e6).complete, true);
    assert.equal(nextFinalizeUs(atET(date, 18)), atET(date, 18, 5));
  }
  assert.equal(atET("2026-11-02", 18, 5), Date.parse("2026-11-02T23:05:00Z") * 1000);
});
const profile: CpuProfile = { startTime: 0, endTime: 10000,
  nodes: [{ id: 2, callFrame: { functionName: "leaf", url: "file:///safe.ts", lineNumber: 2 } },
    { id: 1, callFrame: { functionName: "root", url: "", lineNumber: -1 }, children: [2] }],
  samples: [2, 2], timeDeltas: [4000, 6000] };
test("ダミー：プロファイル要約は配列順に依存せずself/totalを算出", async () => {
  const result = await profileSummary(profile);
  assert.equal(result.selfTop30[0].selfMs, 10);
  assert.equal(result.totalTop20.find(n => n.function === "root")?.totalMs, 10);
});
test("ダミー：秘密値・JSONエスケープ済み秘密値を含むprofileを拒否", async () => {
  const read = async (p: CpuProfile, secrets: string[]) => { let text = ""; for await (const s of profileJson(p, secrets)) text += s; return text; };
  assert.deepEqual(JSON.parse(await read(profile, ["dummy-private-value"])), profile);
  for (const secret of ["dummy-private-value", 'dummy"private\\value']) {
    const bad = structuredClone(profile); bad.nodes[0].callFrame.url += "?key=" + secret;
    await assert.rejects(read(bad, [secret]), /profile_secret_detected/);
  }
});
test("ダミー：自動inspector Sessionは2回の5秒停止で起動、1時間抑制、終了と保持", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "main-stall-profile-"));
  let now = 1000000;
  const logs: string[] = [];
  const monitor = new AutoCpuProfile({ directory: root, prefix: "dev/", secrets: [],
    durationMs: 20, now: () => now, log: e => { logs.push(e); } });
  t.after(async () => { await monitor.stop(); await fs.rm(root, { recursive: true, force: true }); });
  monitor.observe(5000); assert.equal(monitor.snapshot().active, false);
  monitor.observe(5000);
  for (let i = 0; i < 100 && monitor.snapshot().summaries.length === 0; i++) await wait(10);
  assert.equal(monitor.snapshot().summaries.length, 1);
  monitor.observe(6000); monitor.observe(6000); await wait(30);
  assert.equal(logs.filter(e => e === "cpu_profile_started").length, 1);
  now += 3600001; monitor.observe(5000); monitor.observe(5000);
  for (let i = 0; i < 100 && monitor.snapshot().summaries.length < 2; i++) await wait(10);
  assert.equal(monitor.snapshot().summaries.length, 2);
  assert.equal(logs.filter(e => e === "cpu_profile_started").length, 2);
  for (let n = 0; n < 4; n++) {
    now += 3600001; monitor.observe(5000); monitor.observe(5000);
    for (let i = 0; i < 100 && logs.filter(e => e === "cpu_profile_saved").length < n + 3; i++) await wait(10);
  }
  assert.equal(monitor.snapshot().summaries.length, 3);
  assert.equal((await fs.readdir(root)).filter(f => f.endsWith(".json.gz")).length, 5);
});
test("ダミー：threadCpuUsage取得不能はnull、長いcallbackとGC観測・終了", async t => {
  const original = process.threadCpuUsage;
  Object.defineProperty(process, "threadCpuUsage", { value: undefined, configurable: true, writable: true });
  let unavailable: MainThreadMonitor;
  try {
    unavailable = new MainThreadMonitor(() => {});
    assert.equal(unavailable.snapshot().threadCpuAvailable, false);
    assert.equal(unavailable.snapshot().mainCores, null);
  } finally { process.threadCpuUsage = original; }
  const m = new MainThreadMonitor(() => {}, () => {}, true); m.start(); t.after(() => m.stop());
  await namedWork("dummy-heavy", () => new Promise<void>(resolve => setImmediate(() => {
    const start = performance.now(); while (performance.now() - start < 210) { /* explicit synthetic stall */ }
    resolve();
  })));
  await turn();
  assert.ok(m.snapshot().longCallbacks.some(x => x.name.startsWith("dummy-heavy/")));
  assert.ok(m.snapshot().longCallbackMaxMs >= 200);
  m.stop(); assert.equal(m.snapshot().trackedResources, 0);
});
