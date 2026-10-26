import assert from "node:assert/strict";
import test from "node:test";
import { ColumnCache } from "../src/data/cache.ts";
import { RealtimeClient, buildSocketUrl, type SocketEnvironment } from "../src/data/socket.ts";
import { makeFrame } from "./helpers.ts";

class FakeSocket {
  readyState = 0;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];

  send(value: string): void { this.sent.push(value); }
  open(): void { this.readyState = 1; this.onopen?.(new Event("open")); }
  message(data: string | ArrayBuffer | Uint8Array): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "fixture" } as CloseEvent);
  }
}

function fixtureEnvironment() {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  let now = 1_000;
  const env: SocketEnvironment = {
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    now: () => now,
  };
  return {
    env,
    sockets,
    timers,
    advanceTimer: () => {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0] ?? [];
      assert.ok(id);
      timers.delete(id);
      now += timer!.delay;
      timer!.callback();
      return timer!.delay;
    },
  };
}

const trade = {
  tsUs: 4_500_000_000,
  recvUs: 4_500_010_000,
  seq: 7,
  price: 40_001,
  size: 2,
  side: "buy",
};

test("receives initial kind 2/trades, holds kind 3, requests missing range serially", () => {
  const cache = new ColumnCache();
  const fixture = fixtureEnvironment();
  const errors: string[] = [];
  let client!: RealtimeClient;
  let latestBooks = 0;
  client = new RealtimeClient(cache, {
    onConnection: () => {},
    onHello: () => cache.setRetentionAnchor(1_000_000_000, 1_200_000_000, false, null),
    onStatus: () => {},
    onColumns: () => {},
    onLatestBook: () => { latestBooks += 1; },
    onTrades: () => {},
    onError: (error) => errors.push(error),
    onReplayEnded: () => {},
    onBytesPerMinute: () => {},
    onRangeRequest: () => {},
  }, { protocol: "ws:", host: "example.test", search: "" }, fixture.env);
  client.start();
  const socket = fixture.sockets[0]!;
  socket.open();
  socket.message(JSON.stringify({
    type: "hello",
    symbol: "NQ",
    tickSize: 0.25,
    columnSeconds: 1,
    serverTimeUs: 5_000_000_000,
    mode: "live",
    savedRange: { fromSec: 1, toSec: 5_000 },
  }));
  socket.message(makeFrame(2, 0, [{ tsSec: 4_500, source: 1, bids: [[40_000, 5]] }]));
  socket.message(JSON.stringify({ type: "trades", trades: [trade, { ...trade, seq: trade.seq + 1 }] }));
  socket.message(makeFrame(3, 0, [{ tsSec: 4_501, bids: [[40_000, 8]] }]));
  assert.equal(cache.size, 1);
  assert.equal(cache.trades.length, 2);
  assert.equal(latestBooks, 1);

  // Initial delivery remains pending through all six chunks, until rangeDone.
  for (let i = 0; i < 5; i++) socket.message(makeFrame(2, 0, []));
  for (let i = 0; i < 6; i++) socket.message(JSON.stringify({ type: "rangeTrades", reqId: 0, trades: [] }));
  socket.message(JSON.stringify({ type: "rangeDone", reqId: 0, fromSec: 3200, toSec: 5000, columns: 1, trades: 0, chunks: 6 }));
  assert.equal(client.initialLoading, false);
  assert.equal(client.traffic.initialComplete, true);
  assert.equal(client.bytesPerMinute, 0);
  client.requestVisible(1_000, 1_200);
  const request = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
  assert.deepEqual(request, { op: "range", reqId: 1, fromSec: 1_000, toSec: 1_200 });
  socket.message(makeFrame(2, 1, [{ tsSec: 1_100, source: 1, asks: [[40_001, 11]] }]));
  assert.equal(cache.size, 2);
  assert.equal(JSON.parse(socket.sent[0]!).reqId, 1);
  const rangeTrade = { ...trade, tsUs: 1_100_000_000, seq: trade.seq + 2 };
  socket.message(JSON.stringify({ type: "rangeTrades", reqId: 1, trades: [rangeTrade, rangeTrade] }));
  client.requestVisible(600, 700);
  assert.equal(socket.sent.length, 1, "the first pair does not finish a request");
  socket.message(JSON.stringify({ type: "rangeDone", reqId: 1, fromSec: 1000, toSec: 1200, columns: 1, trades: 2, chunks: 1 }));
  assert.equal(socket.sent.length, 2, "the next request starts only after rangeDone");
  assert.equal(cache.trades.length, 3); // The repeated transport ID within this valid range counts only once.
  assert.equal(errors.length, 0);
  client.stop();
});

