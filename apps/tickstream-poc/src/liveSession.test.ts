import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { recover } from "@workspace/tickstream-storage/recovery";
import { GateALoopbackSocket, runGateASession } from "./liveSession";
import { FakeClock } from "./transport";

const dirs: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "tickstream-session-")); chmodSync(dir, 0o700); dirs.push(dir); return dir;
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
async function server(onSocket: (s: WebSocket) => void) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  wss.on("connection", onSocket); await once(wss, "listening");
  const port = (wss.address() as { port: number }).port;
  return { endpoint: `ws://127.0.0.1:${port}/`, async close() {
    wss.clients.forEach(s => s.terminate()); await new Promise<void>(resolve => wss.close(() => resolve()));
  } };
}
describe("real local WebSocket integration, synthetic payloads only", () => {
  it.each(["ticks", "book"] as const)("persists fragmented %s, replies once to each heartbeat, verifies restart read", async channel => {
    const subscriptions: unknown[] = []; let jsonPong = 0, protocolPong = 0;
    const local = await server(socket => {
      socket.on("pong", data => { if (data.toString() === "PROBE") protocolPong++; });
      socket.on("message", raw => {
        const message = JSON.parse(raw.toString());
        if (message.op === "pong") { jsonPong++; return; }
        subscriptions.push(message);
        const ts = Math.floor(Date.now() / 1000);
        const wire = JSON.stringify(channel === "ticks" ?
          { type: "tick", symbol: "NQ", ts, price: 20000.25, size: 12, side: "buy", exch: "CME" } :
          { type: "book", symbol: "NQ", ts, bids: [[20000, 0]], asks: [[20000.25, 40]], imbalance: -.5 });
        socket.send('{"type":"welcome","plan":"LOCAL_SYNTHETIC"}');
        socket.send('{"type":"ping"}'); socket.ping("PROBE");
        socket.send(wire.slice(0, 10), { fin: false }); socket.send(wire.slice(10), { fin: true });
        // Send second observation only after both heartbeat replies were observed.
        const check = setInterval(() => {
          if (jsonPong === 1 && protocolPong === 1 && socket.readyState === WebSocket.OPEN) {
            clearInterval(check); socket.send(wire);
          }
        }, 1);
        socket.once("close", () => clearInterval(check));
      });
    });
    try {
      const dir = directory();
      const report = await runGateASession({ endpoint: local.endpoint, channel, directory: dir, finishAfter: 2 });
      expect(subscriptions).toEqual([{ op: "subscribe", channel, symbols: ["NQ"] }]);
      expect(report).toMatchObject({ state: "STOPPED", stopReason: "COMPLETED",
        counters: { parsed: 2, persisted: 2, control: 2, storageFailures: 0 }, accountingMatches: true });
      expect(report.subscriptionConfirmed).toBe("UNCONFIRMED");
      expect(jsonPong).toBe(1); expect(protocolPong).toBe(1);
      expect(recover(dir)).toMatchObject({ status: "VERIFIED", persistedCount: 2 });
      expect(report.memory.measurement).toBe("MEASURED");
      expect(JSON.stringify(report)).not.toMatch(/20000|RAW_SENTINEL|LOCAL_SYNTHETIC/);
      const records: unknown[] = []; recover(dir, record => records.push(record));
      expect(records).toHaveLength(2);
    } finally { await local.close(); }
  });
  it.each([401, 403, 302])("contains HTTP refusal/redirect %s without following or logging key URLs", async status => {
    let requests = 0;
    const http = createServer((_req, res) => {
      requests++; res.writeHead(status, { Location: "https://invalid.example/?key=SECRET_SENTINEL" });
      res.end("SECRET_SENTINEL");
    });
    http.listen(0, "127.0.0.1"); await once(http, "listening");
    try {
      const port = (http.address() as { port: number }).port;
      const report = await runGateASession({ endpoint: `ws://127.0.0.1:${port}/`, channel: "ticks",
        directory: directory(), finishAfter: 1 });
      expect(report.stopReason).toBe(status === 401 ? "AUTH_REJECTED" : status === 403 ? "ENTITLEMENT_REJECTED" : "SOCKET_ERROR");
      expect(requests).toBe(1); expect(report.counters.persisted).toBe(0);
      expect(JSON.stringify(report)).not.toMatch(/SENTINEL|Location|https:|stack/);
    } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
  });
  it.each([
    [{ type: "error", error: { code: "plan_required", message: "SECRET_SENTINEL" } }, "ENTITLEMENT_REJECTED"],
    [{ type: "error", error: { code: "unknown_symbol" } }, "SUBSCRIPTION_REJECTED"],
    [{ type: "error", error: { code: "too_many_connections" } }, "CONNECTION_LIMIT"],
  ] as const)("stops on refusal even while the socket stays open", async (message, reason) => {
    const local = await server(socket => socket.on("message", () => socket.send(JSON.stringify(message))));
    try {
      const report = await runGateASession({ endpoint: local.endpoint, channel: "ticks", directory: directory(), finishAfter: 1 });
      expect(report.stopReason).toBe(reason); expect(report.counters.control).toBe(1);
      expect(report.counters.persisted).toBe(0); expect(report.accountingMatches).toBe(true);
    } finally { await local.close(); }
  });
  it("does not report saved data after an injected fsync/publish failure", async () => {
    const local = await server(socket => socket.on("message", () => socket.send(JSON.stringify({
      type: "tick", symbol: "NQ", ts: Math.floor(Date.now() / 1000), price: 20000.25, size: 1, side: "sell", exch: "CME",
    }))));
    try {
      const dir = directory();
      const report = await runGateASession({ endpoint: local.endpoint, channel: "ticks", directory: dir, finishAfter: 1,
        storageOptions: { fault: phase => { if (phase === "AFTER_LOG_FSYNC") throw Error("RAW_SENTINEL"); } } });
      expect(report).toMatchObject({ stopReason: "STORAGE_FAILED", pendingStorage: 1,
        counters: { persisted: 0, persistenceFailed: 1 }, accountingMatches: true });
      expect(recover(dir)).toMatchObject({ status: "UNPUBLISHED_TAIL", persistedCount: 0, verifiedCount: 1 });
    } finally { await local.close(); }
  });
  it("forces cleanup after 2 seconds when a real peer never reads the closing handshake", async () => {
    const local = await server(socket => socket.on("message", () => {
      socket.send(JSON.stringify({ type: "tick", symbol: "NQ", ts: Math.floor(Date.now() / 1000),
        price: 20000.25, size: 1, side: "buy", exch: "CME" }));
      socket.pause();
    }));
    try {
      const started = performance.now();
      const report = await runGateASession({ endpoint: local.endpoint, channel: "ticks", directory: directory(), finishAfter: 1 });
      expect(report).toMatchObject({ state: "FAILED", stopReason: "FORCED_TERMINATION", counters: { persisted: 1 } });
      expect(performance.now() - started).toBeLessThan(4000);
    } finally { await local.close(); }
  });
  it.each(["binary", "oversized", "invalidUtf8"] as const)("rejects real wire protocol violation %s", async kind => {
    const local = await server(socket => socket.on("message", () => {
      if (kind === "binary") socket.send(Buffer.from("SECRET_SENTINEL"));
      else if (kind === "oversized") socket.send("x".repeat(1024 * 1024 + 1));
      else socket.send(Buffer.from([0xff]), { binary: false });
    }));
    try {
      const report = await runGateASession({ endpoint: local.endpoint, channel: "ticks", directory: directory(), finishAfter: 1 });
      expect(report.stopReason).toBe("PROTOCOL_FAILURE");
      expect(report.counters.persisted).toBe(0);
      expect(JSON.stringify(report)).not.toContain("SECRET_SENTINEL");
    } finally { await local.close(); }
  });
  it.each(["wss://stream.tick-stream.xyz/v1/stream", "ws://external.invalid:80/", "ws://127.0.0.1:1234/?key=SECRET_SENTINEL"])(
    "rejects external/credential-bearing endpoints before construction", endpoint => {
      expect(() => new GateALoopbackSocket(endpoint, "ticks", new FakeClock(), () => ({ count: 0, bytes: 0 })))
        .toThrow("LOOPBACK_ENDPOINT_REQUIRED");
    },
  );
  it("contains no environment/credential reader or CLI wiring", () => {
    const source = readFileSync(new URL("./liveSession.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\.env|TICKSTREAM_API_KEY|console\./);
    expect(readFileSync(new URL("./poc.ts", import.meta.url), "utf8")).not.toMatch(/liveSession|liveTransport/);
  });
});
