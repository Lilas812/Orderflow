import { test } from "node:test";
import assert from "node:assert/strict";
import { Upstream, type Socket, type SocketEvent } from "../src/upstream/connection.ts";
import { Receiver } from "../src/ingest/receiver.ts";
import { createLogger } from "../src/logger.ts";
import { EventLoopMonitor } from "../src/diagnostics/event-loop.ts";
import { createStatusApp, statusSnapshot } from "../src/status/app.ts";
import type { AddressInfo } from "node:net";

class DummySocket implements Socket {
  readyState = 0;
  listeners = new Map<string, (event: SocketEvent) => void>();
  closeCalls = 0;
  sent: string[] = [];
  addEventListener(type: string, fn: (event: SocketEvent) => void) { this.listeners.set(type, fn); }
  emit(type: string, details = {}) { this.listeners.get(type)?.(Object.assign(new Event(type), details)); }
  send(data: string) { this.sent.push(data); }
  close() { this.closeCalls++; }
}

test("ダミー：生メッセージ間隔・同期処理時間は有界の数値で、再接続の空白を混ぜない", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let clock = 0;
  const sockets: DummySocket[] = [];
  const receiver = new Receiver(() => {});
  const u = new Upstream({ apiKey: "dummy-never-used", symbols: ["NQ", "GC"], log: () => {},
    receiver: { metrics: receiver.metrics, receive: () => { clock += 7; } },
    monotonicNow: () => clock, random: () => 0.5, createSocket: () => {
      const s = new DummySocket(); sockets.push(s); return s;
    } });
  assert.equal(u.receiveDiagnostics().messageAgeMs, null);
  u.start(); sockets[0].emit("open");
  sockets[0].emit("message", { data: "dummy" });
  clock = 250;
  sockets[0].emit("message", { data: "dummy" });
  assert.equal(u.receiveDiagnostics().lastMessageGapMs, 250);
  assert.equal(u.receiveDiagnostics().lastReceiveMs, 7);
  assert.equal(u.receiveDiagnostics().messageAgeMs, 7);
  assert.equal(u.receiveDiagnostics().totalMessages, 2);
  u.reconnect("SIGUSR2"); sockets[0].emit("close", { code: 1000, wasClean: true });
  t.mock.timers.tick(1000);
  assert.equal(u.receiveDiagnostics().connectionMessages, 0);
  assert.equal(u.receiveDiagnostics().connectionLastReceivedUs, null);
  assert.equal(u.receiveDiagnostics().lastMessageGapMs, null);
  assert.equal(u.receiveDiagnostics().totalMessages, 2);
  // Late events from the released socket cannot update diagnostics.
  sockets[0].emit("message", { data: "dummy" });
  assert.equal(u.receiveDiagnostics().totalMessages, 2);
  const stopped = u.stop(); sockets[1].emit("close", { code: 1000 }); await stopped;
});

test("ダミー：watchdogの閾値と実経過・超過時間を区別し、再接続条件を維持", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let clock = 0;
  const rows: string[] = [], socket = new DummySocket();
  const receiver = new Receiver(() => {});
  const u = new Upstream({ apiKey: "dummy-secret", receiver,
    log: createLogger("dummy-secret", row => rows.push(row)),
    monotonicNow: () => clock, createSocket: () => socket,
    eventLoopSnapshot: () => ({ samples: 2, maxMs: 15000 }) });
  u.start(); socket.emit("open");
  clock = 45000;
  t.mock.timers.tick(30000);
  await new Promise<void>(r => setImmediate(() => setImmediate(r)));
  const row = rows.map(r => JSON.parse(r)).find(r => r.event === "upstream_watchdog");
  assert.equal(row.details.silentMs, 30000); // old field remains compatible
  assert.equal(row.details.thresholdMs, 30000);
  assert.equal(row.details.elapsedMs, 45000);
  assert.equal(row.details.overdueMs, 15000);
  assert.equal(row.details.receive.connectionMessages, 0);
  assert.equal(row.details.eventLoop.maxMs, 15000);
  assert.equal(socket.closeCalls, 1);
  assert(!rows.join("\n").includes("dummy-secret"));
  assert(!rows.join("\n").includes("wss://"));
  const stopped = u.stop(); socket.emit("close", { code: 1000 }); await stopped;
});

test("ダミー：受信処理の例外は診断追加で隠さず、所要時間を残す", async () => {
  let clock = 0;
  const socket = new DummySocket(), receiver = new Receiver(() => {});
  const u = new Upstream({ apiKey: "dummy-never-used", log: () => {},
    receiver: { metrics: receiver.metrics, receive: () => { clock += 12; throw Error("dummy failure"); } },
    monotonicNow: () => clock, createSocket: () => socket });
  u.start();
  try {
    assert.throws(() => socket.emit("message", { data: "dummy" }), /dummy failure/);
    assert.equal(u.receiveDiagnostics().lastReceiveMs, 12);
  } finally {
    const stopped = u.stop(); socket.emit("close", { code: 1000 }); await stopped;
  }
});

