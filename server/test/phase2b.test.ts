import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeFrame, decodeFrame, parseRange } from "../src/hub/frame.ts";
import { Hub, BOARD_LIMIT, CLOSE_LIMIT } from "../src/hub/hub.ts";
import type { Source } from "../src/hub/hub.ts";
import { Replay } from "../src/hub/replay.ts";
import type { ReplayClock } from "../src/hub/replay.ts";
import type { Column } from "../src/aggregate/columns.ts";
import type { Trade } from "../src/types.ts";
import { LocalStore } from "../src/store/local.ts";
import { Backfill } from "../src/history/backfill.ts";
import { Metrics } from "../src/ingest/metrics.ts";

class Clock implements ReplayClock {
  time = 10000000; next = 0; tasks = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  later = (fn: () => void, ms: number) => { const id = ++this.next; this.tasks.set(id, { at: this.time + ms, fn }); return id; };
  cancel = (id: unknown) => { this.tasks.delete(id as number); };
  advance(ms: number) {
    const end = this.time + ms; let safety = 0;
    for (;;) {
      const next = [...this.tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++safety < 100000, "timer loop");
      this.tasks.delete(next[0]); this.time = next[1].at; next[1].fn();
    }
    this.time = end;
  }
}
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; output: (string | Buffer)[] = []; codes: number[] = [];
  send(data: string | Buffer, cb?: (e?: Error) => void) { this.output.push(data); cb?.(); }
  close(code: number) { this.codes.push(code); this.readyState = 3; this.emit("close"); }
  terminate() { this.readyState = 3; this.emit("close"); }
  json() { return this.output.filter(x => typeof x === "string").map(x => JSON.parse(x as string)); }
  frames() { return this.output.filter(Buffer.isBuffer).map(decodeFrame); }
}
const col = (sec: number, size = 1): Column => ({ tsSec: sec, source: "live",
  bids: [{ price: 400, size }], asks: [{ price: 401, size: 2 }] });
const trade = (us: number, seq = 1): Trade => ({ tsUs: us, recvUs: us, seq, price: 401, size: 1, side: "buy" });
const url = (suffix = "") => new URL(`http://localhost/api/ws${suffix}`);
function source(columns: Column[] = [], trades: Trade[] = []): Source {
  return { savedRange: () => ({ fromSec: 1, toSec: 10001 }),
    read: async (a, b) => ({ columns: columns.filter(c => c.tsSec >= a && c.tsSec < b),
      trades: trades.filter(t => t.tsUs >= a * 1e6 && t.tsUs < b * 1e6) }),
    status: () => ({ upstream: { state: "dummy" } }) };
}

