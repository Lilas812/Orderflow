import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INSTRUMENTS, instrumentPrice, validContract } from "../../lib/market/instruments.ts";
import { normalizePrice } from "../src/ingest/normalize.ts";
import { Receiver } from "../src/ingest/receiver.ts";
import { MarketReceiver } from "../src/ingest/markets.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import { historyTrades } from "../src/history/decode.ts";
import { historyGate } from "../src/history/gate.ts";
import { HistoryClient } from "../src/history/client.ts";
import { LocalStore } from "../src/store/local.ts";
import { LongRest } from "../src/long-vp/rest.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { dayBounds, serializeDay } from "../src/long-vp/day.ts";
import { validateDay } from "../src/long-vp/objects.ts";
import type { Trade } from "../src/types.ts";
import { createServer } from "node:http";
import WebSocket from "ws";
import { Hub, attachHub } from "../src/hub/hub.ts";
import { AppLongVp } from "../src/long-vp/app-service.ts";
import { LongObjects } from "../src/long-vp/objects.ts";
import type { Objects } from "../src/store/objects.ts";

test("GC uses tenth-dollar ticks, every decimal price in the tested price interval, and all delivery months", () => {
  assert.equal(INSTRUMENTS.GC.tickSize, .1);
  assert.equal(INSTRUMENTS.NQ.tickSize, .25);
  for (let tick = 10000; tick < 70000; tick++) assert.equal(normalizePrice(tick / 10, "GC"), tick);
  assert.equal(normalizePrice(4028.35, "GC"), null);
  assert.equal(normalizePrice(20000.1), null);
  assert.equal(instrumentPrice(40283, "GC"), "4028.3");
  assert.equal(instrumentPrice(80001, "NQ"), "20000.25");
  assert.equal(validContract("GCJ7", "GC"), true);
  assert.equal(validContract("NQJ7", "NQ"), false);
});

test("one demultiplexer separates mixed book/tick inputs and per-instrument rollback", () => {
  const nqTrades: Trade[] = [], gcTrades: Trade[] = [], nqBooks: unknown[] = [], gcBooks: unknown[] = [];
  const nq = new Receiver(() => {}, { trade: t => nqTrades.push(t), book: b => nqBooks.push(b) });
  const gc = new Receiver(() => {}, { trade: t => gcTrades.push(t), book: b => gcBooks.push(b) }, "GC");
  const input = new MarketReceiver(nq, gc);
  gc.currentContract = "GCZ6";
  const send = (message: unknown) => input.receive(JSON.stringify(message), 1800000000000000, () => {});
  send({ type: "book", symbol: "NQ", ts: 1800000002, bids: [[20000, 2]], asks: [[20000.25, 3]] });
  send({ type: "book", symbol: "GC", ts: 1800000001, bids: [[4028.3, 4]], asks: [[4028.4, 5]] });
  send({ type: "tick", symbol: "GC", ts: 1800000001, price: 4028.3, size: 6, side: "buy" });
  send({ type: "tick", symbol: "NQ", ts: 1800000002, price: 20000.25, size: 7, side: "sell" });
  send({ type: "tick", symbol: "MGC", ts: 1800000003, price: 4028.3, size: 90, side: "buy" });
  assert.equal(nqBooks.length, 1); assert.equal(gcBooks.length, 1);
  assert.equal(nqTrades.length, 1); assert.equal(gcTrades.length, 1);
  assert.equal(nqTrades[0].price, 80001); assert.equal(gcTrades[0].price, 40283);
  assert.equal(gcTrades[0].contract, "GCZ6"); assert.equal("contract" in nqTrades[0], false);
});

test("GC history keeps only record-explicit identities; unknown identity is not replaced by current metadata", () => {
  const rows = [undefined, "GCJ6", "NQZ6"].map((contract, i) => ({
    ts: 1800000000000000 + i, price: 4028.3, size: 1, side: "buy", ...(contract ? { contract } : {}),
  }));
  const result = historyTrades(rows, 1800000000, 1800000001, new Metrics(() => {}), () => 1, "GC");
  assert.deepEqual(result.map(t => t.contract), [undefined, "GCJ6", undefined]);
});

test("GC null contractSince does not become an observed-time activation boundary", async () => {
  const request = async () => new Response(JSON.stringify({ futures: [{ symbol: "GC", contract: "GCZ6", contractSince: null }] }));
  const metadata = new LongRest("not-a-real-key", request as typeof fetch, undefined, "GC");
  assert.deepEqual(await metadata.roll(new AbortController().signal), { contract: "UNKNOWN", sinceUs: 0 });
  assert.equal(metadata.currentContract, "GCZ6");
});

test("history requests use the selected root and share a body-aware FIFO", async () => {
  const urls: string[] = [];
  const request: typeof fetch = async input => {
    urls.push(String(input));
    return new Response(JSON.stringify({ ticks: [], truncated: false }));
  };
  const gate = historyGate(request);
  const first = await gate("https://example.invalid/first");
  let secondStarted = false;
  const second = gate("https://example.invalid/second").then(r => { secondStarted = true; return r; });
  await new Promise(r => setImmediate(r));
  assert.equal(secondStarted, false);
  await first.json(); await (await second).json();
  const client = new HistoryClient("not-a-real-key", () => {}, gate, undefined, "GC");
  await client.get("tick", 1800000000, 1800000001, new AbortController().signal);
  assert.equal(new URL(urls.at(-1)!).searchParams.get("symbol"), "GC");
});

