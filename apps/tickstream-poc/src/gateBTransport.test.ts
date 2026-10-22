import { describe, expect, it } from "vitest";
import { FakeClock } from "./transport";
import { GateBTicks, type BTicksSocket, type BEvent } from "./gateBTransport";
import { LIMITS } from "./gateBConfig";

class Socket implements BTicksSocket {
  listener: (event: BEvent) => void = () => {};
  connects = 0; sends = 0; pongs = 0; closes = 0;
  listen(cb: (event: BEvent) => void) { this.listener = cb; }
  emit(e: BEvent) { this.listener(e); }
  connect() { this.connects++; }
  subscribe() { this.sends++; this.emit({ type: "subscriptionSent" }); }
  jsonPong() { this.pongs++; }
  close() { this.closes++; this.emit({ type: "close" }); }
  terminate() {}
}
const tick = { type: "tick", symbol: "NQ", ts: 1700000000, price: 20000.25, size: 12, side: "buy", exch: "CME" };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function harness(options: { manualDrain?: boolean; finishAfter?: number } = {}) {
  const clock = new FakeClock(), sockets: Socket[] = [];
  const p = new GateBTicks(clock, () => { const s = new Socket(); sockets.push(s); return s; }, "LOOPBACK_TEST", options);
  p.start();
  return { p, clock, sockets, open: () => sockets.at(-1)!.emit({ type: "open" }),
    send: (wire: unknown) => sockets.at(-1)!.emit({ type: "text", bytes: encode(wire) }) };
}
describe("RAM-only ticks states and counters", () => {
  it("separates open/send/unconfirmed/data, preserves identical ticks and has no persistence result", () => {
    const h = harness({ finishAfter: 2 }); h.open();
    expect(h.p.report()).toMatchObject({ phase: "SUBSCRIPTION_UNCONFIRMED", subscription: "SENT_UNCONFIRMED" });
    h.send(tick); h.send(tick); h.clock.advance(0);
    const r = h.p.report();
    expect(r).toMatchObject({ phase: "STOPPED", stopReason: "COMPLETED", persistence: "DISABLED",
      subscription: "DATA_OBSERVED_NO_ACK", authentication: "UNCONFIRMED",
      counters: { validTicks: 2, parserAccepted: 2, equalProviderTimes: 1 }, accountingMatches: true,
      providerTradeId: null, providerSequence: "UNAVAILABLE", continuity: "UNKNOWN" });
    for (const phase of ["CONNECTING", "SOCKET_OPEN", "SUBSCRIBE_SENT", "SUBSCRIPTION_UNCONFIRMED",
      "FIRST_VALID_TICK_RECEIVED", "OBSERVING", "STOPPING", "STOPPED"] as const) expect(r.phaseVisits![phase]).toBeGreaterThan(0);
    expect(r.counters).not.toHaveProperty("persisted");
    expect(h.clock.scheduled).toBe(0);
    expect(JSON.stringify(r)).not.toMatch(/20000|buy|raw|key=/);
  });
  it.each([
    [{ ...tick, extra: "SECRET_SENTINEL" }, "UNSUPPORTED_FIELD"],
    [{ ...tick, size: -1 }, "INVALID_QUANTITY"],
    [{ ...tick, side: "B" }, "INVALID_SIDE"],
    [{ ...tick, price: 20000.1 }, "OFF_TICK_GRID"],
    [{ ...tick, symbol: "ES" }, "INSTRUMENT_CONTEXT_MISMATCH"],
  ])("rejects real-schema incompatibility instead of transforming it", (wire, reason) => {
    const h = harness(); h.open(); h.send(wire); h.clock.advance(0);
    const r = h.p.report();
    expect(r).toMatchObject({ phase: "FAILED", stopReason: "PARSER_REJECTED", schemaCompatibility: "REJECTED",
      counters: { rejected: 1, parserRejected: 1, validTicks: 0 }, accountingMatches: true });
    expect(r.parserReasons![reason as keyof NonNullable<typeof r.parserReasons>]).toBe(1);
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });
  it("distinguishes structural acceptance from timestamp-context refusal, without unit guessing", () => {
    const h = harness(); h.open(); h.send({ ...tick, ts: 1700000000000000 }); h.clock.advance(0);
    expect(h.p.report()).toMatchObject({ stopReason: "TIMESTAMP_CONTEXT_MISMATCH",
      counters: { validTicks: 0, parserAccepted: 1, contextRejected: 1 }, accountingMatches: true });
  });
  it("rejects book rather than subscribing/processing both channels", () => {
    const h = harness(); h.open(); h.send({ type: "book" });
    expect(h.p.report()).toMatchObject({ stopReason: "CHANNEL_MISMATCH", counters: { unprocessed: 1 }, accountingMatches: true });
  });
  it("counts out-of-order provider times without fabricating sequence or dropping trades", () => {
    const h = harness({ finishAfter: 2 }); h.open(); h.send(tick); h.send({ ...tick, ts: tick.ts - 1 }); h.clock.advance(0);
    expect(h.p.report()).toMatchObject({ counters: { validTicks: 2, outOfOrderProviderTimes: 1 }, continuity: "UNKNOWN" });
  });
  it("reports receive overflow explicitly with pending ownership", () => {
    const h = harness({ manualDrain: true }); h.open();
    for (let n = 0; n < 129; n++) h.send(tick);
    expect(h.p.report()).toMatchObject({ stopReason: "QUEUE_COUNT_LIMIT",
      counters: { received: 129, pending: 128, unprocessed: 1, validTicks: 0, queueOverflows: 1 }, accountingMatches: true });
  });
  it("independently enforces byte and single-message caps", () => {
    const h = harness({ manualDrain: true }); h.open();
    for (let n = 0; n < 9; n++) h.send({ ...tick, pad: "x".repeat(LIMITS.messageBytes - 1000) });
    expect(h.p.report().stopReason).toBe("QUEUE_BYTE_LIMIT");
    const a = harness(); a.open();
    a.sockets[0].emit({ type: "text", bytes: new Uint8Array(LIMITS.messageBytes + 1) });
    expect(a.p.report()).toMatchObject({ stopReason: "MESSAGE_TOO_LARGE", counters: { unprocessed: 1 }, accountingMatches: true });
  });
  it.each([
    [{ type: "error", error: { code: "invalid_key" } }, "AUTH_REJECTED"],
    [{ type: "error", error: { code: "plan_required" } }, "ENTITLEMENT_REJECTED"],
    [{ type: "error", error: { code: "unknown_symbol" } }, "SUBSCRIPTION_REJECTED"],
    [{ type: "error", error: { code: "too_many_connections" } }, "CONNECTION_LIMIT"],
    [{ type: "warning", message: "SECRET_SENTINEL" }, "LAG_WARNING"],
    [{ type: "unknown", field: "SECRET_SENTINEL" }, "UNKNOWN_CONTROL"],
  ])("stops on control refusals, never trusts an open socket", (wire, reason) => {
    const h = harness(); h.open(); h.send(wire);
    expect(h.p.report()).toMatchObject({ phase: "FAILED", stopReason: reason, counters: { control: 1 }, accountingMatches: true });
    expect(JSON.stringify(h.p.report())).not.toContain("SENTINEL");
  });
  it("keeps JSON/protocol heartbeat separate; welcome does not confirm subscription", () => {
    const h = harness(); h.open(); h.send({ type: "welcome" }); h.send({ type: "ping" }); h.send({ type: "pong" });
    h.sockets[0].emit({ type: "ping" }); h.sockets[0].emit({ type: "pong" });
    expect(h.sockets[0].pongs).toBe(1);
    expect(h.p.report()).toMatchObject({ subscription: "SENT_UNCONFIRMED", counters: { control: 3, heartbeat: 4 } });
    h.p.finish();
  });
  it.each([["handshake", 10000, "HANDSHAKE_TIMEOUT"], ["heartbeat", 30000, "HEARTBEAT_TIMEOUT"]] as const)(
    "enforces %s timeout", (kind, ms, reason) => {
      const h = harness(); if (kind === "heartbeat") h.open(); h.clock.advance(ms);
      expect(h.p.report().stopReason).toBe(reason); expect(h.clock.scheduled).toBe(0);
    },
  );
  it("fences stale connections and permits one reconnect on the same target after 46 seconds", () => {
    const h = harness(); h.open(); const first = h.sockets[0];
    first.emit({ type: "close" }); h.clock.advance(45999); expect(h.sockets).toHaveLength(1);
    h.clock.advance(1); h.open(); first.emit({ type: "text", bytes: encode(tick) });
    h.send(tick); h.clock.advance(0); h.sockets[1].emit({ type: "close" });
    expect(h.p.report()).toMatchObject({ stopReason: "RECONNECT_LIMIT",
      counters: { reconnectAttempts: 1, connectionAttempts: 2, validTicks: 1 }, continuity: "UNKNOWN" });
  });
  it("preserves 60s total active budget through a reconnect", () => {
    const h = harness(); h.open(); h.clock.advance(20000); h.sockets[0].emit({ type: "close" });
    h.clock.advance(40000); expect(h.p.report().stopReason).toBe("ACTIVE_TIME_LIMIT");
  });
  it("flushes RAM processing at exactly 1000 frames, without storing trades", () => {
    const h = harness(); h.open();
    for (let n = 0; n < 1000; n++) { h.send(tick); h.clock.advance(0); }
    expect(h.p.report()).toMatchObject({ stopReason: "MESSAGE_LIMIT", counters: { validTicks: 1000, pending: 0 }, accountingMatches: true });
  });
  it("enforces aggregate 64MiB independently of message and queue bounds", () => {
    const h = harness(); h.open();
    const base = JSON.stringify(tick), bytes = new TextEncoder().encode(base + " ".repeat(LIMITS.messageBytes - base.length));
    for (let n = 0; n < 65; n++) { h.sockets[0].emit({ type: "text", bytes }); h.clock.advance(0); }
    expect(h.p.report()).toMatchObject({ stopReason: "PAYLOAD_LIMIT",
      counters: { received: 65, validTicks: 64, unprocessed: 1 }, accountingMatches: true });
  });
  it("checks deadlines between synchronous work items even when timers are starved", () => {
    const fake = new FakeClock(), socket = new Socket(); let blockedNs = 0n;
    const p = new GateBTicks({ monoNs: () => fake.monoNs() + blockedNs, utcMs: () => fake.utcMs(),
      schedule: (ms, cb) => fake.schedule(ms, cb) }, () => socket, "LOOPBACK_TEST");
    p.start(); socket.emit({ type: "open" }); blockedNs = 120_001_000_000n;
    socket.emit({ type: "text", bytes: encode(tick) });
    expect(p.report()).toMatchObject({ phase: "FAILED", stopReason: "WALL_TIME_LIMIT",
      counters: { unprocessed: 1, validTicks: 0 }, accountingMatches: true });
  });
  it.each([
    ["dnsFailure", "DNS_FAILURE"], ["tlsFailure", "TLS_FAILURE"],
    ["networkFailure", "NETWORK_FAILURE"], ["handshakeRejected", "HTTP_HANDSHAKE_REJECTED"],
  ] as const)("stops on %s without reconnect/retry or changing endpoint", (type, reason) => {
    const h = harness(); h.sockets[0].emit({ type }); h.clock.advance(120000);
    expect(h.p.report()).toMatchObject({ phase: "FAILED", stopReason: reason, authentication: "NOT_CHECKED",
      counters: { connectionAttempts: 1, reconnectAttempts: 0, validTicks: 0 } });
  });
  it("separates wall including cleanup from the stopped active budget", () => {
    const h = harness(); h.open(); h.clock.advance(5000); h.p.finish(); h.clock.advance(2000);
    expect(h.p.report()).toMatchObject({ elapsedWallMs: 7000, activeBudgetElapsedMs: 5000 });
  });
});
