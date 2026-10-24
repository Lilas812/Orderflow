import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { runReadOnlyFeedSession } from "./readOnlyFeedSession";

const options = { budget: { maxFrames: 10, maxBytes: 1024 * 1024 }, maxDurationMs: 1000, finishAfter: 2 };
const tick = { type: "tick", symbol: "NQ", ts: 1767225600, price: 20000.25, size: 3, side: "unknown", exch: "CME" };
const book = { type: "book", symbol: "NQ", ts: 1767225600, imbalance: 0, bids: [[20000, 40]], asks: [[20000.25, 60]] };

async function artificial(run: (server: WebSocketServer, endpoint: string) => Promise<void>) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("ARTIFICIAL_LISTENER_MISSING");
  try { await run(server, `ws://127.0.0.1:${address.port}`); }
  finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("Node feed connection contract — artificial loopback only", () => {
  it("blocks LIVE before socket creation, with no credential parameter or query construction", async () => {
    const dial = vi.fn(() => { throw Error("MUST_NOT_DIAL"); });
    const result = await runReadOnlyFeedSession({ kind: "LIVE", evidence: {
      account: "CONFIRMED", realtimeL2Plan: "CONFIRMED", privateApplicationUse: "CONFIRMED", secretPresent: true,
    } }, options, dial);
    expect(result).toMatchObject({ status: "BLOCKED", reason: "QUERY_AUTH_FORBIDDEN_BY_TASK31", attempts: 0 });
    expect(dial).not.toHaveBeenCalled();
  });
  it("uses real loopback socket attempts, two subscriptions, strict observation and graceful unsubscribe/close", async () => {
    await artificial(async (server, endpoint) => {
      let attempts = 0; const frames: unknown[] = [], reads: unknown[] = [];
      server.on("connection", client => {
        attempts++;
        client.on("message", data => {
          const m = JSON.parse(data.toString()); frames.push(m);
          if (m.op === "subscribe" && m.channel === "book") {
            client.send(JSON.stringify(tick)); client.send(JSON.stringify(book));
          }
        });
      });
      const result = await runReadOnlyFeedSession({ kind: "LOOPBACK_TEST", endpoint },
        { ...options, onObservation: s => reads.push(s) });
      await new Promise(resolve => setImmediate(resolve));
      expect(result).toMatchObject({ status: "FINISHED", attempts: 1, reconnects: 0, accepted: 2,
        rejected: 0, subscriptionFrames: 2, unsubscribeFrames: 2, forcedSocketCleanup: false, closed: true });
      expect(attempts).toBe(1); expect(reads).toHaveLength(2);
      expect(frames).toEqual(["subscribe", "unsubscribe"].flatMap(op =>
        ["ticks", "book"].map(channel => ({ op, channel, symbols: ["NQ"] }))));
      expect(server.clients.size).toBe(0);
    });
  });
  it.each(["error", "warning", "feed", "book_delta"])("fails closed on %s without forwarding arbitrary payload", async type => {
    await artificial(async (server, endpoint) => {
      let attempts = 0;
      server.on("connection", c => { attempts++; c.send(JSON.stringify({ type, message: "ARTIFICIAL_PRIVATE_MARKER" })); });
      const result = await runReadOnlyFeedSession({ kind: "LOOPBACK_TEST", endpoint }, options);
      expect(result.status).toBe("FAILED"); expect(result.reconnects).toBe(0);
      expect(attempts).toBe(1); expect(JSON.stringify(result)).not.toContain("ARTIFICIAL_PRIVATE_MARKER");
    });
  });
  it("remote disconnect ends the session without scheduling a second connection", async () => {
    await artificial(async (server, endpoint) => {
      let attempts = 0, peerClosed = Promise.resolve();
      server.on("connection", c => {
        attempts++;
        peerClosed = new Promise<void>(resolve => c.once("close", () => resolve()));
        c.close();
      });
      const result = await runReadOnlyFeedSession({ kind: "LOOPBACK_TEST", endpoint }, options);
      await peerClosed;
      expect(result).toMatchObject({ status: "FAILED", reason: "REMOTE_DISCONNECT", reconnects: 0 });
      expect(attempts).toBe(1); expect(server.clients.size).toBe(0);
    });
  });
  it("finite idle deadline gracefully ends without reconnect", async () => {
    await artificial(async (_server, endpoint) => {
      const result = await runReadOnlyFeedSession({ kind: "LOOPBACK_TEST", endpoint },
        { ...options, maxDurationMs: 40 });
      expect(result).toMatchObject({ status: "FINISHED", reason: "FINITE_OBSERVATION_END",
        accepted: 0, forcedSocketCleanup: false, reconnects: 0 });
    });
  });
  it("heartbeat is answered without pretending a market event was accepted", async () => {
    await artificial(async (server, endpoint) => {
      server.on("connection", client => {
        client.send('{"type":"ping"}');
        client.on("message", data => {
          if (JSON.parse(data.toString()).op === "pong") {
            client.send(JSON.stringify(tick)); client.send(JSON.stringify(book));
          }
        });
      });
      const result = await runReadOnlyFeedSession({ kind: "LOOPBACK_TEST", endpoint }, options);
      expect(result).toMatchObject({ status: "FINISHED", accepted: 2 });
    });
  });
  it("rejects arbitrary external/query-bearing test endpoints before dial", async () => {
    const dial = vi.fn(() => { throw Error(); });
    for (const endpoint of ["wss://example.test", "ws://127.0.0.1:1234/?key=ARTIFICIAL"])
      await expect(runReadOnlyFeedSession({ kind: "LOOPBACK_TEST", endpoint }, options, dial)).rejects.toThrow("LOOPBACK");
    expect(dial).not.toHaveBeenCalled();
  });
  it("consumer failure closes the owned socket and does not become PASS", async () => {
    await artificial(async (server, endpoint) => {
      server.on("connection", c => c.send(JSON.stringify(tick)));
      const result = await runReadOnlyFeedSession({ kind: "LOOPBACK_TEST", endpoint }, {
        ...options, onObservation: () => { throw Error("ARTIFICIAL_PRIVATE_MARKER"); },
      });
      expect(result).toMatchObject({ status: "FAILED", reason: "OBSERVATION_CONSUMER_FAILED", closed: true });
      expect(JSON.stringify(result)).not.toContain("ARTIFICIAL_PRIVATE_MARKER");
    });
  });
});
