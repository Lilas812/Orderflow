import { describe, expect, it } from "vitest";
import type { ObservationRecord } from "@workspace/tickstream-adapter/live-observation";
import { FakeClock, FakeSocket, LIMITS } from "./transport";
import { classifyMessage } from "./liveControl";
import { ObservationTransport, type TransportOptions } from "./liveTransport";
import { liveConnectionGate } from "./liveConfig";

const tick = { type: "tick", symbol: "NQ", price: 20000.25, size: 12, side: "buy", exch: "CME", ts: 1700000000 };
const bytes = (input: unknown) => new TextEncoder().encode(JSON.stringify(input));
function harness(options: Partial<TransportOptions> = {}, fail = false) {
  const clock = new FakeClock(), sockets: FakeSocket[] = [], records: ObservationRecord[] = [];
  const transport = new ObservationTransport(clock, () => {
    const s = new FakeSocket(); sockets.push(s); return s;
  }, { append(record) {
    if (fail) throw Error("RAW_KEY_URL_STACK_SENTINEL");
    records.push(record); return { position: records.length, head: "a".repeat(64), bytes: records.length * 100 };
  } }, { channel: "ticks", ...options });
  transport.start();
  return { clock, sockets, transport, records,
    open: () => sockets.at(-1)!.emit({ type: "open" }),
    send: (input: unknown) => sockets.at(-1)!.emit({ type: "text", bytes: bytes(input) }) };
}
describe("strict control classification, no fictitious provider ACK", () => {
  it.each([
    [{ type: "ping" }, "JSON_PING", false], [{ type: "pong", id: 1 }, "JSON_PONG", false],
    [{ type: "welcome", plan: "SECRET_SENTINEL" }, "WELCOME_UNVERIFIED", false],
    [{ type: "error", error: { code: "invalid_key", message: "SECRET_SENTINEL" } }, "AUTH_REJECTED", true],
    [{ type: "error", error: { code: "plan_required" } }, "ENTITLEMENT_REJECTED", true],
    [{ type: "error", error: { code: "too_many_connections" } }, "CONNECTION_LIMIT", true],
    [{ type: "error", error: { code: "unknown_symbol" } }, "SUBSCRIPTION_REJECTED", true],
    [{ type: "warning", message: "SECRET_SENTINEL" }, "LAG_WARNING", true],
    [{ type: "feed" }, "FEED_UNVERIFIED", true],
    [{ type: "SECRET_SENTINEL", unknown: "SECRET_SENTINEL" }, "UNKNOWN_CONTROL", true],
    [{ type: "ping", arbitrary: "SECRET_SENTINEL" }, "UNKNOWN_CONTROL", true],
  ] as const)("classifies only fixed outcomes", (wire, code, stop) => {
    const result = classifyMessage(bytes(wire));
    expect(result).toEqual({ kind: "control", code, stop });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });
  it("rejects invalid UTF8/JSON/oversized frames", () => {
    expect(classifyMessage(new Uint8Array([0xff]))).toMatchObject({ code: "INVALID_UTF8" });
    expect(classifyMessage(new TextEncoder().encode("{"))).toMatchObject({ code: "INVALID_JSON" });
    expect(classifyMessage(new Uint8Array(LIMITS.messageBytes + 1))).toMatchObject({ code: "MESSAGE_TOO_LARGE" });
  });
});
describe("bounded separate Gate A observation pipeline", () => {
  it("keeps duplicate Trades, persists only after receipts and never promotes continuity", () => {
    const h = harness({ manualDrain: true }); h.open(); h.send(tick); h.send(tick);
    expect(h.transport.report().counters.persisted).toBe(0);
    h.transport.drainReceive();
    expect(h.transport.report()).toMatchObject({ counters: { accepted: 2, persisted: 0 }, pendingStorage: 2 });
    h.transport.drainStorage(); h.transport.finish();
    expect(h.transport.report()).toMatchObject({
      state: "STOPPED", stopReason: "COMPLETED", subscriptionConfirmed: "UNCONFIRMED",
      counters: { received: 2, parsed: 2, persisted: 2 }, accountingMatches: true,
    });
    expect(h.records[0].result).toEqual(h.records[1].result);
    expect(h.records.map(r => r.provenance.receiveOrdinal)).toEqual([1, 2]);
    expect(h.records.every(r => r.provenance.environment === "SIMULATED" && r.provenance.continuityStatus === "UNKNOWN")).toBe(true);
    expect(h.clock.scheduled).toBe(0);
  });
  it("keeps failing persistence owned and never blindly retries", () => {
    const h = harness({ manualDrain: true }, true); h.open(); h.send(tick);
    h.transport.drainReceive(); h.transport.drainStorage(); h.transport.drainStorage();
    expect(h.transport.report()).toMatchObject({
      state: "FAILED", stopReason: "STORAGE_FAILED", pendingStorage: 1,
      counters: { parsed: 1, persisted: 0, persistenceFailed: 1, storageFailures: 1 }, accountingMatches: true,
    });
    expect(JSON.stringify(h.transport.report())).not.toMatch(/SENTINEL|20000|buy|key=|stack/);
  });
  it("stops explicitly on receive count overflow, without hidden eviction", () => {
    const h = harness({ manualDrain: true }); h.open();
    for (let n = 0; n < 129; n++) h.send(tick);
    expect(h.transport.report()).toMatchObject({
      stopReason: "QUEUE_COUNT_LIMIT", pendingReceive: 128, accountingMatches: true,
      counters: { received: 129, unprocessed: 1, queuePeakCount: 128 },
    });
  });
  it("stops on receive byte overflow independently of count", () => {
    const h = harness({ manualDrain: true }); h.open();
    const big = { ...tick, padding: "x".repeat(LIMITS.messageBytes - 1000) };
    for (let n = 0; n < 9; n++) h.send(big);
    expect(h.transport.report()).toMatchObject({ stopReason: "QUEUE_BYTE_LIMIT", pendingReceive: 8,
      counters: { unprocessed: 1 }, accountingMatches: true });
    expect(h.transport.report().counters.queuePeakBytes).toBeLessThanOrEqual(LIMITS.queueBytes);
  });
  it("keeps one bounded in-flight record on storage queue overflow", () => {
    const h = harness({ manualDrain: true }); h.open();
    for (let n = 0; n < 128; n++) h.send(tick);
    h.transport.drainReceive(); h.send(tick); h.transport.drainReceive();
    expect(h.transport.report()).toMatchObject({ stopReason: "STORAGE_QUEUE_LIMIT",
      pendingStorage: 129, counters: { storageQueuePeakCount: 128 }, accountingMatches: true });
  });
  it("treats JSON/protocol heartbeat separately and never manually protocol-pongs", () => {
    const h = harness(); h.open();
    h.send({ type: "ping" }); h.send({ type: "pong" });
    h.sockets[0].emit({ type: "wsPing" }); h.sockets[0].emit({ type: "wsPong" });
    h.send({ type: "welcome" }); h.sockets[0].emit({ type: "subscribed" });
    expect(h.sockets[0].calls.jsonPong).toBe(1); expect(h.sockets[0].calls.wsPong).toBe(0);
    expect(h.transport.report()).toMatchObject({ subscriptionConfirmed: "UNCONFIRMED",
      counters: { control: 3, heartbeat: 4, parsed: 0 } });
    h.transport.finish();
  });
  it.each(["authRejected", "subscriptionRejected", "protocolError", "error"] as const)("stops on socket refusal/failure %s", type => {
    const h = harness(); h.open();
    h.sockets[0].emit(type === "protocolError" ? { type, reason: "INVALID_UTF8" } : { type });
    expect(h.transport.terminal).toBe(true);
    expect(h.transport.report().counters.persisted).toBe(0);
  });
  it("reconnects once, fences stale callbacks, and never marks a reconnect as continuous", () => {
    const h = harness(); h.open(); const first = h.sockets[0];
    first.emit({ type: "close" }); h.clock.advance(LIMITS.reconnectMs - 1);
    expect(h.sockets).toHaveLength(1); h.clock.advance(1); expect(h.sockets).toHaveLength(2);
    first.emit({ type: "text", bytes: bytes(tick) });
    h.open(); h.send(tick); h.clock.advance(0);
    h.sockets[1].emit({ type: "close" });
    expect(h.transport.report()).toMatchObject({ stopReason: "RECONNECT_LIMIT",
      continuityStatus: "UNKNOWN", counters: { connectionAttempts: 2, reconnectAttempts: 1, accepted: 1 } });
  });
  it.each([
    ["handshake", "HANDSHAKE_TIMEOUT", 10000],
    ["heartbeat", "HEARTBEAT_TIMEOUT", 30000],
  ] as const)("times out %s independently", (kind, reason, ms) => {
    const h = harness(); if (kind === "heartbeat") h.open();
    h.clock.advance(ms);
    expect(h.transport.report().stopReason).toBe(reason); expect(h.clock.scheduled).toBe(0);
  });
  it("enforces the global active deadline through a reconnect wait", () => {
    const h = harness(); h.open();
    h.clock.advance(20000); h.sockets[0].emit({ type: "close" }); h.clock.advance(40000);
    expect(h.transport.report().stopReason).toBe("ACTIVE_TIME_LIMIT");
  });
  it("stops at exactly 1000 received messages and flushes every accepted record", () => {
    const h = harness(); h.open();
    for (let n = 0; n < 1000; n++) { h.send(tick); h.clock.advance(0); }
    expect(h.transport.report()).toMatchObject({
      stopReason: "MESSAGE_LIMIT", counters: { received: 1000, persisted: 1000 }, accountingMatches: true,
    });
  });
  it("stops on parser mismatch without guessing or leaking unknown fields", () => {
    const h = harness(); h.open(); h.send({ ...tick, unknown: "KEY_SENTINEL" }); h.clock.advance(0);
    expect(h.transport.report()).toMatchObject({ stopReason: "PARSER_REJECTED",
      counters: { rejected: 1, persisted: 1, parserFailures: 1 }, accountingMatches: true });
    expect(JSON.stringify(h.transport.report())).not.toContain("KEY_SENTINEL");
  });
  it("stops on timestamp context mismatch without guessing microseconds", () => {
    const h = harness(); h.open(); h.send({ ...tick, ts: 1700000000000000 }); h.clock.advance(0);
    expect(h.transport.report().state).toBe("FAILED");
    expect(h.transport.report().counters.persisted).toBe(0);
  });
  it("rejects simultaneous or wrong-channel market data", () => {
    const h = harness(); h.open(); h.send({ type: "book" });
    expect(h.transport.report()).toMatchObject({ stopReason: "CHANNEL_MISMATCH",
      counters: { unprocessed: 1 }, accountingMatches: true });
  });
  it.each([null, LIMITS.sessionRss + 1])("stops for missing or excessive memory measurement", rss => {
    const h = harness(); h.transport.checkMemory(rss, rss);
    expect(h.transport.report().stopReason).toBe(rss === null ? "MEMORY_NOT_MEASURED" : "MEMORY_THRESHOLD");
  });
  it.each([NaN, Infinity, -1])("does not label invalid memory measurements as MEASURED", rss => {
    const h = harness(); h.transport.checkMemory(rss, rss);
    expect(h.transport.report()).toMatchObject({ stopReason: "MEMORY_NOT_MEASURED", memory: { measurement: "NOT_MEASURED" } });
  });
  it("observes overdue wall budget even if synchronous work delayed all scheduled callbacks", () => {
    let now = 0n;
    const clock = { monoNs: () => now, utcMs: () => 1700000000000, schedule: () => () => {} };
    const socket = new FakeSocket();
    const t = new ObservationTransport(clock, () => socket, { append() { throw Error("MUST_NOT_WRITE"); } }, { channel: "ticks" });
    t.start(); now = 120_000_000_000n;
    socket.emit({ type: "text", bytes: bytes(tick) });
    expect(t.report()).toMatchObject({ stopReason: "WALL_TIME_LIMIT",
      counters: { received: 1, unprocessed: 1, persisted: 0 }, accountingMatches: true });
  });
  it("does not unlock the P2-C2 gate or permit unsafe session options", () => {
    expect(liveConnectionGate({ approved: true }).decision).toBe("BLOCKED");
    expect(() => harness({ finishAfter: 1001 })).toThrow("GATE_A_OPTIONS");
    expect(() => harness({ channel: "both" as "ticks" })).toThrow("GATE_A_OPTIONS");
  });
});
