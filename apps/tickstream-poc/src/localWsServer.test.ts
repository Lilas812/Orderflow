import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type RequestListener } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Socket as TcpSocket } from "node:net";
import WebSocket from "ws";
import { parsePublicSample } from "@workspace/tickstream-adapter";
import { FakeClock, LIMITS, Transport } from "./transport";
import { syntheticTick } from "./session";
import { WsClient, SUBSCRIPTION, WS_OPTIONS, emptyWireCounters, type WireCounters } from "./wsClient";
import { localServer, localReport, localWsSession, readLocalReport } from "./localWsSession";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const turn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 1));
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("LOCAL_TEST_DEADLINE");
    await turn();
  }
}
async function harness(onSubscribe?: (socket: WebSocket) => void, options?: {
  onConnection?: (socket: WebSocket) => void;
  parser?: typeof parsePublicSample;
  capacity?: () => { count: number; bytes: number };
}) {
  const clock = new FakeClock(), wire = emptyWireCounters(), clients: WsClient[] = [];
  let subscriptions = 0;
  const server = await localServer(socket => {
    options?.onConnection?.(socket);
    socket.on("message", (data, binary) => {
      if (!binary && Buffer.isBuffer(data) && data.equals(Buffer.from(SUBSCRIPTION))) {
        subscriptions++; onSubscribe?.(socket);
      }
    });
  });
  let transport: Transport;
  transport = new Transport(clock, () => {
    const client = new WsClient(server.url, clock, options?.capacity ??
      (() => ({ count: transport.pendingCount, bytes: transport.pendingBytes })), wire);
    clients.push(client); return client;
  }, options?.parser);
  cleanups.push(async () => {
    transport.stop(); clients.forEach(client => client.terminate());
    await server.close();
    await Promise.all(clients.map(client => client.closed));
    expect(clock.scheduled).toBe(0);
    expect(server.server.clients.size).toBe(0);
  });
  const start = async (): Promise<void> => {
    transport.start(); await until(() => subscriptions > 0 || transport.terminal);
  };
  const drainUntil = async (condition: () => boolean): Promise<void> =>
    until(() => { clock.advance(0); return condition(); });
  return { ...server, clock, wire, clients, transport, start, drainUntil, subscriptions: () => subscriptions };
}
function changedTick(change: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(new TextDecoder().decode(syntheticTick())), ...change });
}
function accounting(transport: Transport): void {
  expect(transport.report().counters?.accountingMatches).toBe(true);
}

