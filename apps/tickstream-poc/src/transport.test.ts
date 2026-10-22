import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { parsePublicSample } from "@workspace/tickstream-adapter";
import { REASON_CODES, type ParseInput } from "@workspace/tickstream-adapter/envelope";
import { Diagnostics, readReport, STATES, TRANSPORT_REASONS } from "./diagnostics";
import {
  FakeClock, FakeSocket, LIMITS, SYNTHETIC_UTC_MS, Transport, transition,
  type Socket, type SocketEvent,
} from "./transport";
import { syntheticSession, syntheticTick, unavailableReport, watchdog } from "./session";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const tick = (change: Record<string, unknown> = {}): Uint8Array =>
  encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(syntheticTick())), ...change }));
function harness(parser: (input: ParseInput) => ReturnType<typeof parsePublicSample> = parsePublicSample) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const transport = new Transport(clock, () => {
    const socket = new FakeSocket(); sockets.push(socket); return socket;
  }, parser);
  const start = (): FakeSocket => {
    transport.start();
    const socket = sockets.at(-1)!;
    socket.emit({ type: "open" }); socket.emit({ type: "subscribed" }); return socket;
  };
  const send = (bytes = syntheticTick(), socket = sockets.at(-1)!): void => { socket.emit({ type: "text", bytes }); };
  return { clock, sockets, transport, start, send };
}
function expectAccounting(transport: Transport): void {
  expect(transport.report().counters?.accountingMatches).toBe(true);
}

describe("strict pure state machine", () => {
  it.each([
    ["IDLE", "CONNECT", "CONNECTING"], ["CONNECTING", "OPEN", "CONNECTED"],
    ["CONNECTED", "SUBSCRIBE", "SUBSCRIBING"], ["SUBSCRIBING", "ACK", "RUNNING"],
    ["RUNNING", "INTERRUPT", "INTERRUPTED"], ["INTERRUPTED", "WAIT", "RECONNECT_WAIT"],
    ["RECONNECT_WAIT", "RETRY", "CONNECTING"], ["RUNNING", "STOP", "STOPPING"],
    ["STOPPING", "FINISH", "STOPPED"], ["STOPPING", "FAIL", "FAILED"],
  ] as const)("%s + %s = %s", (from, action, to) => expect(transition(from, action)).toBe(to));
  it.each(STATES.filter(s => s !== "IDLE"))("%s rejects CONNECT", state => {
    expect(() => transition(state, "CONNECT")).toThrow("INVALID_TRANSPORT_TRANSITION");
  });
  it("rejects ACK before subscribing", () => expect(() => transition("CONNECTING", "ACK")).toThrow());
});

