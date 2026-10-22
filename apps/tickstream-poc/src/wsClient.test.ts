import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import WebSocket from "ws";
import * as WsPackage from "ws";
import type { ClientRequestArgs } from "node:http";
import { WS_OPTIONS, WIRE_KEYS, WsClient, emptyWireCounters, loopbackUrl, protocolReason } from "./wsClient";
import { FakeClock, LIMITS } from "./transport";
import { syntheticSession } from "./session";
import { localReport, readLocalReport, unavailableLocalReport } from "./localWsSession";

describe("loopback-only endpoint policy, before constructor/DNS", () => {
  it.each([
    ["ws://127.0.0.1:12345/", "ws://127.0.0.1:12345/"],
    ["ws://localhost:12345/", "ws://127.0.0.1:12345/"],
    ["ws://[::1]:12345/", "ws://[::1]:12345/"],
    ["wss://127.0.0.1:12345/", "wss://127.0.0.1:12345/"],
  ])("accepts literal loopback %s", (input, expected) => expect(loopbackUrl(input)).toBe(expected));
  it.each([
    "ws://tick-stream.xyz:443/v1/stream", "wss://stream.tick-stream.xyz/v1/",
    "wss://api.tick-stream.xyz:443/", "ws://example.com:12345/",
    "ws://0.0.0.0:12345/", "ws://192.168.1.1:12345/", "ws://[::]:12345/",
    "ws://[::ffff:127.0.0.1]:12345/", "ws://127.0.0.1.example.com:12345/",
    "ws://localhost.example.com:12345/", "ws://localhost:12345/?key=SECRET_SENTINEL",
    "ws://SECRET_SENTINEL@127.0.0.1:12345/", "ws://127.0.0.1:12345/#SECRET_SENTINEL",
    "http://127.0.0.1:12345/", "ws+unix:///tmp/SECRET_SENTINEL",
    "ws://localhost/", "SECRET_SENTINEL",
  ])("refuses a forbidden endpoint with only a static exception", input => {
    expect(() => new WsClient(input, new FakeClock(), () => ({ count: 0, bytes: 0 })))
      .toThrow(/^LOOPBACK_ENDPOINT_REQUIRED$/);
  });
});

describe("fixed ws version and public options", () => {
  it("uses exactly the approved version and bounds, with no unsafe defaults", () => {
    const require = createRequire(import.meta.url);
    expect(require("ws/package.json").version).toBe("8.22.0");
    const options: Omit<WebSocket.ClientOptions, "agent"> & Pick<ClientRequestArgs, "agent"> = WS_OPTIONS;
    expect(options).toMatchObject({
      maxPayload: 1024 * 1024, maxFragments: 1024, maxBufferedChunks: 1024,
      handshakeTimeout: 10_000, followRedirects: false, perMessageDeflate: false,
      skipUTF8Validation: false, autoPong: true, agent: false, rejectUnauthorized: true,
    });
  });
  it.each([
    ["WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", "PAYLOAD_TOO_LARGE"],
    ["WS_ERR_TOO_MANY_BUFFERED_PARTS", "FRAGMENT_LIMIT"],
    ["WS_ERR_INVALID_UTF8", "INVALID_UTF8"],
    ["WS_ERR_INVALID_OPCODE", "FRAGMENT_PROTOCOL"],
    ["ECONNRESET", null], [undefined, null],
  ])("classifies static wire error %s, not its message", (code, reason) => {
    expect(protocolReason({ code, message: "SECRET_SENTINEL", stack: "RAW_SENTINEL" })).toBe(reason);
  });
});