describe("real RFC 6455 loopback protocol and parser", () => {
  it("handshakes, sends the exact subscription once, and does not invent an ACK", async () => {
    const h = await harness(socket => { socket.send(syntheticTick(), { binary: false }); });
    await h.start(); h.clients[0].connect(); h.clients[0].subscribe(); h.transport.start();
    await h.drainUntil(() => h.transport.diagnostics.accepted === 1);
    expect(h.subscriptions()).toBe(1); expect(h.wire.opens).toBe(1); expect(h.wire.subscriptionSent).toBe(1);
    expect(h.transport.state).toBe("SUBSCRIBING");
    expect(h.transport.report().counters?.stateVisits.RUNNING).toBe(0);
    expect(h.transport.report().marketMissingEvents).toBe("NOT_MEASURABLE");
    accounting(h.transport);
  });
  it("separates JSON pong, protocol autoPong echo and protocol pong; no duplicate reply", async () => {
    let protocolPongs = 0, jsonPongs = 0;
    const h = await harness(socket => {
      socket.on("pong", data => { expect(data.equals(Buffer.from("ECHO_SENTINEL"))).toBe(true); protocolPongs++; });
      socket.on("message", data => { if (Buffer.isBuffer(data) && data.equals(Buffer.from('{"op":"pong"}'))) jsonPongs++; });
      socket.send('{"type":"ping"}'); socket.ping("ECHO_SENTINEL"); socket.pong("PONG_SENTINEL");
    });
    await h.start();
    await h.drainUntil(() => protocolPongs === 1 && jsonPongs === 1 && h.wire.protocolPong === 1);
    await turn(); await turn();
    expect(protocolPongs).toBe(1);
    expect(h.wire).toMatchObject({ protocolPing: 1, protocolPong: 1, jsonPongSent: 1, textMessages: 1 });
    expect(h.transport.report().counters).toMatchObject({
      receivedMessages: 1, accepted: 0, control: 1, heartbeatCount: 3,
    });
    h.clock.advance(29_999); expect(h.transport.state).toBe("SUBSCRIBING");
    h.clock.advance(1); expect(h.transport.state).toBe("RECONNECT_WAIT");
    accounting(h.transport);
  });
  it("fragments and reassembles a text message before delivering it exactly once", async () => {
    const parser = vi.fn(parsePublicSample), text = new TextDecoder().decode(syntheticTick());
    const h = await harness(socket => {
      socket.send(text.slice(0, 20), { fin: false, binary: false });
      socket.send(text.slice(20, 50), { fin: false, binary: false });
      socket.send(text.slice(50), { fin: true, binary: false });
    }, { parser });
    await h.start(); await h.drainUntil(() => h.transport.diagnostics.accepted === 1);
    expect(parser).toHaveBeenCalledTimes(1); expect(h.wire.textMessages).toBe(1);
    expect(parser.mock.calls[0][0]).toMatchObject({
      schemaProfile: "WS_TICK_LIVE_V1", provenance: { timestampUnit: "s", sampleOrigin: "SYNTHETIC_TEST" },
      instrument: { kind: "CORE_NQ", symbol: "NQ" },
    });
    accounting(h.transport);
  });
  it("never falsely deduplicates identical valid trade content", async () => {
    const h = await harness(socket => {
      socket.send(syntheticTick(), { binary: false }); socket.send(syntheticTick(), { binary: false });
    });
    await h.start(); await h.drainUntil(() => h.transport.diagnostics.accepted === 2);
    expect(h.transport.report().counters?.receivedMessages).toBe(2); accounting(h.transport);
  });
  it.each([
    ["malformed JSON", "{", "INVALID_JSON"],
    ["unknown field", changedTick({ unknown_SENTINEL: 1 }), "UNSUPPORTED_FIELD"],
    ["off-tick price", changedTick({ price: 20000.1 }), "OFF_TICK_GRID"],
    ["timestamp mismatch", changedTick({ ts: 1_700_000_000_000_000 }), "TIMESTAMP_CONTEXT_MISMATCH"],
  ])("rejects %s through the unchanged parser", async (_label, text, reason) => {
    const h = await harness(socket => socket.send(text));
    await h.start(); await h.drainUntil(() => h.transport.terminal);
    expect(h.transport.report().stopReason).toBe(reason);
    expect(h.transport.diagnostics.rejected).toBe(1); expect(h.wire.protocolFailures).toBe(0);
    expect(h.transport.report().counters?.reasonCounts[reason as "INVALID_JSON"]).toBe(1);
    expect(JSON.stringify(localReport(h.transport.report(), h.wire))).not.toMatch(/SENTINEL|20000\.1/);
    accounting(h.transport);
  });
  it.each([
    ["binary", "FRAGMENT_PROTOCOL"],
    ["utf8", "INVALID_UTF8"],
    ["oversized", "PAYLOAD_TOO_LARGE"],
    ["fragmentedOversized", "PAYLOAD_TOO_LARGE"],
    ["fragments", "FRAGMENT_LIMIT"],
  ] as const)("refuses native %s before parser admission", async (scenario, reason) => {
    const parser = vi.fn(parsePublicSample);
    const h = await harness(socket => {
      if (scenario === "binary") socket.send(syntheticTick(), { binary: true });
      if (scenario === "utf8") socket.send(Buffer.from([0xc3, 0x28]), { binary: false });
      if (scenario === "oversized") socket.send(Buffer.alloc(LIMITS.messageBytes + 1, 0x20), { binary: false });
      if (scenario === "fragmentedOversized") {
        socket.send(Buffer.alloc(LIMITS.messageBytes, 0x20), { binary: false, fin: false });
        socket.send("x", { binary: false, fin: true });
      }
      if (scenario === "fragments") {
        for (let i = 0; i <= LIMITS.fragments; i++) socket.send("", { binary: false, fin: false }, () => {});
      }
    }, { parser });
    await h.start(); await until(() => h.transport.terminal);
    expect(h.transport.report().stopReason).toBe(reason);
    expect(h.wire.protocolFailures).toBe(1); expect(h.transport.diagnostics.rejected).toBe(0);
    expect(parser).not.toHaveBeenCalled();
    expect(h.transport.report().counters?.reasonCounts[reason]).toBe(1); accounting(h.transport);
  });
  it("accepts a complete text payload at exactly 1 MiB", async () => {
    const text = new TextDecoder().decode(syntheticTick()).padEnd(LIMITS.messageBytes);
    const h = await harness(socket => socket.send(text));
    await h.start(); await h.drainUntil(() => h.transport.diagnostics.accepted === 1);
    expect(h.wire.protocolFailures).toBe(0); expect(h.transport.diagnostics.payloadBytes).toBe(LIMITS.messageBytes);
  });
});

