import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { authorizeLiveStorage } from "@workspace/tickstream-storage/live-authorization";
import { recoverLive } from "@workspace/tickstream-storage/live-recovery";
import { runGateB2Session, type B2ManagedSocket } from "./gateB2Session";
import { GATE_B_SELECTED_TRIAL } from "./gateBConfig";
import { FakeClock } from "./transport";
import type { BEvent } from "./gateBTransport";

const dirs: string[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "b2b-session-")); chmodSync(directory, 0o700); dirs.push(directory);
  const now = Date.now(), authorization = authorizeLiveStorage({ explicitMode: "GATE_B2B", dataPermission: true,
    replitStoragePermission: true, manualCleanupConfirmed: true, captureMode: "ARTIFICIAL_PROTOCOL_TEST",
    trialId: randomUUID(), directory, issuedAtMs: now, deleteByMs: now + 60000 });
  return { directory, authorization };
}
class Socket implements B2ManagedSocket {
  listener: (e: BEvent) => void = () => {};
  forcedCleanup = false;
  private resolve = () => {};
  closed = new Promise<void>(r => { this.resolve = r; });
  listen(cb: (e: BEvent) => void) { this.listener = cb; }
  connect() { this.listener({ type: "open" }); }
  subscribe() { this.listener({ type: "subscriptionSent" }); }
  jsonPong() {}
  close() { this.resolve(); }
  terminate() { this.resolve(); }
  tick(n = 1) {
    this.listener({ type: "text", bytes: Buffer.from(JSON.stringify({ type: "tick", symbol: "NQ", ts: 1700000000,
      price: 20000.25, size: n, side: "buy", exch: "CME" })) });
  }
}
const target = { kind: "LOOPBACK_TEST" as const, endpoint: "ws://127.0.0.1:1/" };
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
describe("B-2B finite artificial session/store integration", () => {
  it("persists identical economic trades as distinct receive identities and reopens independently", async () => {
    const h = setup(), clock = new FakeClock(), socket = new Socket(), active: string[] = [];
    const work = runGateB2Session(target, h.authorization, { clock, finishAfter: 2,
      artificial: { socketFactory: () => socket }, onActive: ns => active.push(ns) });
    socket.tick(); socket.tick(); clock.advance(0);
    const r = await work;
    expect(r.captureMode).toBe("ARTIFICIAL_PROTOCOL_TEST"); expect(r.phase).toBe("STOPPED");
    expect(r.storage).toMatchObject({ persisted: 2, offered: 2, pending: 0, unknown: 0, accountingMatches: true });
    const records: any[] = [], recovered = recoverLive(h.directory, record => records.push(record), h.authorization);
    expect(recovered.manifest.head).toBe(r.commit.head); expect(records.map(x => x.receiveOrdinal)).toEqual([1, 2]);
    expect(records.every(x => x.inputOrigin === "SYNTHETIC_TEST")).toBe(true); expect(active).toHaveLength(1);
  });
  it("does not save controls", async () => {
    const h = setup(), clock = new FakeClock(), socket = new Socket();
    const work = runGateB2Session(target, h.authorization, { clock, finishAfter: 1, artificial: { socketFactory: () => socket } });
    for (const value of [{ type: "ping" }])
      socket.listener({ type: "text", bytes: Buffer.from(JSON.stringify(value)) });
    socket.tick(); clock.advance(0);
    const r = await work;
    expect(r.storage.persisted).toBe(1); expect(r.transport.counters?.control).toBeGreaterThan(0);
    expect(r.transport.counters?.rejected).toBe(0);
  });
  it("keeps the existing fail-closed parser rejection and stores no rejected message", async () => {
    const h = setup(), clock = new FakeClock(), socket = new Socket();
    const work = runGateB2Session(target, h.authorization, { clock, finishAfter: 1, artificial: { socketFactory: () => socket } });
    socket.listener({ type: "text", bytes: Buffer.from(JSON.stringify({ type: "tick", symbol: "ES", ts: 1700000000,
      price: 20000, size: 1, side: "buy", exch: "CME" })) });
    socket.tick(); clock.advance(0);
    const r = await work;
    expect(r.phase).toBe("FAILED"); expect(r.reason).toBe("PARSER_REJECTED");
    expect(r.storage.persisted).toBe(0); expect(r.transport.counters?.rejected).toBe(1);
  });
  it("retains unacknowledged ownership on an unknown fsync/publish result; never retries", async () => {
    const h = setup(), clock = new FakeClock(), socket = new Socket(); let writes = 0;
    const work = runGateB2Session(target, h.authorization, { clock, finishAfter: 1, artificial: {
      socketFactory: () => socket, store: { fault: phase => {
        if (phase === "AFTER_LOG_FSYNC" && ++writes === 1) throw Error("ARTIFICIAL_DISK_ERROR");
      } },
    } });
    socket.tick(); clock.advance(0);
    const r = await work;
    expect(r.storage).toMatchObject({ persisted: 0, pending: 1, unknown: 1 });
    expect(r.phase).toBe("FAILED"); expect(r.reason).toBe("LIVE_STORE_UNKNOWN"); expect(writes).toBe(1);
    const recovery = recoverLive(h.directory, undefined, h.authorization);
    expect(recovery.status).toBe("UNPUBLISHED_TAIL"); expect(recovery.persistedCount).toBe(0);
    expect(recovery.verifiedCount).toBe(1);
  });
  it("stops at the storage queue cap without silent loss", async () => {
    const h = setup(), clock = new FakeClock(), socket = new Socket();
    const work = runGateB2Session(target, h.authorization, { clock, finishAfter: 3, artificial: {
      socketFactory: () => socket, queue: { manualDrain: true, maxCount: 1 } } });
    socket.tick(); socket.tick(); clock.advance(0);
    const r = await work;
    expect(r.reason).toBe("LIVE_QUEUE_COUNT_LIMIT");
    expect(r.storage).toMatchObject({ persisted: 0, pending: 1, refused: 1, offered: 2, accountingMatches: true });
  });
  it("prevents artificial capability/clock/factory injection into a production target", async () => {
    const h = setup();
    await expect(runGateB2Session({ kind: "PRODUCTION", review: GATE_B_SELECTED_TRIAL,
      explicitExecution: true, secret: "ARTIFICIAL_KEY_NEVER_DIALED" }, h.authorization,
    { artificial: { socketFactory: () => { throw Error("MUST_NOT_RUN"); } } })).rejects.toThrow("LIVE_AUTH_SCOPE");
  });
  it("runs real loopback WebSocket transport through the new V2 storage boundary", async () => {
    const h = setup(), server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw Error("TEST_LISTEN");
    let subscribed: unknown;
    server.on("connection", socket => socket.once("message", data => {
      subscribed = JSON.parse(data.toString());
      const tick = JSON.stringify({ type: "tick", symbol: "NQ", ts: Math.floor(Date.now() / 1000),
        price: 20000.25, size: 12, side: "buy", exch: "CME" });
      socket.send(tick); socket.send(tick);
    }));
    try {
      const r = await runGateB2Session({ kind: "LOOPBACK_TEST", endpoint: `ws://127.0.0.1:${address.port}/` },
        h.authorization, { finishAfter: 2 });
      expect(r.storage.persisted).toBe(2); expect(JSON.stringify(subscribed)).toContain("NQ");
      expect(recoverLive(h.directory, undefined, h.authorization).persistedCount).toBe(2);
    } finally { server.clients.forEach(s => s.terminate()); await new Promise<void>(r => server.close(() => r())); }
  });
});