test("reconnects with increasing delays and never overlaps active sockets", () => {
  const cache = new ColumnCache();
  const fixture = fixtureEnvironment();
  const client = new RealtimeClient(cache, {
    onConnection: () => {},
    onHello: () => {},
    onStatus: () => {},
    onColumns: () => {},
    onLatestBook: () => {},
    onTrades: () => {},
    onError: () => {},
    onReplayEnded: () => {},
    onBytesPerMinute: () => {},
    onRangeRequest: () => {},
  }, { protocol: "ws:", host: "example.test", search: "" }, fixture.env);
  client.start();
  assert.equal(fixture.sockets.length, 1);
  fixture.sockets[0]!.close();
  assert.equal(fixture.timers.size, 1);
  assert.equal(fixture.advanceTimer(), 1_000);
  assert.equal(fixture.sockets.length, 2);
  fixture.sockets[1]!.close();
  assert.equal(fixture.advanceTimer(), 2_000);
  assert.equal(fixture.sockets.length, 3);
  client.stop();
  assert.equal(fixture.timers.size, 0);
});

test("socket URL forwards only replay transport parameters", () => {
  assert.equal(buildSocketUrl({
    protocol: "https:",
    host: "heatmap.test",
    search: "?mode=replay&from=1793000000&speed=10&tz=ct&debug=1",
  }), "wss://heatmap.test/api/ws?mode=replay&from=1793000000&speed=10");
  assert.equal(buildSocketUrl({
    protocol: "http:",
    host: "heatmap.test",
    search: "?tz=ct&debug=1&from=1",
  }), "ws://heatmap.test/api/ws");
});

test("ダミー：複数chunkのrangeDoneを検査し、初回・範囲を定常受信量へ混ぜない", () => {
  const cache = new ColumnCache(), fixture = fixtureEnvironment(), errors: string[] = [];
  const client = new RealtimeClient(cache, {
    onConnection() {}, onHello() {}, onStatus() {}, onColumns() {}, onLatestBook() {},
    onTrades() {}, onError: e => errors.push(e), onReplayEnded() {}, onBytesPerMinute() {}, onRangeRequest() {},
  }, { protocol: "ws:", host: "example.test", search: "" }, fixture.env);
  client.start();
  const socket = fixture.sockets[0]!; socket.open();
  socket.message(JSON.stringify({ type: "hello", symbol: "NQ", tickSize: 0.25,
    columnSeconds: 1, serverTimeUs: 5000e6, mode: "live", savedRange: null }));
  client.requestVisible(2000, 2450);
  for (let i = 0; i < 6; i++) {
    socket.message(makeFrame(2, 0, []));
    socket.message(JSON.stringify({ type: "rangeTrades", reqId: 0, trades: [] }));
    assert.equal(socket.sent.length, 0);
    assert.equal(client.initialLoading, true);
  }
  socket.message(JSON.stringify({ type: "rangeDone", reqId: 0, fromSec: 3200, toSec: 5000,
    columns: 0, trades: 0, chunks: 6 }));
  assert.equal(socket.sent.length, 1);
  assert.equal(client.traffic.initialComplete, true);
  client.requestVisible(1000, 1100);
  for (const sec of [2100, 2400]) {
    socket.message(makeFrame(2, 1, [{ tsSec: sec, bids: [[40000, 5]] }]));
    socket.message(JSON.stringify({ type: "rangeTrades", reqId: 1, trades: [] }));
    assert.equal(socket.sent.length, 1);
  }
  const done = { type: "rangeDone", reqId: 1, fromSec: 2000, toSec: 2450, columns: 2, trades: 0, chunks: 2 };
  socket.message(JSON.stringify({ ...done, columns: 1 }));
  assert.deepEqual(errors, ["invalid_range_done"]);
  assert.equal(socket.sent.length, 1);
  socket.message(JSON.stringify(done));
  assert.equal(socket.sent.length, 2);
  assert.equal(client.bytesPerMinute, 0);
  assert.ok(client.traffic.initialBytes > 0 && client.traffic.rangeBytes > 0);
  assert.equal(client.columnDeliveries.find(c => c.timeUs === 2100e6)?.via, "range:1");
  socket.message(makeFrame(3, 0, [{ tsSec: 5000, bids: [[40000, 5]] }]));
  assert.ok(client.bytesPerMinute > 0);
  client.stop();
});