describe("lifecycle, backpressure and bounded P2-B reuse", () => {
  it.each(["close", "terminate"] as const)("reconnects once after %s, at 46 seconds and never earlier", async method => {
    const peers: WebSocket[] = [];
    const h = await harness(undefined, { onConnection: socket => peers.push(socket) });
    await h.start(); peers[0][method]();
    await until(() => h.transport.state === "RECONNECT_WAIT");
    h.clock.advance(45_999); expect(h.clients).toHaveLength(1);
    h.clock.advance(1); await until(() => h.subscriptions() === 2);
    expect(h.clients).toHaveLength(2); expect(h.transport.diagnostics.reconnectAttempts).toBe(1);
    peers[1].terminate(); await until(() => h.transport.terminal);
    expect(h.transport.report().stopReason).toBe("RECONNECT_LIMIT");
    expect(h.clients).toHaveLength(2); accounting(h.transport);
  });
  it("handles real invalid-frame error/close races with a single terminal protocol failure", async () => {
    const h = await harness(socket => {
      socket.send(Buffer.from([0xff]), { binary: false });
      socket.close(1000, "CLOSE_REASON_SENTINEL");
    });
    await h.start(); await until(() => h.transport.terminal);
    await turn();
    expect(h.wire.protocolFailures).toBe(1);
    expect(h.transport.diagnostics.reconnectAttempts).toBe(0);
    accounting(h.transport);
  });
  it("heartbeats do not confirm subscription or market data health", async () => {
    const h = await harness(socket => socket.ping("PROBE"));
    await h.start(); await until(() => h.wire.protocolPing === 1);
    h.clock.advance(29_999); expect(h.transport.diagnostics.accepted).toBe(0);
    expect(h.transport.state).toBe("SUBSCRIBING");
    h.clock.advance(1); expect(h.transport.state).toBe("RECONNECT_WAIT");
    expect(h.transport.report().counters?.reasonCounts.HEARTBEAT_TIMEOUT).toBe(1);
  });
  it("pauses on actual ws receive and resumes after the low watermark", async () => {
    let pending = { count: 96, bytes: 0 };
    const h = await harness(socket => socket.send(syntheticTick(), { binary: false }), { capacity: () => pending });
    await h.start(); await until(() => h.wire.pauses === 1);
    pending = { count: 64, bytes: 0 }; h.clock.advance(1);
    expect(h.wire.resumes).toBe(1); expect(h.transport.diagnostics.accepted).toBe(1);
  });
  it("enforces the byte watermark separately from message count", async () => {
    let pending = { count: 1, bytes: 6 * 1024 * 1024 };
    const h = await harness(socket => socket.send(syntheticTick(), { binary: false }), { capacity: () => pending });
    await h.start(); await until(() => h.wire.pauses === 1);
    h.clock.advance(1); expect(h.wire.resumes).toBe(0);
    pending = { count: 1, bytes: 4 * 1024 * 1024 }; h.clock.advance(1);
    expect(h.wire.resumes).toBe(1);
  });
  it("stops rather than evicting on an in-flight receive burst beyond queue capacity", async () => {
    let tcp: TcpSocket;
    const h = await harness(socket => {
      // Coalesce small native frames into one in-flight write. pause() cannot
      // retract frames already inside Receiver.write(); the hard queue must stop.
      tcp.cork();
      for (let i = 0; i < 300; i++) socket.send("{}", () => {});
      tcp.uncork();
    });
    h.server.on("connection", (_socket, request) => { tcp = request.socket; });
    await h.start();
    await until(() => h.transport.terminal);
    expect(h.transport.pendingCount).toBeLessThanOrEqual(128);
    expect(h.transport.diagnostics.queuePeakCount).toBe(128);
    expect(h.transport.report().stopReason).toBe("QUEUE_COUNT_LIMIT");
    expect(h.transport.diagnostics.unprocessed).toBe(128);
    expect(h.transport.diagnostics.rejected).toBe(1);
    expect(h.transport.diagnostics.accepted).toBe(0);
    accounting(h.transport);
  });
  it("does not resume after terminate while its low-water timer is pending", async () => {
    const h = await harness(socket => socket.send(syntheticTick(), { binary: false }),
      { capacity: () => ({ count: 96, bytes: 0 }) });
    await h.start(); await until(() => h.wire.pauses === 1);
    h.transport.stop("CTRL_C"); h.clock.advance(2000);
    expect(h.wire.resumes).toBe(0); expect(h.clock.scheduled).toBe(0);
    expect(h.transport.report().stopReason).toBe("CTRL_C");
  });
  it("enforces the standalone adapter's 2-second close deadline and clears its timers", async () => {
    const server = await localServer(() => {});
    const clock = new FakeClock(), wire = emptyWireCounters();
    const client = new WsClient(server.url, clock, () => ({ count: 0, bytes: 0 }), wire);
    cleanups.push(async () => { client.terminate(); await server.close(); });
    client.listen(() => {}); client.connect();
    await until(() => wire.opens === 1);
    client.close(); client.close();
    clock.advance(LIMITS.cleanupMs);
    await until(() => server.server.clients.size === 0);
    expect(wire.terminations).toBe(1); expect(clock.scheduled).toBe(0);
  });
  it("Ctrl+C-equivalent stop disposes socket and every fake timer", async () => {
    const h = await harness(); await h.start();
    h.transport.stop("CTRL_C");
    await until(() => h.server.clients.size === 0);
    expect(h.transport.report()).toMatchObject({ state: "STOPPED", stopReason: "CTRL_C" });
    expect(h.clock.scheduled).toBe(0);
    h.clients[0].connect(); h.clients[0].subscribe(); expect(h.wire.opens).toBe(1);
  });
});

