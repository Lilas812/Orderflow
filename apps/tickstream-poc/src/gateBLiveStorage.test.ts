import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { LiveAppendStore } from "@workspace/tickstream-storage/live-append";
import { OFFLINE_LIVE_MODE } from "@workspace/tickstream-storage/live-record";
import { digest, LIVE_LOG } from "@workspace/tickstream-storage/live-manifest";
import { recoverLive } from "@workspace/tickstream-storage/live-recovery";
import { LiveStorageQueue, type LiveQueueOptions } from "@workspace/tickstream-storage/live-queue";
import { FakeClock, LIMITS } from "./transport";
import { GateBTicks, type BEvent, type BTicksSocket } from "./gateBTransport";
import { GateBWireSocket } from "./gateBSession";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const wire = { type: "tick", symbol: "NQ", ts: 1700000000, price: 20000.25, size: 12, side: "buy", exch: "CME" };
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
class Socket implements BTicksSocket {
  listener: (e: BEvent) => void = () => {};
  closes = 0;
  listen(cb: (e: BEvent) => void) { this.listener = cb; }
  emit(e: BEvent) { this.listener(e); }
  connect() {}
  subscribe() { this.emit({ type: "subscriptionSent" }); }
  jsonPong() {}
  close() { this.closes++; this.emit({ type: "close" }); }
  terminate() {}
}
function directory() {
  const d = mkdtempSync(join(tmpdir(), "tickstream-b2a-integrated-")); chmodSync(d, 0o700); dirs.push(d); return d;
}
function harness(input: { manualStorage?: boolean; queue?: LiveQueueOptions; fault?: (p: string) => void;
  quotaBytes?: number; finishAfter?: number } = {}) {
  const d = directory(), clock = new FakeClock(), socket = new Socket();
  const store = new LiveAppendStore(d, { testMode: OFFLINE_LIVE_MODE, fault: input.fault, quotaBytes: input.quotaBytes });
  const queue = new LiveStorageQueue(store, { manualDrain: input.manualStorage,
    schedule: callback => clock.schedule(0, callback), ...input.queue });
  const p = new GateBTicks(clock, () => socket, "LOOPBACK_TEST", { offlineStorage: queue, finishAfter: input.finishAfter });
  p.start(); socket.emit({ type: "open" });
  return { d, clock, socket, queue, p, send: (v: unknown = wire) => {
    socket.emit({ type: "text", bytes: encode(v) }); clock.advance(0);
  } };
}