test("NQ old JSONL/path stays unchanged and GC raw identities/coverage use a separate root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-store-"));
  const hour = 1800000000, now = () => hour * 1000;
  const nq = new LocalStore(root, now);
  const gc = new LocalStore(path.join(root, "instruments/GC"), now, undefined, "GC");
  try {
    await nq.initialize(); await gc.initialize();
    const old: Trade = { tsUs: hour * 1e6, recvUs: hour * 1e6, seq: 1, price: 80000, size: 2, side: "buy" };
    const gold: Trade = { ...old, price: 40283, contract: "GCZ6" };
    await nq.addTrades([old]); await gc.addTrades([gold]);
    await nq.flush(); await gc.flush();
    assert.deepEqual(await nq.readTrades(hour, hour + 1), [old]);
    assert.deepEqual(await gc.readTrades(hour, hour + 1), [gold]);
    assert.ok((await fs.readdir(path.join(root, "trades"))).includes("NQ"));
    assert.ok((await fs.readdir(path.join(root, "instruments/GC/trades"))).includes("GC"));
    assert.notDeepEqual(await nq.readTrades(hour, hour + 1), await gc.readTrades(hour, hour + 1));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("unknown contract is stored separately from missing intervals and explicit GC record identities survive serialization", () => {
  const date = "2026-10-29", { startUs } = dayBounds(date);
  const aggregate = new LongAggregate();
  aggregate.add({ tsUs: startUs + 10e6, price: 40283, size: 3, side: "buy" }, "UNKNOWN");
  aggregate.add({ tsUs: startUs + 20e6, price: 40284, size: 5, side: "sell" }, "GCZ6");
  const day = serializeDay(date, aggregate, [{ contract: "UNKNOWN", sinceUs: 0 }], [], startUs + 30e6, false, true);
  assert.deepEqual(day.gaps, []); assert.equal(day.complete, true);
  assert.deepEqual(day.contracts.map(c => c.contract), ["UNKNOWN", "GCZ6"]);
  assert.equal(day.vp30m.length, 2);
  assert.equal(validateDay(day, "GC"), day);
  assert.throws(() => validateDay(day, "NQ"));
});

test("real loopback WS routing keeps legacy NQ and explicit GC separate and closes all test connections", async () => {
  const source = { savedRange: () => null, read: async () => ({ columns: [], trades: [] }), status: () => ({}) };
  const nq = new Hub(source, () => {}), gc = new Hub(source, () => {}, undefined, "GC");
  const server = createServer(), sockets: WebSocket[] = [];
  const wss = attachHub(server, new Map([["NQ", nq], ["GC", gc]]));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    for (const symbol of ["NQ", "GC"] as const) {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws${symbol === "GC" ? "?symbol=GC" : ""}`);
      sockets.push(ws);
      const hello = await new Promise<{ symbol: string; tickSize: number }>((resolve, reject) => {
        ws.on("error", reject);
        ws.on("message", (bytes, binary) => {
          if (!binary) { const m = JSON.parse(bytes.toString()); if (m.type === "hello") resolve(m); }
        });
      });
      assert.equal(hello.symbol, symbol); assert.equal(hello.tickSize, INSTRUMENTS[symbol].tickSize);
    }
    assert.equal(nq.snapshot().connected, 1); assert.equal(gc.snapshot().connected, 1);
  } finally {
    await Promise.all(sockets.map(ws => ws.readyState === WebSocket.CLOSED ? Promise.resolve()
      : new Promise<void>(resolve => { ws.once("close", () => resolve()); ws.close(); })));
    nq.stop(); gc.stop(); wss.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(nq.snapshot().connected, 0); assert.equal(gc.snapshot().connected, 0);
  }
});

test("GC bootstrap covers at most seven calendar days, preserves a partial first day, and continues with unknown contracts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-bootstrap-"));
  const nowUs = Date.parse("2026-10-29T19:00:00Z") * 1000, objects = new Map<string, Buffer>();
  const storage: Objects = {
    exists: async name => objects.has(name),
    list: async prefix => [...objects.keys()].filter(k => k.startsWith(prefix)),
    upload: async (name, file) => { objects.set(name, await fs.readFile(file)); },
    download: async (name, file) => { await fs.writeFile(file, objects.get(name)!); },
  };
  const repo = new LongObjects(storage, "dev/", path.join(root, "objects"), "GC");
  const store = new LocalStore(path.join(root, "raw"), () => nowUs / 1000, undefined, "GC");
  const windows: number[] = [];
  let seq = 0;
  const service = new AppLongVp({
    repository: repo, store, metadata: { roll: async () => ({ contract: "UNKNOWN", sinceUs: 0 }) },
    metrics: new Metrics(() => {}), nextSeq: () => ++seq, now: () => nowUs, log: () => {},
    history: { symbol: "GC", get: async (_kind, start) => {
      windows.push(start);
      return { rows: [{ ts: (start + 1) * 1e6, price: 4028.3, size: 2, side: "buy" }], truncated: false };
    } },
    schedule: { now: () => nowUs / 1000, wait: async () => {} },
  });
  try {
    await store.initialize(); await service.run();
    assert.ok(windows.length > 0);
    assert.ok(Math.min(...windows) >= nowUs / 1e6 - 7 * 86400);
    const first = await repo.day([...repo.records.keys()].sort()[0]);
    assert.equal(first.complete, false); assert.ok(first.gaps[0][1] > first.startSec);
    assert.deepEqual(first.contracts.map(c => c.contract), ["UNKNOWN"]);
    assert.ok(first.vp30m.length > 0);
    const today = service.today()!;
    assert.ok(today); assert.equal(today.contracts[0].contract, "UNKNOWN");
    assert.ok([...objects.keys()].every(k => k.startsWith("dev/longvp/GC/")));
  } finally { await service.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
