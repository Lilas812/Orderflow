import { describe, expect, it } from "vitest";
import { authorizeLiveStorage } from "@workspace/tickstream-storage/live-authorization";
import { B2_ENDPOINT, bindLiveStoragePort, assertLiveStoragePort, LIVE_FLAGS, parseB2Mode, readB2Capture, b2FailureReason } from "./gateB2Config";
import { GateBTicks } from "./gateBTransport";
import { FakeClock } from "./transport";

function fixture() {
  const p = new GateBTicks(new FakeClock(), () => ({ listen: () => {}, connect: () => {}, subscribe: () => {},
    close: () => {}, terminate: () => {}, jsonPong: () => {} }), "LOOPBACK_TEST");
  p.start(); p.finish();
  const { schema: _, persistence: _p, ...transport } = p.report();
  return { schema: "TICKSTREAM_GATE_B2B_CAPTURE_V1", captureMode: "ARTIFICIAL_PROTOCOL_TEST", phase: "STOPPED",
    reason: "COMPLETED", transport, storage: { mode: "AUTHORIZED_LIVE_TRIAL", phase: "STOPPED", reason: "LIVE_FINISHED",
      offered: 0, enqueued: 0, persisted: 0, pending: 0, pendingBytes: 0, unknown: 0, refused: 0, unpersisted: 0,
      peakCount: 0, peakBytes: 0, accountingMatches: true }, commit: { position: 0, bytes: 0, head: "0".repeat(64) } };
}
describe("B-2B explicit entry and fixed reports", () => {
  it("does not weaken the fixed endpoint and requires EVERY exact live flag", () => {
    expect(B2_ENDPOINT).toBe("wss://stream.tick-stream.xyz/v1/stream");
    expect(parseB2Mode([...LIVE_FLAGS])).toBe("LIVE");
    for (let i = 0; i < LIVE_FLAGS.length; i++) expect(parseB2Mode(LIVE_FLAGS.filter((_, n) => n !== i))).toBe("HOLD");
    expect(parseB2Mode([...LIVE_FLAGS, "--url=wss://other"])).toBe("HOLD");
    expect(parseB2Mode([])).toBe("HOLD"); expect(parseB2Mode(["--offline-trial"])).toBe("OFFLINE");
    expect(parseB2Mode(["--purge-trial", "../"])).toBe("HOLD");
  });
  it("binds capabilities to execution context, not a copyable true flag", () => {
    const now = Date.now(), a = authorizeLiveStorage({ explicitMode: "GATE_B2B", dataPermission: true,
      replitStoragePermission: true, manualCleanupConfirmed: true, captureMode: "ARTIFICIAL_PROTOCOL_TEST",
      trialId: "bfb331cf-087e-41f6-9227-21488394112f", directory: "/private/data", issuedAtMs: now, deleteByMs: now + 10000 });
    const p = bindLiveStoragePort({ accept: () => {}, finish: () => {}, abort: () => {}, onFailure: () => {} }, a);
    expect(() => assertLiveStoragePort(p, "LOOPBACK_TEST")).not.toThrow();
    expect(() => assertLiveStoragePort(p, "PRODUCTION")).toThrow("LIVE_AUTH_SCOPE");
    expect(() => assertLiveStoragePort({ ...p }, "LOOPBACK_TEST")).toThrow("LIVE_AUTH_REQUIRED");
  });
  it("reads a complete whitelist and never serializes raw fields or exception text", () => {
    const f = fixture(), result = readB2Capture({ ...f, secret: "ARTIFICIAL_KEY_SENTINEL",
      transport: { ...f.transport, raw: "ARTIFICIAL_PRICE_SENTINEL" } });
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/SENTINEL|secret|raw/);
    expect(b2FailureReason(Error("wss://private?key=ARTIFICIAL_KEY_SENTINEL"), "B2_CHILD_FAILURE")).toBe("B2_CHILD_FAILURE");
  });
  it.each([
    ["offered", 1], ["persisted", 1001], ["pending", 129], ["pendingBytes", 8 * 1024 * 1024 + 1],
    ["unknown", 1], ["peakCount", 129], ["peakBytes", 8 * 1024 * 1024 + 1], ["accountingMatches", false],
    ["reason", "ARBITRARY_ERROR_TEXT"], ["unpersisted", -1], ["enqueued", 0.5],
  ])("rejects inconsistent/unbounded storage %s", (key, value) => {
    const f = fixture(); expect(readB2Capture({ ...f, storage: { ...f.storage, [key]: value } })).toBeNull();
  });
  it("rejects malformed commit evidence and reason codes", () => {
    const f = fixture();
    expect(readB2Capture({ ...f, commit: { ...f.commit, head: "INVALID" } })).toBeNull();
    expect(readB2Capture({ ...f, commit: { ...f.commit, position: 1 } })).toBeNull();
    expect(readB2Capture({ ...f, reason: "ARTIFICIAL_KEY_SENTINEL" })).toBeNull();
    expect(readB2Capture(null)).toBeNull();
  });
});