describe("connection, subscription, epoch and shutdown", () => {
  it("normal connection/subscription/receive/stop and immutable parser context", () => {
    const parser = vi.fn(parsePublicSample), h = harness(parser), socket = h.start();
    h.send(); h.clock.advance(0); h.transport.stop(); h.clock.advance(2000);
    const report = h.transport.report();
    expect(report.state).toBe("STOPPED"); expect(report.source).toBe("SYNTHETIC_TEST");
    expect(report.network).toBe("DISABLED"); expect(report.persistence).toBe("DISABLED");
    expect(report.counters?.accepted).toBe(1);
    expect(report.counters?.subscriptionAttempts).toBe(1);
    expect(socket.calls).toMatchObject({ connect: 1, subscribe: 1, close: 1, terminate: 1 });
    expect(parser.mock.calls[0][0]).toMatchObject({
      schemaProfile: "WS_TICK_LIVE_V1", instrument: { kind: "CORE_NQ", symbol: "NQ" },
      provenance: { sampleOrigin: "SYNTHETIC_TEST", timestampUnit: "s",
        sourceUrl: "https://tick-stream.xyz/docs/streaming" },
    });
    expect(h.clock.scheduled).toBe(0); expectAccounting(h.transport);
  });
  it("handshake timeout at exactly 10 seconds", () => {
    const h = harness(); h.transport.start(); h.clock.advance(9999);
    expect(h.transport.state).toBe("CONNECTING"); h.clock.advance(1);
    expect(h.transport.report()).toMatchObject({ state: "FAILED", stopReason: "HANDSHAKE_TIMEOUT" });
    expect(h.clock.scheduled).toBe(0);
  });
  it.each(["authRejected", "subscriptionRejected"] as const)("stops on %s without reconnect", type => {
    const h = harness(); h.start(); h.sockets[0].emit({ type });
    expect(h.transport.state).toBe("FAILED");
    expect(h.transport.report().counters?.reconnectAttempts).toBe(0);
  });
  it("prevents double connection and subscription", () => {
    const h = harness(), socket = h.start();
    for (let i = 0; i < 10; i++) {
      h.transport.start(); socket.emit({ type: "open" }); socket.emit({ type: "subscribed" });
    }
    expect(h.sockets).toHaveLength(1);
    expect(socket.calls.connect).toBe(1); expect(socket.calls.subscribe).toBe(1);
    h.transport.stop();
  });
  it.each([["close", "error"], ["error", "close"]] as const)("handles %s/%s race once", (first, second) => {
    const h = harness(), socket = h.start();
    socket.emit({ type: first }); socket.emit({ type: second });
    expect(h.transport.state).toBe("RECONNECT_WAIT");
    expect(socket.calls.terminate).toBe(1);
    h.clock.advance(45_999); expect(h.sockets).toHaveLength(1);
    h.clock.advance(1); expect(h.sockets).toHaveLength(2);
    h.sockets[1].emit({ type: "open" }); h.sockets[1].emit({ type: "subscribed" });
    h.sockets[1].emit({ type: "close" });
    expect(h.transport.report()).toMatchObject({ state: "FAILED", stopReason: "RECONNECT_LIMIT" });
    expect(h.transport.report().counters?.reconnectAttempts).toBe(1);
    h.clock.advance(120_000); expect(h.sockets).toHaveLength(2);
  });
  it("ignores stale epoch callbacks immediately", () => {
    const h = harness(), socket = h.start();
    socket.emit({ type: "close" }); socket.emit({ type: "open" });
    h.send(syntheticTick(), socket);
    expect(h.transport.report().counters?.receivedMessages).toBe(0);
    h.clock.advance(46_000); h.sockets[1].emit({ type: "open" });
    h.sockets[1].emit({ type: "subscribed" }); h.send(); h.clock.advance(0);
    expect(h.transport.report().counters?.accepted).toBe(1); h.transport.stop();
  });
  it("Ctrl+C during reconnect prevents retry", () => {
    const h = harness(); h.start().emit({ type: "close" });
    h.transport.stop("CTRL_C"); h.transport.stop("CTRL_C");
    h.clock.advance(120_000);
    expect(h.sockets).toHaveLength(1); expect(h.transport.state).toBe("STOPPED");
    expect(h.transport.report().counters?.reasonCounts.CTRL_C).toBe(1);
  });
  it("Ctrl+C while processing does not double-count or double-stop", () => {
    let h: ReturnType<typeof harness>;
    h = harness(input => { h.transport.stop("CTRL_C"); return parsePublicSample(input); });
    h.start(); h.send(); h.clock.advance(0);
    expect(h.transport.state).toBe("STOPPED"); expect(h.transport.report().counters?.accepted).toBe(1);
    expect(h.sockets[0].calls.close).toBe(1); expectAccounting(h.transport);
  });
  it("catches socket factory exceptions without exposing text", () => {
    const clock = new FakeClock();
    const transport = new Transport(clock, () => { throw new Error("SECRET_SENTINEL"); });
    transport.start(); expect(transport.state).toBe("FAILED");
    expect(JSON.stringify(transport.report())).not.toContain("SECRET_SENTINEL");
  });
  it("catches subscribe exceptions", () => {
    const h = harness(); h.transport.start();
    h.sockets[0].subscribe = () => { throw new Error("SECRET_SENTINEL"); };
    h.sockets[0].emit({ type: "open" });
    expect(h.transport.report().stopReason).toBe("SOCKET_ERROR");
  });
});