// Test-only white-box verification of the pinned package's exposed Receiver.
// No private/deep package import, no production Receiver dependency, no patching.
const Receiver = (WsPackage as unknown as {
  Receiver: new(options: Pick<WebSocket.ClientOptions, "maxPayload" | "maxFragments" | "maxBufferedChunks" |
    "skipUTF8Validation" | "allowSynchronousEvents">) => Writable;
}).Receiver;
async function receiverError(chunks: Buffer[]): Promise<{ code: string; delivered: number }> {
  const receiver = new Receiver(WS_OPTIONS);
  let delivered = 0;
  receiver.on("message", () => delivered++);
  const error = new Promise<{ code: string; delivered: number }>(resolve => {
    receiver.once("error", (value: { code: string }) => resolve({ code: value.code, delivered }));
  });
  for (const chunk of chunks) receiver.write(chunk);
  try { return await error; } finally { receiver.destroy(); }
}
describe("actual ws 8.22.0 receiver limits, before message materialization", () => {
  it("rejects a >1 MiB header without receiving or allocating its body", async () => {
    const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(LIMITS.messageBytes + 1), 2);
    expect(await receiverError([header])).toEqual({ code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", delivered: 0 });
  });
  it("rejects the 1025th zero-byte fragment", async () => {
    const frames = [Buffer.from([0x01, 0])];
    for (let i = 0; i < 1024; i++) frames.push(Buffer.from([0, 0]));
    expect(await receiverError(frames)).toEqual({ code: "WS_ERR_TOO_MANY_BUFFERED_PARTS", delivered: 0 });
  });
  it("allows exactly 1024 fragments, including empty continuations", async () => {
    const receiver = new Receiver(WS_OPTIONS);
    const message = new Promise<Buffer>(resolve => receiver.once("message", resolve));
    receiver.write(Buffer.from([0x01, 1, 0x78]));
    for (let i = 0; i < 1022; i++) receiver.write(Buffer.from([0, 0]));
    receiver.write(Buffer.from([0x80, 0]));
    try { expect((await message).toString()).toBe("x"); } finally { receiver.destroy(); }
  });
  it("independently rejects the 1025th buffered TCP chunk within one small frame", async () => {
    const chunks = [Buffer.from([0x81, 126, 0x08, 0x00])]; // 2048-byte payload, no fragmentation.
    for (let i = 0; i < 1025; i++) chunks.push(Buffer.from("x"));
    expect(await receiverError(chunks)).toEqual({ code: "WS_ERR_TOO_MANY_BUFFERED_PARTS", delivered: 0 });
  });
  it("rejects invalid UTF-8 before delivering a text message", async () => {
    expect(await receiverError([Buffer.from([0x81, 2, 0xc3, 0x28])]))
      .toEqual({ code: "WS_ERR_INVALID_UTF8", delivered: 0 });
  });
  it("assembles a UTF-8 codepoint split across valid fragments", async () => {
    const receiver = new Receiver(WS_OPTIONS);
    const message = new Promise<Buffer>(resolve => receiver.once("message", resolve));
    receiver.write(Buffer.from([0x01, 1, 0xc3]));
    receiver.write(Buffer.from([0x80, 1, 0xa9]));
    try { expect((await message).toString("utf8")).toBe("é"); } finally { receiver.destroy(); }
  });
});

describe("local report uses unchanged P2-B counters without false network claims", () => {
  it("projects numeric counters only and keeps subscription confirmation unknown", () => {
    const wire = emptyWireCounters(); wire.opens = 1; wire.subscriptionSent = 1;
    const report = localReport(syntheticSession(), wire);
    expect(report).toMatchObject({
      schema: "ORDERFLOW_LOCAL_WEBSOCKET_V1", source: "SYNTHETIC_TEST", network: "LOOPBACK_ONLY",
      persistence: "DISABLED", marketMissingEvents: "NOT_MEASURABLE",
      providerSequence: "UNAVAILABLE", contract: null,
      evidence: { connectionOpen: "OBSERVED", subscriptionSend: "OBSERVED",
        subscriptionConfirmed: "UNCONFIRMED", firstSyntheticTrade: "OBSERVED" },
    });
    expect(Object.keys(report.wire!)).toEqual([...WIRE_KEYS]);
  });
  it("strips raw, endpoint, reason, stack, and hostile nested report fields", () => {
    const clean = localReport(syntheticSession(), emptyWireCounters());
    const dirty = { ...clean, raw: "RAW_SENTINEL", url: "SECRET_SENTINEL", stack: "STACK_SENTINEL",
      evidence: { subscriptionConfirmed: "SECRET_SENTINEL" },
      wire: { ...clean.wire, RAW_SENTINEL: 1 },
      counters: { ...clean.counters, SECRET_SENTINEL: 1,
        reasonCounts: { ...clean.counters!.reasonCounts, STACK_SENTINEL: 1 } } };
    expect(readLocalReport(dirty)).toEqual(clean);
    expect(JSON.stringify(readLocalReport(dirty))).not.toMatch(/SENTINEL/);
  });
  it.each([
    { network: "EXTERNAL" }, { schema: "BAD" }, { source: "LIVE" },
    { wire: { opens: -1 } }, { wire: "SECRET_SENTINEL" }, { state: "SECRET_SENTINEL" },
  ])("rejects invalid report values", change => {
    expect(readLocalReport({ ...localReport(syntheticSession(), emptyWireCounters()), ...change })).toBeNull();
  });
  it("does not fabricate zero counters after a forced/unavailable outcome", () => {
    const report = unavailableLocalReport("FORCED_TERMINATION");
    expect(report.counters).toBeNull(); expect(report.wire).toBeNull();
    expect(report.evidence.firstSyntheticTrade).toBe("NOT_MEASURED");
    expect(report.memory.measurement).toBe("NOT_MEASURED");
    expect(readLocalReport(report)).toEqual(report);
  });
});
