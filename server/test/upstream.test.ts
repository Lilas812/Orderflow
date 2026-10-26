import { test } from "node:test";
import assert from "node:assert/strict";
import { Upstream } from "../src/upstream/connection.ts";
import { Receiver } from "../src/ingest/receiver.ts";
import { reconnectDelay } from "../src/upstream/backoff.ts";

class DummySocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  send(value: string) { this.sent.push(value); }
  close() { this.closeCalls++; this.readyState = 2; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(value: unknown) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(value) }));
  }
  closed(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, wasClean: code === 1000 }));
  }
}

function fixture() {
  const sockets: DummySocket[] = [];
  const receiver = new Receiver(() => {});
  const upstream = new Upstream({
    apiKey: "ダミー", receiver, log: () => {}, now: () => Date.now(), random: () => 0.5,
    createSocket: (url) => {
      assert.ok(url.endsWith("symbols=NQ"));
      assert.ok(!sockets.some((s) => s.readyState !== 3), "ダミー：並行接続は常に1本以下");
      const socket = new DummySocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { sockets, receiver, upstream };
}

test("ダミー：バックオフは1,2,4…60秒、±20%、実待機上限60秒", () => {
  const delays = Array.from({ length: 10 }, (_, failures) => reconnectDelay({
    failures, connectedAtMs: null, nowMs: 0, random: 0.5, closeCode: 1006,
  }).delayMs);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
  for (const [random, expected] of [[0, 800], [1, 1200]]) {
    assert.equal(reconnectDelay({
      failures: 0, connectedAtMs: null, nowMs: 0, random, closeCode: 1006,
    }).delayMs, expected);
  }
  assert.equal(reconnectDelay({
    failures: 6, connectedAtMs: null, nowMs: 0, random: 1, closeCode: 1006,
  }).delayMs, 60000);
});

test("ダミー：5分接続後に1秒へリセット、4029は60秒基準", () => {
  const input = { failures: 6, connectedAtMs: 100, nowMs: 300100, random: 0.5, closeCode: 1006 };
  assert.deepEqual(reconnectDelay(input), { delayMs: 1000, nextFailures: 1 });
  assert.equal(reconnectDelay({ ...input, nowMs: 300099 }).delayMs, 60000);
  assert.equal(reconnectDelay({ ...input, closeCode: 4029 }).delayMs, 60000);
  const limited = reconnectDelay({ ...input, failures: 0, closeCode: 4029 });
  assert.equal(reconnectDelay({
    ...input, connectedAtMs: null, failures: limited.nextFailures,
  }).delayMs, 60000);
});

test("ダミー：30秒無受信でclose、close確認前は再接続しない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { upstream: u, sockets, receiver } = fixture();
  u.start(); u.start();
  const first = sockets[0];
  first.open();
  t.mock.timers.tick(29999);
  assert.equal(first.closeCalls, 0);
  t.mock.timers.tick(1);
  assert.equal(first.closeCalls, 1);
  assert.equal(receiver.metrics.counts.watchdog, 1);
  t.mock.timers.tick(5000);
  assert.equal(sockets.length, 1);
  first.closed();
  t.mock.timers.tick(999);
  assert.equal(sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 2);
  const stopped = u.stop(); sockets[1].closed(); await stopped;
});

test("ダミー：ping→pong、受信で死活タイマー更新、再接続で再購読", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { upstream: u, sockets } = fixture();
  u.start();
  const first = sockets[0];
  first.open();
  t.mock.timers.tick(25000);
  first.message({ type: "ping" });
  assert.deepEqual(first.sent, [
    '{"op":"subscribe","channel":"book","symbols":["NQ"]}', '{"op":"pong"}',
  ]);
  t.mock.timers.tick(10000);
  assert.equal(first.closeCalls, 0);
  u.reconnect("SIGUSR2");
  assert.equal(first.closeCalls, 1);
  first.closed(1000);
  t.mock.timers.tick(1000);
  sockets[1].open();
  assert.equal(sockets[1].sent[0], '{"op":"subscribe","channel":"book","symbols":["NQ"]}');
  assert.equal(u.status.reconnectCount, 1);
  const stopped = u.stop(); sockets[1].closed(); await stopped;
});

test("ダミー：remote closeは1000でも再接続、停止はcloseを待ち再接続しない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { upstream: u, sockets } = fixture();
  u.start(); sockets[0].open(); sockets[0].closed(1000);
  t.mock.timers.tick(1000);
  sockets[1].open();
  let resolved = false;
  const stopping = u.stop().then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(u.status.state, "closing");
  sockets[1].closed();
  await stopping;
  t.mock.timers.tick(120000);
  assert.equal(u.status.state, "stopped");
  assert.equal(sockets.length, 2);
});

test("ダミー：backoff中の停止は予定再接続を取り消す", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { upstream: u, sockets } = fixture();
  u.start(); sockets[0].closed(4029);
  assert.equal(u.status.retryDelayMs, 60000);
  await u.stop();
  t.mock.timers.tick(120000);
  assert.equal(sockets.length, 1);
});
