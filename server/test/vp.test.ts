import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { sessionStartSec, VolumeProfile } from "../src/vp/state.ts";
import { VpHistory, coverageSegments } from "../src/vp/history.ts";
import { LocalStore } from "../src/store/local.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import { WindowUnavailableError } from "../src/history/client.ts";
import { Hub } from "../src/hub/hub.ts";
import type { Trade } from "../src/types.ts";
const sec = (s: string) => Date.parse(s) / 1000;
const L = sec("2026-10-27T00:00:00Z"), start = sec("2026-10-26T22:00:00Z");
const trade = (second: number, seq = 1, size = 2): Trade =>
  ({ tsUs: second * 1e6, recvUs: second * 1e6, seq, price: 400, size, side: "buy" });

test("ダミー：Chicago17時の夏冬・11月1日の25時間・日曜開始・16〜17時を終わる側に含める", () => {
  for (const [time, expected] of [
    ["2026-10-27T21:59:59Z", "2026-10-26T22:00:00Z"],
    ["2026-10-27T22:00:00Z", "2026-10-27T22:00:00Z"],
    ["2026-11-01T22:59:59Z", "2026-10-31T22:00:00Z"],
    ["2026-11-01T23:00:00Z", "2026-11-01T23:00:00Z"],
    ["2026-03-08T21:59:59Z", "2026-03-07T23:00:00Z"],
    ["2026-03-08T22:00:00Z", "2026-03-08T22:00:00Z"],
    ["2026-10-25T22:00:00Z", "2026-10-25T22:00:00Z"],
    ["2026-12-01T22:30:00Z", "2026-11-30T23:00:00Z"],
  ]) assert.equal(sessionStartSec(sec(time)), sec(expected), time);
});
test("ダミー：同内容の約定を消さず売買合計、差分は新合計、セッション変更でゼロ", () => {
  const vp = new VolumeProfile(L);
  vp.add(trade(L)); vp.add(trade(L));
  const revision = vp.revision;
  vp.add({ ...trade(L, 3, 3), side: "sell" });
  assert.deepEqual(vp.message(revision).levels, [[400, 4, 3]]);
  assert.equal(vp.summary().total, 7);
  vp.advance(sec("2026-10-27T22:00:00Z")); vp.add(trade(L));
  assert.equal(vp.message().levels.length, 0); assert.equal(vp.loading, false);
});
test("ダミー：被覆記録の半開区間をつなぎ、ファイルだけで取得済みにしない", () => {
  assert.deepEqual(coverageSegments([[10, 20], [25, 30]], 5, 32), [
    { start: 5, end: 10, covered: false }, { start: 10, end: 20, covered: true },
    { start: 20, end: 25, covered: false }, { start: 25, end: 30, covered: true },
    { start: 30, end: 32, covered: false }]);
});
test("ダミー：ファイル/不足混在・900秒窓・truncated分割・L分離・部分ファイルを置換保存", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-vp-"));
  let store = new LocalStore(root, () => (L + 2000) * 1000);
  try {
    await store.initialize();
    await store.addTrades([trade(start), trade(start + 900, 2, 999), trade(L, 3, 7)]);
    // Deliberately keep a partial row on disk but remove its interval coverage.
    await fs.writeFile(path.join(root, "coverage.json"), JSON.stringify({ book: [], tick: [[start, start + 900]] }));
    store = new LocalStore(root, () => (L + 2000) * 1000);
    await store.initialize();
    // Ordinary maintenance must not promote a recovered partial file to VP coverage.
    await store.maintenance();
    assert.deepEqual(await store.recordedTickCoverage(), [[start, start + 900]]);
    const vp = new VolumeProfile(L);
    vp.add(trade(L, 3, 7)); // Live is owned at/after L only.
    const requests: [number, number][] = [];
    let seq = 10;
    const job = new VpHistory(vp, { get: async (_k, a, b) => {
      requests.push([a, b]);
      if (a === start + 900 && b - a === 900) return { rows: [], truncated: true };
      return { rows: [{ ts: a * 1e6, price: 100, size: 2, side: "buy" },
        { ts: b * 1e6, price: 100, size: 1000, side: "buy" }], truncated: false };
    } }, store, new Metrics(() => {}), () => seq++, () => {},
    { now: () => (L + 2000) * 1000, wait: async () => {} });
    job.start(L, Promise.resolve()); await job.settled();
    assert.equal(job.state.state, "complete"); assert.equal(vp.loading, false);
    assert.ok(requests.every(([a, b]) => a >= start + 900 && b <= L && b - a <= 900));
    assert.equal(job.state.splitRequests, 1);
    assert.equal(job.state.fileSeconds, 900);
    const read: Trade[] = []; await store.visitTrades(start, L + 1, t => read.push(t));
    assert.ok(!read.some(t => t.size === 999)); // Old uncovered partial data was not appended twice.
    assert.equal(read.reduce((n, t) => n + t.size, 0), vp.summary().total);
    assert.equal(read.filter(t => t.tsUs === L * 1e6).length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("ダミー：3回失敗の窓は欠け、集計から除いてloading:false", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-vp-gap-"));
  try {
    const store = new LocalStore(root, () => (L + 2000) * 1000); await store.initialize();
    const vp = new VolumeProfile(L);
    const job = new VpHistory(vp, { get: async () => { throw new WindowUnavailableError("network_or_timeout"); } },
      store, new Metrics(() => {}), () => 1, () => {});
    job.start(L, Promise.resolve()); await job.settled();
    assert.equal(job.state.gaps.length, 8); assert.equal(vp.loading, false);
    assert.equal(vp.summary().total, 0); assert.equal((await store.recordedTickCoverage()).length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("ダミー：VPは板取り込み後だけ開始、成熟5分待ち、直近0行は初回＋再取得3回", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-vp-maturity-"));
  try {
    let now = (L + 10) * 1000, calls = 0, release!: () => void;
    const waits: number[] = [];
    const store = new LocalStore(root, () => now); await store.initialize();
    store.markCovered("tick", start, L - 60); await store.flush();
    const vp = new VolumeProfile(L);
    const job = new VpHistory(vp, { get: async () => { calls++; return { rows: [], truncated: false }; } },
      store, new Metrics(() => {}), () => 1, () => {},
      { now: () => now, wait: async ms => { waits.push(ms); now += ms; } });
    job.start(L, new Promise<void>(r => { release = r; }));
    await Promise.resolve(); assert.equal(calls, 0); assert.equal(job.state.state, "waiting");
    release(); await job.settled();
    assert.deepEqual(waits, [290000, 120000, 120000, 120000]);
    assert.equal(calls, 4); assert.equal(job.state.emptyRetries, 3);
    assert.equal(job.state.noData[0].attempts, 4); assert.equal(vp.loading, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("ダミー：hello/初期rangeDoneの後にVP、1秒に変わった価格だけ、完了で全再送", async () => {
  class Socket extends EventEmitter {
    readyState = 1; bufferedAmount = 0; messages: any[] = [];
    send(data: string | Buffer, cb?: () => void) { if (typeof data === "string") this.messages.push(JSON.parse(data)); cb?.(); }
    close() { this.readyState = 3; this.emit("close", 1000); }
    terminate() { this.close(); }
  }
  let now = L * 1000; const vp = new VolumeProfile(L);
  const hub = new Hub({ savedRange: () => null, read: async () => ({ columns: [], trades: [] }),
    status: () => ({}), vp: () => vp }, () => {},
  { now: () => now, later: () => 0, cancel: () => {} });
  const socket = new Socket();
  try {
    await hub.connect(socket, new URL("http://localhost/api/ws"));
    assert.deepEqual(socket.messages.slice(0, 2).map(x => x.type), ["hello", "rangeTrades"]);
    assert.ok(socket.messages.findIndex(x => x.type === "vp") > socket.messages.findIndex(x => x.type === "rangeDone"));
    vp.add(trade(L)); hub.flush();
    assert.equal(socket.messages.filter(x => x.type === "vpUpdate").length, 0);
    now += 1000; hub.flush();
    assert.deepEqual(socket.messages.find(x => x.type === "vpUpdate").levels, [[400, 2, 0]]);
    now += 1000; hub.flush();
    assert.equal(socket.messages.filter(x => x.type === "vpUpdate").length, 1);
    vp.complete(start); now += 1000; hub.flush();
    assert.equal(socket.messages.at(-1).type, "vp"); assert.equal(socket.messages.at(-1).loading, false);
  } finally { hub.stop(); }
});