test("a replay-ended status is terminal and does not schedule a reconnect", () => {
  const cache = new ColumnCache();
  const fixture = fixtureEnvironment();
  let ended = 0;
  let finalState = "";
  const client = new RealtimeClient(cache, {
    onConnection: (state) => { finalState = state; },
    onHello: () => {},
    onStatus: () => {},
    onColumns: () => {},
    onLatestBook: () => {},
    onTrades: () => {},
    onError: () => {},
    onReplayEnded: () => { ended += 1; },
    onBytesPerMinute: () => {},
    onRangeRequest: () => {},
  }, { protocol: "ws:", host: "example.test", search: "?mode=replay&from=4000&speed=1" }, fixture.env);
  client.start();
  const socket = fixture.sockets[0]!;
  socket.open();
  socket.message(JSON.stringify({
    type: "hello",
    symbol: "NQ",
    tickSize: 0.25,
    columnSeconds: 1,
    serverTimeUs: 5_000_000_000,
    mode: "replay",
    savedRange: null,
  }));
  socket.message(JSON.stringify({ type: "status", status: {}, replay: { state: "ended", fromSec: 4_000, toSec: 5_000, speed: 1 } }));
  assert.equal(ended, 1);
  assert.equal(finalState, "replay-ended");
  assert.equal(fixture.timers.size, 0);
  socket.close();
  assert.equal(fixture.timers.size, 0);
  client.stop();
});

test("ダミー: reconnect hello discards previous-session coverage/data then rehydrates", () => {
  const cache = new ColumnCache();
  const fixture = fixtureEnvironment();
  const client = new RealtimeClient(cache, {
    onConnection: () => {}, onHello: () => {}, onStatus: () => {}, onColumns: () => {},
    onLatestBook: () => {}, onTrades: () => {}, onError: () => {}, onReplayEnded: () => {},
    onBytesPerMinute: () => {}, onRangeRequest: () => {},
  }, { protocol: "http:", host: "example.test", search: "" }, fixture.env);
  const hello = JSON.stringify({ type: "hello", symbol: "NQ", tickSize: .25, columnSeconds: 1,
    serverTimeUs: 5_000_000_000, mode: "live", savedRange: { fromSec: 1, toSec: 5_000 } });
  client.start();
  const first = fixture.sockets[0]!;
  first.open(); first.message(hello);
  first.message(makeFrame(2, 0, [{ tsSec: 4_500, bids: [[100, 2]] }]));
  first.message(JSON.stringify({ type: "rangeTrades", reqId: 0, trades: [trade] }));
  assert.equal(cache.size, 1);
  first.close(); fixture.advanceTimer();
  const next = fixture.sockets[1]!;
  next.open(); next.message(hello);
  assert.equal(cache.size, 0);
  assert.equal(cache.trades.length, 0);
  next.message(makeFrame(2, 0, [{ tsSec: 4_501, bids: [[100, 3]] }]));
  assert.equal(cache.columns[0]?.timeUs, 4_501_000_000);
  client.stop();
});