describe("B-2A artificial Gate B -> bounded durable storage integration", () => {
  it("retains identical observations, all record hashes and canonical order on reopen", () => {
    const h = harness({ finishAfter: 3 }); h.send(); h.send(); h.send();
    const inputHash = digest(readFileSync(join(h.d, LIVE_LOG))), records: any[] = [];
    const recovered = recoverLive(h.d, r => records.push(r));
    expect(recovered).toMatchObject({ status: "VERIFIED", persistedCount: 3, tailBytes: 0 });
    expect(h.p.offlineReport().transport).toMatchObject({ phase: "STOPPED", stopReason: "COMPLETED",
      counters: { validTicks: 3, received: 3 }, accountingMatches: true });
    expect(h.queue.report()).toMatchObject({ persisted: 3, pending: 0, unpersisted: 0, accountingMatches: true });
    expect(records.map(r => r.receiveOrdinal)).toEqual([1, 2, 3]);
    expect(records.every(r => r.testMode === OFFLINE_LIVE_MODE && r.inputOrigin === "SYNTHETIC_TEST" &&
      r.tradeId === null && r.continuityStatus === "UNKNOWN")).toBe(true);
    expect(digest(readFileSync(join(h.d, LIVE_LOG)))).toBe(inputHash);
    expect(new Set(records.map(r => digest(JSON.stringify(r)))).size).toBe(3);
    expect(h.clock.scheduled).toBe(0);
  });
  it.each(["quota", "fsync", "manifest", "ENOSPC"])("stops receipt immediately on %s failure and leaves exact accounting", fault => {
    let armed = false;
    const h = harness({ quotaBytes: fault === "quota" ? 8192 : undefined,
      fault: phase => {
        const target = fault === "manifest" ? "BEFORE_MANIFEST_RENAME" :
          fault === "ENOSPC" ? "AFTER_PARTIAL_APPEND" : "BEFORE_LOG_FSYNC";
        if (armed && fault !== "quota" && phase === target) throw Object.assign(Error("KEY_URL_SENTINEL"), { code: "ENOSPC" });
      } });
    h.send(); armed = true;
    for (let n = 0; n < 10 && !h.p.terminal; n++) h.send();
    expect(h.p.offlineReport().transport).toMatchObject({ phase: "FAILED", stopReason: "CHILD_FAILURE" });
    expect(h.queue.report()).toMatchObject({ phase: "FAILED", pending: 1, accountingMatches: true });
    expect(h.queue.report().reason).toBe(fault === "quota" ? "LIVE_STORE_QUOTA" : "LIVE_STORE_UNKNOWN");
    const received = h.p.offlineReport().transport.counters!.received;
    h.send(); expect(h.p.offlineReport().transport.counters!.received).toBe(received);
    const recovered = recoverLive(h.d);
    expect(recovered.persistedCount).toBe(h.queue.report().persisted);
    expect(JSON.stringify({ transport: h.p.offlineReport(), storage: h.queue.report() })).not.toContain("SENTINEL");
    expect(h.socket.closes).toBe(1); expect(h.clock.scheduled).toBe(0);
  });
  it("stops on save queue overflow without discarding earlier pending records", () => {
    const h = harness({ manualStorage: true });
    for (let n = 0; n < 129; n++) h.send();
    expect(h.p.offlineReport().transport).toMatchObject({ phase: "FAILED", stopReason: "CHILD_FAILURE",
      counters: { validTicks: 129, received: 129 }, accountingMatches: true });
    expect(h.queue.report()).toMatchObject({ reason: "LIVE_QUEUE_COUNT_LIMIT", pending: 128,
      refused: 1, offered: 129, persisted: 0, accountingMatches: true });
    expect(recoverLive(h.d).persistedCount).toBe(0);
  });
  it("flushes accepted save queue entries at the original active time limit", () => {
    const h = harness({ manualStorage: true }); h.send(); h.clock.advance(20000);
    h.socket.emit({ type: "ping" }); h.clock.advance(20000); h.socket.emit({ type: "ping" }); h.clock.advance(20000);
    expect(h.p.offlineReport().transport).toMatchObject({ phase: "STOPPED", stopReason: "ACTIVE_TIME_LIMIT", activeBudgetElapsedMs: 60000 });
    expect(h.queue.report()).toMatchObject({ phase: "STOPPED", persisted: 1, pending: 0 });
  });
  it("keeps reconnect epoch evidence without fabricating sequence or continuity", () => {
    const h = harness(); h.send(); h.socket.emit({ type: "close" }); h.clock.advance(LIMITS.reconnectMs);
    h.socket.emit({ type: "open" }); h.send(); h.p.finish();
    const records: any[] = []; recoverLive(h.d, r => records.push(r));
    expect(records.map(r => [r.connectionEpoch, r.receiveOrdinal])).toEqual([[1, 1], [2, 2]]);
    expect(records.every(r => r.providerSequence === "UNAVAILABLE" && r.continuityStatus === "UNKNOWN")).toBe(true);
  });
  it.each(["parser", "timestamp", "book", "auth"])("does not save a %s-rejected observation", kind => {
    const h = harness();
    h.send(kind === "parser" ? { ...wire, raw: "KEY_SENTINEL" } : kind === "timestamp" ? { ...wire, ts: 1 } :
      kind === "book" ? { type: "book" } : { type: "error", error: { code: "invalid_key", detail: "KEY_SENTINEL" } });
    expect(h.p.offlineReport().transport.phase).toBe("FAILED");
    expect(h.queue.report().offered).toBe(0); expect(recoverLive(h.d).persistedCount).toBe(0);
    for (const name of readdirSync(h.d)) expect(readFileSync(join(h.d, name)).toString()).not.toContain("SENTINEL");
  });
  it("explicit forced stop retains queued ownership but never claims persistence", () => {
    const h = harness({ manualStorage: true }); h.send(); h.p.stop("FORCED_TERMINATION");
    expect(h.queue.report()).toMatchObject({ phase: "ABORTED", pending: 1, persisted: 0,
      unpersisted: 1, accountingMatches: true });
    expect(h.p.offlineReport().transport.stopReason).toBe("FORCED_TERMINATION");
  });
  it("runs the same pipeline against a real loopback-only ws server, without any secret", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw Error("LOOPBACK_ADDRESS");
    const d = directory(), store = new LiveAppendStore(d, { testMode: OFFLINE_LIVE_MODE }), queue = new LiveStorageQueue(store);
    const fake = new FakeClock();
    // Provider wall context is intentionally fixed to the artificial sample.
    const clock = { monoNs: () => process.hrtime.bigint(), utcMs: () => fake.utcMs(),
      schedule: (ms: number, callback: () => void) => { const id = setTimeout(callback, ms); return () => clearTimeout(id); } };
    let p: GateBTicks;
    const factory = () => new GateBWireSocket({ kind: "LOOPBACK_TEST", endpoint: `ws://127.0.0.1:${address.port}/` },
      clock, () => p.capacity);
    p = new GateBTicks(clock, factory, "LOOPBACK_TEST", { offlineStorage: queue, finishAfter: 2 });
    server.on("connection", ws => ws.once("message", bytes => {
      expect(JSON.parse(bytes.toString())).toEqual({ op: "subscribe", channel: "ticks", symbols: ["NQ"] });
      ws.send(JSON.stringify(wire)); ws.send(JSON.stringify(wire));
    }));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("OFFLINE_LOOPBACK_TIMEOUT")), 4000);
        p.onTerminal(() => { clearTimeout(timer); resolve(); }); p.start();
      });
      expect(p.offlineReport().transport).toMatchObject({ phase: "STOPPED", counters: { validTicks: 2 } });
      expect(queue.report()).toMatchObject({ phase: "STOPPED", persisted: 2, pending: 0 });
      expect(recoverLive(d).persistedCount).toBe(2);
    } finally {
      p.stop("FORCED_TERMINATION"); queue.abort();
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