for (const kind of [1, 2, 3] as const) test(`ダミー：kind ${kind} フレームのLE往復・個数・reqId`, () => {
  const columns = kind === 2 ? [col(10), col(11)] : [col(10)];
  const frame = encodeFrame(kind, kind === 2 ? 23 : 0, columns);
  assert.equal(frame.readUInt32LE(1), kind === 2 ? 23 : 0);
  assert.deepEqual(decodeFrame(frame), { kind, reqId: kind === 2 ? 23 : 0, columns });
  assert.throws(() => decodeFrame(frame.subarray(0, -1)));
  const invalid = Buffer.from(frame); invalid.writeUInt32LE(9, 5); assert.throws(() => decodeFrame(invalid));
});
test("ダミー：rangeは60分・uint32整数・非空半開区間、不正値を拒否", () => {
  const good = { op: "range", reqId: 1, fromSec: 10, toSec: 3610 };
  assert.deepEqual(parseRange(good), { reqId: 1, fromSec: 10, toSec: 3610 });
  for (const r of [{ ...good, toSec: 3611 }, { ...good, fromSec: 4000 }, { ...good, fromSec: "10" },
    { ...good, fromSec: NaN }, { ...good, fromSec: -1 }, { ...good, reqId: 0 },
    { ...good, fromSec: 10.5 }, { ...good, toSec: 10 }, { ...good, reqId: 2 ** 32 }]) assert.throws(() => parseRange(r));
});
test("ダミー：hello・初回範囲・ライブの順、最新の板と約定を250msでまとめる", async () => {
  const clock = new Clock(), hub = new Hub(source([col(9999)]), () => {}, clock), s = new Socket();
  await hub.connect(s, url());
  assert.equal((JSON.parse(s.output[0] as string)).type, "hello");
  assert.equal(decodeFrame(s.output[1] as Buffer).kind, 2);
  assert.equal(JSON.parse(s.output[2] as string).type, "rangeTrades");
  s.output = [];
  hub.book({ tsUs: 10000e6, recvUs: 10000e6, source: "live", bids: col(10000).bids, asks: col(10000).asks });
  hub.book({ tsUs: 10000e6, recvUs: 10000e6, source: "live", bids: col(10000, 9).bids, asks: col(10000).asks });
  hub.trade(trade(10000e6, 1)); hub.trade(trade(10000e6, 2));
  clock.advance(249); assert.equal(s.output.length, 0);
  clock.advance(1);
  assert.equal(s.frames().filter(f => f.kind === 3).length, 1);
  assert.equal(s.frames()[0].columns[0].bids[0].size, 9);
  assert.deepEqual(s.json().find(j => j.type === "trades").trades.map((t: Trade) => t.seq), [1, 2]);
  clock.advance(250); assert.equal(s.frames().filter(f => f.kind === 3).length, 2);
  assert.equal(s.json().filter(j => j.type === "trades").length, 1);
  hub.stop();
});
test("ダミー：4MiB超は板だけ落とし、16MiB超で切断、他の接続は継続", async () => {
  const clock = new Clock(), hub = new Hub(source(), () => {}, clock), slow = new Socket(), fast = new Socket();
  await hub.connect(slow, url()); await hub.connect(fast, url()); slow.output = []; fast.output = [];
  slow.bufferedAmount = BOARD_LIMIT + 1;
  hub.book({ tsUs: 10000e6, recvUs: 10000e6, source: "live", bids: col(10000).bids, asks: col(10000).asks });
  hub.column(col(10000)); hub.trade(trade(10000e6)); clock.advance(250);
  assert.deepEqual(slow.frames().map(f => f.kind), [1]);
  assert.equal(slow.json().filter(j => j.type === "trades").length, 1);
  assert.equal(hub.snapshot().droppedBoards, 1);
  slow.bufferedAmount = CLOSE_LIMIT + 1; clock.advance(250);
  assert.deepEqual(slow.codes, [1013]); assert.equal(hub.snapshot().slowClosed, 1);
  hub.column(col(10001)); assert.ok(fast.frames().some(f => f.kind === 1 && f.columns[0].tsSec === 10001));
  hub.stop();
});
test("ダミー：6台目拒否・閉じた枠の再利用", async () => {
  const hub = new Hub(source(), () => {}, new Clock()), sockets = Array.from({ length: 6 }, () => new Socket());
  for (const s of sockets) await hub.connect(s, url());
  assert.deepEqual(sockets[5].codes, [1013]); assert.equal(sockets[5].json()[0].type, "error");
  assert.equal(hub.snapshot().connected, 5); assert.equal(hub.snapshot().rejectedConnections, 1);
  sockets[0].close(1000); await hub.connect(new Socket(), url()); assert.equal(hub.snapshot().connected, 5); hub.stop();
});
test("ダミー：初回読込中の列・約定を保持し、重なりだけ除く。同じ内容の別約定は保持", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; }), clock = new Clock(), src = source();
  const first = trade(9999e6, 1), second = trade(9999e6, 2);
  src.read = async (a, b) => { await gate; return {
    columns: [col(9999)].filter(c => c.tsSec >= a && c.tsSec < b),
    trades: [first].filter(t => t.tsUs >= a * 1e6 && t.tsUs < b * 1e6) }; };
  const hub = new Hub(src, () => {}, clock), s = new Socket(), connecting = hub.connect(s, url());
  hub.column(col(9999)); hub.column(col(10000)); hub.trade(first); hub.trade(second);
  clock.advance(250); assert.equal(s.output.length, 1); // hello only
  release(); await connecting; clock.advance(250);
  assert.deepEqual(s.frames().filter(f => f.columns.length).map(f => [f.kind, f.columns.map(c => c.tsSec)]), [[2, [9999]], [1, [10000]]]);
  assert.deepEqual(s.json().find(j => j.type === "trades").trades.map((t: Trade) => t.seq), [2]); hub.stop();
});
test("ダミー：rangeの空区間を埋めず、kind2直後にrangeTrades。不正要求はerror", async () => {
  const hub = new Hub(source([col(10), col(12)], [trade(10e6)]), () => {}, new Clock()), s = new Socket();
  await hub.connect(s, url()); s.output = [];
  s.emit("message", Buffer.from(JSON.stringify({ op: "range", reqId: 7, fromSec: 10, toSec: 13 })), false);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(decodeFrame(s.output[0] as Buffer).columns.map(c => c.tsSec), [10, 12]);
  assert.equal(JSON.parse(s.output[1] as string).reqId, 7);
  s.emit("message", Buffer.from(JSON.stringify({ op: "range", reqId: 8, fromSec: 20, toSec: 10 })), false);
  await new Promise(r => setImmediate(r));
  assert.equal(s.json().at(-1).type, "error"); assert.equal(s.json().at(-1).reqId, 8); hub.stop();
});
for (const speed of [1, 2, 5, 10]) test(`ダミー：リプレイspeed=${speed}、250ms仮想時間・終了・逆行約定保持`, () => {
  const clock = new Clock(), at: number[] = [], sizes: number[] = [], seqs: number[] = []; let ended = 0;
  const replay = new Replay([col(10), col(11), col(13)], [trade(10e6 + 200, 1), trade(10e6 + 100, 2),
    trade(11e6 + 500000, 3)], 10, 14, speed, {
    column: () => at.push(clock.now()), trades: ts => { sizes.push(ts.length); seqs.push(...ts.map(t => t.seq)); },
    end: () => { ended++; },
  }, clock);
  replay.start(); assert.equal(at.length, 1);
  clock.advance(1000 / speed); assert.equal(at[1] - at[0], 1000 / speed);
  clock.advance(3000 / speed); assert.equal(ended, 1); assert.deepEqual(seqs, [1, 2, 3]);
  assert.deepEqual(sizes, [2, 1]); assert.equal(at[2] - at[1], 2000 / speed);
  clock.advance(10000); assert.equal(ended, 1); replay.stop();
});
test("ダミー：replay中も別接続へライブ、終了status、不正パラメータ切断", async () => {
  const clock = new Clock(), src = source([col(9999), col(10000)]);
  const hub = new Hub(src, () => {}, clock), live = new Socket(), replay = new Socket();
  await hub.connect(live, url()); await hub.connect(replay, url("?mode=replay&from=9999&speed=10"));
  hub.column(col(10001)); hub.trade(trade(10001e6)); clock.advance(250);
  assert.ok(live.frames().some(f => f.kind === 1 && f.columns[0].tsSec === 10001));
  assert.ok(!replay.frames().some(f => f.kind === 1 && f.columns[0].tsSec === 10001));
  assert.ok(replay.json().some(j => j.type === "status" && j.replay?.state === "ended"));
  for (const suffix of ["?mode=replay&from=9999&speed=3", "?mode=replay&from=no&speed=1", "?mode=x", "?mode=replay&from=10001&speed=1"]) {
    const invalid = new Socket(); await hub.connect(invalid, url(suffix));
    assert.equal(invalid.json()[0].type, "error"); assert.deepEqual(invalid.codes, [1008]);
  }
  hub.stop();
});
test("ダミー：状態は変化時と10秒ごと", async () => {
  const clock = new Clock(), src = source(); let value = 0; src.status = () => ({ value });
  const hub = new Hub(src, () => {}, clock), s = new Socket(); await hub.connect(s, url()); s.output = [];
  clock.advance(9999); assert.equal(s.json().length, 0); clock.advance(1); assert.equal(s.json().length, 1);
  value++; clock.advance(250); assert.equal(s.json().length, 2); hub.stop();
});
test("ダミー：5分未満の窓を後回しにし古い窓を先に取得。保存待ち列・約定も読める", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-phase2b-"));
  const L = Math.floor(Date.now() / 1000); let now = L * 1000;
  const store = new LocalStore(root), calls: { start: number; end: number; at: number }[] = [];
  try {
    await store.initialize();
    store.markCovered("book", L - 10800, L - 360); store.markCovered("tick", L - 10800, L);
    const backfill = new Backfill({ get: async (_kind, start, end) => {
      calls.push({ start, end, at: now }); return { rows: [], truncated: false };
    } }, store, new Metrics(() => {}), () => 1, () => {}, {
      now: () => now, wait: async ms => { now += ms; },
    });
    backfill.start(L); await backfill.settled();
    assert.equal(calls[0].end, L - 300);
    assert.ok(calls.every(c => c.at >= (c.end + 300) * 1000));
    assert.equal(backfill.status.pendingMaturity.length, 0); assert.equal(backfill.status.state, "complete");
    store.hold(L, L + 60); await store.addColumns([col(L)]); await store.addTrades([trade(L * 1e6)]);
    const before = await store.readView(L, L + 2);
    assert.deepEqual(before.columns, [col(L)]); assert.equal(before.trades.length, 1);
    assert.equal((await store.readColumns(L, L + 2)).length, 0);
    await store.flush();
    assert.deepEqual(await store.readView(L, L + 2), before);
    assert.deepEqual(store.savedRange, { fromSec: L, toSec: L + 1 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