describe("heartbeat and cumulative time bounds", () => {
  it("heartbeat timeout after 30 seconds enters bounded reconnect", () => {
    const h = harness(); h.start(); h.clock.advance(29_999);
    expect(h.transport.state).toBe("RUNNING"); h.clock.advance(1);
    expect(h.transport.state).toBe("RECONNECT_WAIT");
    expect(h.transport.report().counters?.reasonCounts.HEARTBEAT_TIMEOUT).toBe(1);
    h.transport.stop();
  });
  it("separates JSON and WebSocket ping counters", () => {
    const h = harness(), socket = h.start();
    h.send(encode('{"type":"ping"}')); socket.emit({ type: "wsPing" });
    h.clock.advance(0);
    expect(socket.calls.jsonPong).toBe(1); expect(socket.calls.wsPong).toBe(1);
    expect(h.transport.report().counters).toMatchObject({ control: 1, heartbeatCount: 2, receivedMessages: 1 });
    expectAccounting(h.transport); h.transport.stop();
  });
  it("heartbeat refresh is monotonic, bounded and not a tick completeness guarantee", () => {
    const h = harness(), socket = h.start();
    h.clock.advance(20_000); socket.emit({ type: "wsPing" });
    h.clock.advance(20_000); expect(h.transport.state).toBe("RUNNING");
    socket.emit({ type: "wsPing" }); h.clock.advance(20_000);
    expect(h.transport.report().stopReason).toBe("ACTIVE_TIME_LIMIT");
    expect(h.transport.report().marketMissingEvents).toBe("NOT_MEASURABLE");
  });
  it("60 second active budget is not reset by reconnect", () => {
    const h = harness(); const first = h.start(); h.clock.advance(20_000);
    first.emit({ type: "close" }); h.clock.advance(46_000);
    const second = h.sockets[1]; second.emit({ type: "open" }); second.emit({ type: "subscribed" });
    h.clock.advance(20_000); second.emit({ type: "wsPing" });
    h.clock.advance(19_999); expect(h.transport.state).toBe("RUNNING");
    h.clock.advance(1); expect(h.transport.report().stopReason).toBe("ACTIVE_TIME_LIMIT");
  });
  it("wall deadline survives reconnect and reserves cleanup", () => {
    const h = harness(), first = h.start();
    h.clock.advance(20_000); first.emit({ type: "wsPing" });
    h.clock.advance(29_000); first.emit({ type: "close" });
    h.clock.advance(46_000); // now 95 seconds; leave reconnect handshake uncompleted.
    h.clock.advance(10_000); // handshake stop is earlier than wall; no leaked later timers.
    expect(h.transport.report().stopReason).toBe("HANDSHAKE_TIMEOUT");
    h.clock.advance(120_000); expect(h.clock.scheduled).toBe(0);
  });
  it("wall bound stops a connection that never completes subscription", () => {
    // Fake Clock independently triggers the wall callback before all other timers.
    const callbacks = new Map<number, () => void>();
    const clock = {
      monoNs: () => 0n, utcMs: () => SYNTHETIC_UTC_MS,
      schedule: (ms: number, fn: () => void) => { callbacks.set(ms, fn); return () => { callbacks.delete(ms); }; },
    };
    const transport = new Transport(clock, () => new FakeSocket()); transport.start();
    callbacks.get(118_000)!();
    expect(transport.report().stopReason).toBe("WALL_TIME_LIMIT");
    expect(transport.terminal).toBe(true);
  });
});