test("ダミー：診断取得失敗でもwatchdogのcloseを妨げない", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const socket = new DummySocket(), receiver = new Receiver(() => {});
  const events: { event: string; details: unknown }[] = [];
  const u = new Upstream({ apiKey: "dummy-never-used", receiver,
    log: (event, details) => events.push({ event, details }), createSocket: () => socket,
    eventLoopSnapshot: () => { throw Error("dummy diagnostic failure"); } });
  u.start(); t.mock.timers.tick(30000);
  await new Promise<void>(r => setImmediate(() => setImmediate(r)));
  assert.equal(socket.closeCalls, 1);
  assert.match(JSON.stringify(events), /snapshot_failed/);
  const stopped = u.stop(); socket.emit("close", { code: 1000 }); await stopped;
});

test("ダミー：watchdog後の2ターン内に届いた受信を先に処理し、誤切断しない", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const socket = new DummySocket(), receiver = new Receiver(() => {});
  const upstream = new Upstream({ apiKey: "dummy", receiver, log: () => {}, createSocket: () => socket });
  upstream.start(); socket.emit("open", {});
  t.mock.timers.tick(30000);
  setImmediate(() => socket.emit("message", { data: '{"type":"ping"}' }));
  await new Promise<void>(r => setImmediate(() => setImmediate(r)));
  assert.equal(socket.closeCalls, 0);
  assert.equal(upstream.receiveDiagnostics().watchdogDecisions.receiveResumed, 1);
  assert.equal(upstream.receiveDiagnostics().pong.samples, 1);
  const stopped = upstream.stop(); socket.emit("close", { code: 1000 }); await stopped;
});

test("ダミー：直近30秒の1秒以上の停止は30秒猶予し、停止なしの真の無受信は切断", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const socket = new DummySocket(), receiver = new Receiver(() => {});
  let pause: number | null = 1000;
  const upstream = new Upstream({ apiKey: "dummy", receiver, log: () => {},
    createSocket: () => socket, loopPauseMs: () => pause });
  upstream.start(); socket.emit("open", {});
  t.mock.timers.tick(30000);
  await new Promise<void>(r => setImmediate(() => setImmediate(r)));
  assert.equal(socket.closeCalls, 0);
  assert.equal(upstream.receiveDiagnostics().watchdogDecisions.localPause, 1);
  pause = null; t.mock.timers.tick(30000);
  await new Promise<void>(r => setImmediate(() => setImmediate(r)));
  assert.equal(socket.closeCalls, 1);
  assert.equal(upstream.receiveDiagnostics().watchdogDecisions.disconnected, 1);
  const stopped = upstream.stop(); socket.emit("close", { code: 1000 }); await stopped;
});

test("隔離HTTP：statusに診断を追加し、既存WS statusの上流形式は維持", async () => {
  const receiver = new Receiver(() => {});
  const u = new Upstream({ apiKey: "dummy-never-used", receiver, log: () => {},
    createSocket: () => { throw Error("must not connect"); } });
  const loop = new EventLoopMonitor();
  const app = createStatusApp(u, receiver, "dummy-never-used", undefined, undefined,
    () => ({ eventLoop: loop.snapshot() }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    for (const route of ["/status", "/api/status"]) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 200);
      const data = await response.json() as Record<string, any>;
      assert.equal(data.upstreamDiagnostics.totalMessages, 0);
      assert.equal(data.upstreamDiagnostics.connectionLastReceivedUs, null);
      assert.equal(data.memory.eventLoop.maxMs, null);
      assert(!JSON.stringify(data).includes("dummy-never-used"));
    }
    const wsStatus = statusSnapshot(u, receiver, "dummy-never-used") as Record<string, unknown>;
    assert(!("upstreamDiagnostics" in wsStatus));
    assert.deepEqual(wsStatus.upstream, u.status);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await u.stop();
    loop.stop();
  }
});

test("イベントループ診断：未観測はnull、実停止を検出し、読取で窓を消費しない", async () => {
  const monitor = new EventLoopMonitor();
  assert.equal(monitor.snapshot().samples, 0);
  assert.equal(monitor.snapshot().maxMs, null);
  monitor.start(); monitor.start();
  try {
    await new Promise(r => setTimeout(r, 40));
    const until = performance.now() + 80;
    while (performance.now() < until) { /* isolated synthetic event-loop stall */ }
    await new Promise(r => setTimeout(r, 40));
    const a = monitor.snapshot(), b = monitor.snapshot();
    assert(a.samples > 0);
    assert(a.maxMs! >= 50, JSON.stringify(a));
    assert.equal(a.samples, b.samples);
    assert.equal(a.maxMs, b.maxMs);
    monitor.reset();
    assert.equal(monitor.snapshot().samples, 0);
    assert.equal(monitor.snapshot().maxMs, null);
  } finally { monitor.stop(); monitor.stop(); }
  assert.equal(monitor.snapshot().enabled, false);
});