async function httpEndpoint(handler: RequestListener) {
  const server = createServer(handler);
  const sockets = new Set<TcpSocket>();
  server.on("connection", socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_TEST_ADDRESS");
  cleanups.push(() => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  return { server, url: `ws://127.0.0.1:${address.port}/` };
}
describe("HTTP upgrade refusals and handshake timeout without provider traffic", () => {
  it.each([301, 302, 307, 308])("never follows redirect %s or resolves its external Location", async status => {
    let requests = 0;
    const endpoint = await httpEndpoint((_request, response) => {
      requests++; response.writeHead(status, { Location: "ws://EXTERNAL_SENTINEL.invalid:12345/?key=SECRET_SENTINEL" }); response.end();
    });
    const clock = new FakeClock(), wire = emptyWireCounters();
    const client = new WsClient(endpoint.url, clock, () => ({ count: 0, bytes: 0 }), wire);
    const transport = new Transport(clock, () => client);
    cleanups.push(async () => { transport.stop(); client.terminate(); });
    transport.start(); await until(() => transport.terminal);
    expect(requests).toBe(1); expect(wire.redirectRejected).toBe(1);
    expect(transport.report().stopReason).toBe("FRAGMENT_PROTOCOL");
    expect(JSON.stringify(localReport(transport.report(), wire))).not.toMatch(/SENTINEL/);
  });
  it.each([401, 403])("rejects authentication HTTP %s without printing the body", async status => {
    const endpoint = await httpEndpoint((_request, response) => {
      response.writeHead(status); response.end("SECRET_SENTINEL RAW_SENTINEL");
    });
    const clock = new FakeClock(), wire = emptyWireCounters();
    const client = new WsClient(endpoint.url, clock, () => ({ count: 0, bytes: 0 }), wire);
    const transport = new Transport(clock, () => client);
    cleanups.push(async () => { transport.stop(); client.terminate(); });
    transport.start(); await until(() => transport.terminal);
    expect(transport.report().stopReason).toBe("AUTH_REJECTED");
    expect(wire.authenticationRejected).toBe(1);
    expect(JSON.stringify(localReport(transport.report(), wire))).not.toMatch(/SENTINEL/);
  });
  it("stops a real unresponsive upgrade at the P2-B fake-clock 10-second deadline", async () => {
    let upgrading = false;
    const endpoint = await httpEndpoint(() => {});
    endpoint.server.on("upgrade", () => { upgrading = true; });
    const clock = new FakeClock(), wire = emptyWireCounters();
    const client = new WsClient(endpoint.url, clock, () => ({ count: 0, bytes: 0 }), wire);
    const transport = new Transport(clock, () => client);
    cleanups.push(async () => { transport.stop(); client.terminate(); });
    transport.start(); await until(() => upgrading);
    clock.advance(9999); expect(transport.state).toBe("CONNECTING");
    clock.advance(1); expect(transport.report().stopReason).toBe("HANDSHAKE_TIMEOUT");
    expect(clock.scheduled).toBe(0);
  });
  it("confirms ws's own handshakeTimeout timer is effective, with a short local probe", async () => {
    const endpoint = await httpEndpoint(() => {});
    endpoint.server.on("upgrade", () => {});
    const client = new WebSocket(endpoint.url, { ...WS_OPTIONS, handshakeTimeout: 30 });
    cleanups.push(async () => { client.terminate(); });
    const events = { errors: 0, closes: 0 };
    client.on("error", () => { events.errors++; });
    client.on("close", () => { events.closes++; });
    await until(() => events.closes === 1);
    expect(events.errors).toBe(1); expect(client.readyState).toBe(WebSocket.CLOSED);
  });
  it("treats a synthetic subscription error as unsupported control, not a fake ACK", async () => {
    const h = await harness(socket => socket.send('{"type":"error","message":"SECRET_SENTINEL"}'));
    await h.start(); await h.drainUntil(() => h.transport.terminal);
    expect(h.transport.report().stopReason).toBe("UNSUPPORTED_CONTROL");
    expect(h.transport.report().counters?.familyCounts.error).toBe(1);
    expect(h.transport.report().counters?.stateVisits.RUNNING).toBe(0);
    expect(JSON.stringify(localReport(h.transport.report(), h.wire))).not.toMatch(/SENTINEL/);
  });
});

describe("finite local session and isolated CLI", () => {
  it("runs actual local RFC traffic with fixed-schema counters only", async () => {
    const result = await localWsSession();
    expect(result).toMatchObject({
      network: "LOOPBACK_ONLY", state: "STOPPED", stopReason: "COMPLETED",
      counters: { accepted: 2, control: 1, receivedMessages: 3, pending: 0, accountingMatches: true },
      wire: { protocolPing: 1, protocolPong: 1, jsonPongSent: 1, protocolFailures: 0, closes: 1 },
      evidence: { subscriptionConfirmed: "UNCONFIRMED" },
    });
    expect(readLocalReport(result)).toEqual(result);
  });
  it.each([["--local-ws", "ws://EXTERNAL_SENTINEL.invalid:12345/"], ["--smoke-live"]])(
    "rejects forbidden CLI arguments before creating a socket", async (...args: string[]) => {
      const child = spawn(process.execPath, [
        "--experimental-transform-types", "--disable-warning=ExperimentalWarning",
        fileURLToPath(new URL("./poc.ts", import.meta.url)), ...args,
      ], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
      cleanups.push(async () => { if (child.exitCode === null) child.kill("SIGKILL"); });
      let stdout = "", stderr = "";
      child.stdout.on("data", bytes => { stdout += bytes; });
      child.stderr.on("data", bytes => { stderr += bytes; });
      const code = await new Promise<number | null>(resolve => child.once("exit", resolve));
      expect(code).toBe(1); expect(stderr).toBe("");
      expect(stdout).not.toMatch(/SENTINEL|RAW|key=/);
      expect(JSON.parse(stdout)).toMatchObject({ state: "FAILED", stopReason: "SESSION_FAILURE", counters: null });
    },
  );
});