describe("bounded queue and fragment assembly", () => {
  it("accepts exactly 128 pending messages then explicitly stops on 129", () => {
    const h = harness(); h.start();
    for (let i = 0; i < 128; i++) h.send();
    expect(h.transport.pendingCount).toBe(128);
    h.send();
    expect(h.transport.report()).toMatchObject({ state: "FAILED", stopReason: "QUEUE_COUNT_LIMIT" });
    expect(h.transport.report().counters).toMatchObject({ rejected: 1, unprocessed: 128, queuePeakCount: 128 });
    expect(h.transport.pendingBytes).toBe(0); expectAccounting(h.transport);
  });
  it("exactly 8 MiB fits and the next byte fails without eviction", () => {
    const h = harness(); h.start(); const bytes = new Uint8Array(LIMITS.messageBytes);
    for (let i = 0; i < 8; i++) h.send(bytes);
    expect(h.transport.pendingBytes).toBe(LIMITS.queueBytes);
    h.send(new Uint8Array(1));
    expect(h.transport.report().stopReason).toBe("QUEUE_BYTE_LIMIT");
    expect(h.transport.report().counters).toMatchObject({ queuePeakBytes: LIMITS.queueBytes, unprocessed: 8, rejected: 1 });
    expectAccounting(h.transport);
  });
  it("counts the active parser call in the 128-message capacity", () => {
    let h: ReturnType<typeof harness>;
    h = harness(input => {
      expect(h.transport.pendingCount).toBe(1);
      for (let i = 0; i < 127; i++) h.send();
      expect(h.transport.pendingCount).toBe(128);
      h.send(); return parsePublicSample(input);
    });
    h.start(); h.send(); h.clock.advance(0);
    expect(h.transport.report().counters).toMatchObject({ accepted: 0, rejected: 1, unprocessed: 128, queuePeakCount: 128 });
    expectAccounting(h.transport);
  });
  it("counts active bytes in the 8 MiB capacity", () => {
    let h: ReturnType<typeof harness>;
    const base = new TextDecoder().decode(syntheticTick());
    const padded = encode(base.padEnd(LIMITS.messageBytes));
    h = harness(input => {
      expect(h.transport.pendingBytes).toBe(LIMITS.messageBytes);
      for (let i = 0; i < 7; i++) h.send(padded);
      h.send(new Uint8Array(1)); return parsePublicSample(input);
    });
    h.start(); h.send(padded); h.clock.advance(0);
    expect(h.transport.report().stopReason).toBe("QUEUE_BYTE_LIMIT"); expectAccounting(h.transport);
  });
  it("rejects oversized complete message before copy/parser", () => {
    const parser = vi.fn(parsePublicSample), h = harness(parser); h.start();
    h.send(new Uint8Array(LIMITS.messageBytes + 1));
    expect(h.transport.report().stopReason).toBe("PAYLOAD_TOO_LARGE");
    expect(parser).not.toHaveBeenCalled(); expectAccounting(h.transport);
  });
  it("reassembles split UTF-8 and JSON before parsing", () => {
    const h = harness(), socket = h.start(), bytes = syntheticTick();
    socket.emit({ type: "fragment", bytes: bytes.subarray(0, 7), final: false });
    expect(h.transport.pendingBytes).toBe(7); expect(h.transport.pendingCount).toBe(1);
    socket.emit({ type: "fragment", bytes: bytes.subarray(7), final: true });
    h.clock.advance(0);
    expect(h.transport.report().counters).toMatchObject({ receivedMessages: 1, accepted: 1, payloadBytes: bytes.length });
    expectAccounting(h.transport); h.transport.stop();
  });
  it("fragmented oversized message fails before oversized allocation", () => {
    const parser = vi.fn(parsePublicSample), h = harness(parser), socket = h.start();
    socket.emit({ type: "fragment", bytes: new Uint8Array(LIMITS.messageBytes), final: false });
    socket.emit({ type: "fragment", bytes: new Uint8Array(1), final: true });
    expect(h.transport.report().stopReason).toBe("PAYLOAD_TOO_LARGE");
    expect(h.transport.report().counters?.fragmentPeakBytes).toBe(LIMITS.messageBytes);
    expect(h.transport.pendingCount).toBe(0); expect(parser).not.toHaveBeenCalled();
    expectAccounting(h.transport);
  });
  it("zero-byte fragments cannot create an unbounded parts array", () => {
    const h = harness(), socket = h.start();
    for (let i = 0; i <= LIMITS.fragments; i++) socket.emit({ type: "fragment", bytes: new Uint8Array(), final: false });
    expect(h.transport.report().stopReason).toBe("FRAGMENT_LIMIT"); expectAccounting(h.transport);
  });
  it("fragment assembly reserves a queue slot", () => {
    const h = harness(), socket = h.start();
    for (let i = 0; i < 127; i++) h.send();
    socket.emit({ type: "fragment", bytes: new Uint8Array(1), final: false });
    expect(h.transport.pendingCount).toBe(128);
    h.send();
    expect(h.transport.state).toBe("FAILED"); expectAccounting(h.transport);
  });
  it("fragment assembly shares the byte budget with queued messages", () => {
    const h = harness(), socket = h.start(), bytes = new Uint8Array(LIMITS.messageBytes);
    for (let i = 0; i < 7; i++) h.send(bytes);
    socket.emit({ type: "fragment", bytes, final: false });
    socket.emit({ type: "fragment", bytes: new Uint8Array(1), final: true });
    expect(h.transport.state).toBe("FAILED"); expectAccounting(h.transport);
  });
  it("unfinished fragment is unprocessed on Ctrl+C", () => {
    const h = harness(), socket = h.start();
    socket.emit({ type: "fragment", bytes: new Uint8Array([123]), final: false });
    h.transport.stop("CTRL_C");
    expect(h.transport.report().counters?.unprocessed).toBe(1); expectAccounting(h.transport);
  });
  it("unfinished fragment cannot cross a connection epoch", () => {
    const h = harness(), socket = h.start();
    socket.emit({ type: "fragment", bytes: new Uint8Array([123]), final: false });
    socket.emit({ type: "close" }); expect(h.transport.pendingBytes).toBe(0);
    h.clock.advance(46_000); h.sockets[1].emit({ type: "open" }); h.sockets[1].emit({ type: "subscribed" });
    h.send(); h.clock.advance(0);
    expect(h.transport.report().counters).toMatchObject({ accepted: 1, unprocessed: 1 });
    expectAccounting(h.transport); h.transport.stop();
  });
  it("1000th processed message stops after draining, never admits an unbounded run", () => {
    const h = harness(); h.start();
    for (let i = 0; i < 1000; i++) { h.send(); h.clock.advance(0); }
    expect(h.transport.report()).toMatchObject({ state: "STOPPED", stopReason: "MESSAGE_LIMIT" });
    expect(h.transport.report().counters?.accepted).toBe(1000); expectAccounting(h.transport);
  });
  it("64 MiB cumulative payload ends a fully drained session", () => {
    const h = harness(); h.start();
    const raw = encode(new TextDecoder().decode(syntheticTick()).padEnd(LIMITS.messageBytes));
    for (let i = 0; i < 64; i++) { h.send(raw); h.clock.advance(0); }
    expect(h.transport.report()).toMatchObject({ state: "STOPPED", stopReason: "PAYLOAD_LIMIT" });
    expect(h.transport.report().counters?.accepted).toBe(64);
    expect(h.transport.report().counters?.payloadBytes).toBe(LIMITS.payloadBytes);
    expectAccounting(h.transport);
  });
});

