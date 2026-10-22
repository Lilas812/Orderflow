import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { FakeClock } from "./transport";
import { GateBWireSocket, runGateBSession } from "./gateBSession";
import { GATE_B_REVIEW, LIMITS, type GateBReview } from "./gateBConfig";
import { WS_OPTIONS } from "./wsClient";

vi.mock("@workspace/tickstream-storage", () => { throw Error("STORAGE_IMPORT_FORBIDDEN"); });
vi.mock("@workspace/storage", () => { throw Error("STORAGE_IMPORT_FORBIDDEN"); });
vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(),
  writeFileSync: vi.fn(() => { throw Error("DISK_WRITE_FORBIDDEN"); }),
  appendFileSync: vi.fn(() => { throw Error("DISK_WRITE_FORBIDDEN"); }),
  createWriteStream: vi.fn(() => { throw Error("DISK_WRITE_FORBIDDEN"); }),
}));
vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  writeFile: vi.fn(() => { throw Error("DISK_WRITE_FORBIDDEN"); }),
  appendFile: vi.fn(() => { throw Error("DISK_WRITE_FORBIDDEN"); }),
  open: vi.fn(() => { throw Error("DISK_WRITE_FORBIDDEN"); }),
}));
const cleanups: (() => Promise<void>)[] = [];
const tcp = (socket: WebSocket) => (socket as unknown as { _socket?: { pause(): void; resume(): void } })._socket;
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function local(onClient: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw Error("LOCAL_ADDRESS");
  server.on("connection", socket => { socket.on("error", () => {}); onClient(socket); });
  cleanups.push(async () => {
    server.clients.forEach(socket => { tcp(socket)?.resume(); socket.terminate(); });
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `ws://127.0.0.1:${address.port}/`;
}
const tick = () => ({ type: "tick", symbol: "NQ", ts: Math.floor(Date.now() / 1000),
  price: 20000.25, size: 12, side: "buy", exch: "CME" });
describe("finite native Gate B loopback; no real market data", () => {
  it("checks native TLS/payload/fragment/buffering/autoPong options", () => {
    expect(WS_OPTIONS).toMatchObject({ rejectUnauthorized: true, followRedirects: false, autoPong: true,
      maxPayload: LIMITS.messageBytes, maxFragments: 1024, maxBufferedChunks: 1024, perMessageDeflate: false });
  });
  it("processes fragmented identical ticks, one JSON pong and one native pong; never persists", async () => {
    let jsonPong = 0, protocolPong = 0, subscription: unknown;
    const endpoint = await local(socket => {
      let sent = false;
      socket.on("pong", () => { protocolPong++; });
      socket.on("message", raw => {
        const m = JSON.parse(raw.toString());
        if (m.op === "pong") { jsonPong++; return; }
        subscription = m;
        if (sent) return; sent = true;
        socket.send('{"type":"welcome","plan":"CONTROL_SENTINEL"}'); socket.send('{"type":"ping"}');
        socket.ping("ARTIFICIAL_HEARTBEAT");
        const text = JSON.stringify(tick()); socket.send(text.slice(0, 10), { fin: false }); socket.send(text.slice(10), { fin: true });
        const timer = setInterval(() => {
          if (jsonPong === 1 && protocolPong === 1) { clearInterval(timer); socket.send(text); }
        }, 1);
        socket.once("close", () => clearInterval(timer));
      });
    });
    const r = await runGateBSession({ kind: "LOOPBACK_TEST", endpoint }, { finishAfter: 2 });
    expect(subscription).toEqual({ op: "subscribe", channel: "ticks", symbols: ["NQ"] });
    expect(r).toMatchObject({ execution: "LOOPBACK_TEST", phase: "STOPPED", stopReason: "COMPLETED",
      counters: { validTicks: 2, parserAccepted: 2, parserRejected: 0, equalProviderTimes: 1 },
      subscription: "DATA_OBSERVED_NO_ACK", persistence: "DISABLED", accountingMatches: true });
    expect(jsonPong).toBe(1); expect(protocolPong).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/20000|CONTROL_SENTINEL|ARTIFICIAL_HEARTBEAT|buy/);
    const fs = await import("node:fs"), promises = await import("node:fs/promises");
    for (const fn of [fs.writeFileSync, fs.appendFileSync, fs.createWriteStream, promises.writeFile, promises.appendFile, promises.open]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
  it.each([
    [{ type: "error", error: { code: "invalid_key", detail: "SECRET_SENTINEL" } }, "AUTH_REJECTED"],
    [{ type: "error", error: { code: "plan_required" } }, "ENTITLEMENT_REJECTED"],
    [{ type: "error", error: { code: "subscription_refused" } }, "SUBSCRIPTION_REJECTED"],
    [{ ...tick(), unrecognized: "SECRET_SENTINEL" }, "PARSER_REJECTED"],
    [{ ...tick(), ts: Date.now() * 1000 }, "TIMESTAMP_CONTEXT_MISMATCH"],
  ])("stops even when the peer keeps the socket open", async (wire, reason) => {
    const endpoint = await local(socket => socket.once("message", () => socket.send(JSON.stringify(wire))));
    const r = await runGateBSession({ kind: "LOOPBACK_TEST", endpoint });
    expect(r.phase).toBe("FAILED"); expect(r.stopReason).toBe(reason);
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });
  it.each([401, 403, 302])("handles HTTP %s without redirects, raw URLs or response bodies", async status => {
    const server = createServer();
    server.on("upgrade", (_req, socket) => socket.end(`HTTP/1.1 ${status} Rejected\r\nLocation: https://SECRET_SENTINEL.invalid/\r\nContent-Length: 0\r\n\r\n`));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); if (!address || typeof address === "string") throw Error();
    const r = await runGateBSession({ kind: "LOOPBACK_TEST", endpoint: `ws://127.0.0.1:${address.port}/` });
    expect(r.stopReason).toBe(status === 401 ? "AUTH_REJECTED" : status === 403 ? "ENTITLEMENT_REJECTED" : "SOCKET_ERROR");
    expect(r.counters!.connectionAttempts).toBe(1); expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });
  it.each(["binary", "invalidUtf8", "oversized"] as const)("rejects native %s framing", async kind => {
    const endpoint = await local(socket => socket.once("message", () => {
      if (kind === "binary") socket.send(Buffer.from("ARTIFICIAL"), { binary: true });
      if (kind === "invalidUtf8") socket.send(Buffer.from([0xff]), { binary: false });
      if (kind === "oversized") socket.send("x".repeat(LIMITS.messageBytes + 1));
    }));
    const r = await runGateBSession({ kind: "LOOPBACK_TEST", endpoint });
    expect(r).toMatchObject({ stopReason: "PROTOCOL_FAILURE", phase: "FAILED" });
  });
  it("terminates an unresponsive close peer after the cleanup budget and reports failure", async () => {
    const endpoint = await local(socket => socket.once("message", () => {
      socket.send(JSON.stringify(tick())); tcp(socket)?.pause();
    }));
    const r = await runGateBSession({ kind: "LOOPBACK_TEST", endpoint }, { finishAfter: 1 });
    expect(r).toMatchObject({ phase: "FAILED", stopReason: "FORCED_TERMINATION", counters: { validTicks: 1 } });
  });
  it("never dials an unauthorized production target", () => {
    const dial = vi.fn();
    expect(() => new GateBWireSocket({ kind: "PRODUCTION", review: GATE_B_REVIEW, explicitExecution: true, secret: "ARTIFICIAL" },
      new FakeClock(), () => ({ count: 0, bytes: 0 }), dial)).toThrow("GATE_B_NOT_AUTHORIZED");
    expect(dial).not.toHaveBeenCalled();
  });
  it("encodes artificial keys only inside a mocked constructor and never emits its exception", async () => {
    const review: GateBReview = { endpoint: "wss://stream.tick-stream.xyz/v1/stream", authority: "PROVIDER_REPLY",
      evidenceReference: "SYNTHETIC_TEST_ONLY", replitRamReceivePermissionConfirmed: true };
    const events: unknown[] = [], secret = "SENTINEL ?&#/unicodeあ", dial = vi.fn((url: string) => {
      const parsed = new URL(url); expect(parsed.searchParams.get("key")).toBe(secret);
      expect(parsed.searchParams.has("symbols")).toBe(false);
      expect(parsed.pathname).toBe("/v1/stream");
      throw Error(`KEY_URL_STACK_SENTINEL ${url}`);
    });
    const socket = new GateBWireSocket({ kind: "PRODUCTION", review, explicitExecution: true, secret },
      new FakeClock(), () => ({ count: 0, bytes: 0 }), dial);
    socket.listen(event => events.push(event)); socket.connect(); await socket.closed;
    expect(events).toEqual([{ type: "error" }]); expect(dial).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });
  it.each(["wss://external.invalid/", "ws://external.invalid/", "ws://127.0.0.1:1234/?key=ARTIFICIAL"])(
    "rejects unsafe artificial target before socket construction", endpoint => {
      const dial = vi.fn();
      expect(() => new GateBWireSocket({ kind: "LOOPBACK_TEST", endpoint }, new FakeClock(), () => ({ count: 0, bytes: 0 }), dial)).toThrow();
      expect(dial).not.toHaveBeenCalled();
    },
  );
});