describe("parser refusals, time and diagnostics", () => {
  it.each([
    ["malformed JSON", encode("{"), "INVALID_JSON"],
    ["invalid UTF-8", new Uint8Array([0xff]), "INVALID_UTF8"],
    ["off tick", tick({ price: 20000.10 }), "OFF_TICK_GRID"],
    ["negative size", tick({ size: -1 }), "INVALID_QUANTITY"],
    ["noninteger size", tick({ size: 1.1 }), "INVALID_QUANTITY"],
    ["unknown field", tick({ RAW_PAYLOAD_SENTINEL: "SECRET_SENTINEL" }), "UNSUPPORTED_FIELD"],
    ["bad timestamp", tick({ ts: -1 }), "INVALID_TIMESTAMP"],
    ["microseconds mislabelled as seconds", tick({ ts: SYNTHETIC_UTC_MS * 1000 }), "TIMESTAMP_CONTEXT_MISMATCH"],
    ["stale timestamp", tick({ ts: SYNTHETIC_UTC_MS / 1000 - 86401 }), "TIMESTAMP_CONTEXT_MISMATCH"],
  ] as const)("rejects %s, preserves reason without payload", (_name, bytes, reason) => {
    const h = harness(); h.start(); h.send(bytes); h.clock.advance(0);
    const report = h.transport.report();
    expect(report).toMatchObject({ state: "FAILED", stopReason: reason });
    expect(report.counters?.reasonCounts[reason]).toBe(1);
    expect(report.counters?.rejected).toBe(1); expectAccounting(h.transport);
    const json = JSON.stringify(report);
    expect(json).not.toContain("RAW_PAYLOAD_SENTINEL"); expect(json).not.toContain("SECRET_SENTINEL");
    expect(json).not.toContain("price"); expect(json).not.toContain("side"); expect(json).not.toContain("fieldPath");
  });
  it("same-content prints are both accepted, not heuristically deduplicated", () => {
    const h = harness(); h.start(); h.send(); h.send(); h.clock.advance(0);
    expect(h.transport.report().counters?.accepted).toBe(2); h.transport.stop(); expectAccounting(h.transport);
  });
  it("parser exception is sanitized", () => {
    const h = harness(() => { throw new Error("SECRET_SENTINEL https://bad/?key=SECRET_SENTINEL"); });
    h.start(); h.send(); h.clock.advance(0);
    expect(h.transport.report().stopReason).toBe("PARSER_EXCEPTION");
    expect(JSON.stringify(h.transport.report())).not.toContain("SECRET_SENTINEL"); expectAccounting(h.transport);
  });
  it.each(["warning", "feed", "error"])("does not treat %s as a tick or recover continuity", type => {
    const h = harness(); h.start(); h.send(encode(JSON.stringify({ type }))); h.clock.advance(0);
    expect(h.transport.report().stopReason).toBe("UNSUPPORTED_CONTROL"); expectAccounting(h.transport);
  });
  it.each(["welcome", "pong"])("%s is control, not a trade", type => {
    const h = harness(); h.start(); h.send(encode(JSON.stringify({ type }))); h.clock.advance(0);
    expect(h.transport.report().counters).toMatchObject({ control: 1, accepted: 0 });
    h.transport.stop(); expectAccounting(h.transport);
  });
  it("receive intervals and provider age use separate fixed histograms", () => {
    const h = harness(); h.start(); h.send(); h.clock.advance(10); h.send(); h.clock.advance(0);
    const c = h.transport.report().counters!;
    expect(c.receiveIntervalBuckets).toEqual([0, 0, 1, 0, 0]);
    expect(c.providerAgeBuckets).toEqual([0, 0, 0, 2, 0]);
    expect(c.familyCounts.tick).toBe(2); h.transport.stop();
  });
  it("reason and family key cardinality are fixed", () => {
    const h = harness(); h.start(); h.send(tick({ type: "SECRET_SENTINEL" })); h.clock.advance(0);
    const c = h.transport.report().counters!;
    expect(Object.keys(c.reasonCounts).sort()).toEqual([...REASON_CODES, ...TRANSPORT_REASONS].sort());
    expect(c.familyCounts.OTHER).toBe(1); expect(Object.keys(c.familyCounts)).toHaveLength(8);
  });
  it("fatal queued refusal upgrades a graceful message-limit stop", () => {
    const h = harness(); h.start();
    for (let i = 0; i < 999; i++) { h.send(); h.clock.advance(0); }
    h.send(encode("{")); h.clock.advance(0);
    expect(h.transport.report()).toMatchObject({ state: "FAILED", stopReason: "INVALID_JSON" });
    expectAccounting(h.transport);
  });
  it("deterministic finite synthetic session", () => {
    expect(syntheticSession()).toEqual(syntheticSession());
    expect(syntheticSession()).toMatchObject({
      state: "STOPPED", stopReason: "COMPLETED",
      counters: { accepted: 2, control: 1, heartbeatCount: 2, accountingMatches: true },
    });
  });
});

describe("watchdog, memory failure and termination", () => {
  it("fake-time watchdog decision really SIGKILLs an isolated synthetic child", async () => {
    const child = spawn(process.execPath, ["-e",
      "process.send({type:'READY'});setInterval(()=>{},1000);"], {
      env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("message", () => {
          const action = watchdog({
            elapsedMs: LIMITS.wallMs, stopElapsedMs: null, sessionRss: 1, totalRss: 2,
          });
          if (action.kind !== "FORCE_TERMINATE") { reject(new Error("WATCHDOG_DID_NOT_FORCE")); return; }
          child.kill("SIGKILL");
        });
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(result).toEqual({ code: null, signal: "SIGKILL" });
      expect(unavailableReport("FORCED_TERMINATION").counters).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
  it("hard wall deadline cannot be extended by a late stop request", () => {
    expect(watchdog({ elapsedMs: 120_000, stopElapsedMs: 1, sessionRss: 1, totalRss: 2 }).kind)
      .toBe("FORCE_TERMINATE");
  });
  it("report IPC projection removes arbitrary nested fields and key-bearing URLs", () => {
    const report = syntheticSession();
    const dirty = {
      ...report, url: "https://bad/?key=SECRET_SENTINEL",
      counters: {
        ...report.counters, raw: "RAW_PAYLOAD_SENTINEL",
        reasonCounts: { ...report.counters!.reasonCounts, SECRET_SENTINEL: 1 },
      },
    };
    const safe = readReport(dirty);
    expect(safe).toEqual(report);
    expect(JSON.stringify(safe)).not.toContain("SENTINEL");
  });
  it.each([
    { state: "SECRET_SENTINEL" }, { stopReason: "SECRET_SENTINEL" },
    { counters: { receivedMessages: "SECRET_SENTINEL" } }, { network: "ENABLED" },
    { contract: "NQM6" },
  ])("refuses malformed IPC report %j", change => {
    expect(readReport({ ...syntheticSession(), ...change })).toBeNull();
  });
  it("no synthetic-session operation constructs a network client", () => {
    const deny = vi.fn(() => { throw new Error("NETWORK_PROHIBITED"); });
    vi.stubGlobal("WebSocket", deny); vi.stubGlobal("fetch", deny);
    try { expect(syntheticSession().state).toBe("STOPPED"); expect(deny).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });
  it("a rejected queued input also accounts for all remaining messages", () => {
    const h = harness(); h.start(); h.send(encode("{")); h.send(); h.send();
    h.clock.advance(0);
    expect(h.transport.report().counters).toMatchObject({ rejected: 1, unprocessed: 2, pending: 0 });
    expectAccounting(h.transport);
  });
  it("UTF-8 fragments are joined before validation, never decoded separately", () => {
    const h = harness(), socket = h.start(), bytes = tick({ side: "買" });
    const first = bytes.findIndex(value => value >= 0x80);
    socket.emit({ type: "fragment", bytes: bytes.subarray(0, first + 1), final: false });
    socket.emit({ type: "fragment", bytes: bytes.subarray(first + 1), final: true });
    h.clock.advance(0);
    expect(h.transport.report().stopReason).toBe("INVALID_SIDE");
    expect(h.transport.report().counters?.reasonCounts.INVALID_UTF8).toBe(0); expectAccounting(h.transport);
  });
  it.each(["close", "terminate"] as const)("contains %s exceptions during stop", method => {
    const h = harness(), socket = h.start();
    socket[method] = () => { throw new Error("SECRET_SENTINEL"); };
    expect(() => h.transport.stop()).not.toThrow();
    expect(h.transport.report()).toMatchObject({ state: "FAILED", stopReason: "SOCKET_ERROR" });
    expect(JSON.stringify(h.transport.report())).not.toContain("SECRET_SENTINEL");
  });
  it.each([
    [null, null, "MEMORY_NOT_MEASURED"], [NaN, NaN, "MEMORY_NOT_MEASURED"],
    [Infinity, Infinity, "MEMORY_NOT_MEASURED"], [-1, 0, "MEMORY_NOT_MEASURED"],
    [100, 50, "MEMORY_NOT_MEASURED"],
    [LIMITS.sessionRss + 1, LIMITS.totalRss, "MEMORY_THRESHOLD"],
    [100, LIMITS.totalRss + 1, "MEMORY_THRESHOLD"],
  ] as const)("memory sample %s/%s stops as %s", (session, total, reason) => {
    const h = harness(); h.start(); h.transport.checkMemory(session, total);
    expect(h.transport.report()).toMatchObject({ state: "FAILED", stopReason: reason });
    expect(watchdog({ elapsedMs: 1, stopElapsedMs: null, sessionRss: session, totalRss: total }))
      .toEqual({ kind: "REQUEST_STOP", reason });
  });
  it("exact memory thresholds are allowed, not advertised as OS hard limits", () => {
    const h = harness(); h.start(); h.transport.checkMemory(LIMITS.sessionRss, LIMITS.totalRss);
    expect(h.transport.state).toBe("RUNNING");
    expect(h.transport.report().memory).toMatchObject({
      measurement: "MEASURED", kind: "MONITORING_THRESHOLD_NOT_OS_HARD_LIMIT",
    }); h.transport.stop();
  });
  it("wall deadline requests stop with two seconds reserved", () => {
    expect(watchdog({ elapsedMs: 118_000, stopElapsedMs: null, sessionRss: 1, totalRss: 2 }))
      .toEqual({ kind: "REQUEST_STOP", reason: "WALL_TIME_LIMIT" });
  });
  it("unresponsive child is force-terminated after cleanup budget", () => {
    expect(watchdog({ elapsedMs: 100, stopElapsedMs: 1999, sessionRss: 1, totalRss: 2 }).kind).toBe("CONTINUE");
    expect(watchdog({ elapsedMs: 100, stopElapsedMs: 2000, sessionRss: 1, totalRss: 2 }).kind).toBe("FORCE_TERMINATE");
    expect(watchdog({ elapsedMs: 120_000, stopElapsedMs: null, sessionRss: 1, totalRss: 2 }).kind).toBe("FORCE_TERMINATE");
  });
  it("forced termination never fabricates zero counters", () => {
    expect(unavailableReport("FORCED_TERMINATION")).toMatchObject({
      state: "FAILED", counters: null, memory: { measurement: "NOT_MEASURED", sessionRssPeak: null },
    });
  });
  it("closes without waiting indefinitely for a close acknowledgement", () => {
    const h = harness(); const socket = h.start(); socket.close = () => { socket.calls.close++; };
    h.transport.stop(); h.clock.advance(2000);
    expect(h.transport.terminal).toBe(true); expect(h.clock.scheduled).toBe(0);
  });
  it("measurement failure is sticky, not overwritten by a later sample", () => {
    const d = new Diagnostics(); d.memory(null, null); d.memory(1, 2);
    expect(d.report("FAILED", "MEMORY_NOT_MEASURED", 0).memory.measurement).toBe("NOT_MEASURED");
  });
  it("untrusted events never create diagnostic string keys", () => {
    const h = harness(), socket = h.start();
    socket.emit({ type: "error", message: "SECRET_SENTINEL", stack: "RAW_PAYLOAD_SENTINEL" } as unknown as SocketEvent);
    expect(JSON.stringify(h.transport.report())).not.toContain("SENTINEL"); h.transport.stop();
  });
  it("clock timers are bounded even with missing cancellation", () => {
    const clock = new FakeClock();
    for (let i = 0; i < 4096; i++) clock.schedule(1, () => {});
    expect(() => clock.schedule(1, () => {})).toThrow("SCHEDULER_LIMIT");
    clock.advance(1); expect(clock.scheduled).toBe(0);
  });
});
