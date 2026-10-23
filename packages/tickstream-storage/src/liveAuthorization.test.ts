import { describe, expect, it } from "vitest";
import { authorizeLiveStorage, assertLiveAuthorization, MAX_RETENTION_MS } from "./liveAuthorization";

const now = 1700000000000;
const input = { explicitMode: "GATE_B2B" as const, dataPermission: true, replitStoragePermission: true,
  manualCleanupConfirmed: true, captureMode: "ARTIFICIAL_PROTOCOL_TEST" as const,
  trialId: "bfb331cf-087e-41f6-9227-21488394112f", directory: "/private/trial/data",
  issuedAtMs: now, deleteByMs: now + MAX_RETENTION_MS };
describe("B-2B explicit process-local authorization", () => {
  it("issues an immutable finite capability; disk/JSON metadata cannot recreate it implicitly", () => {
    const a = authorizeLiveStorage(input, now);
    expect(Object.isFrozen(a)).toBe(true); expect(() => assertLiveAuthorization(a, now)).not.toThrow();
    expect(() => assertLiveAuthorization(JSON.parse(JSON.stringify(a)), now)).toThrow("LIVE_AUTH_REQUIRED");
    expect(() => assertLiveAuthorization({ ...a }, now)).toThrow("LIVE_AUTH_REQUIRED");
  });
  it.each([
    ["explicitMode", "RAM_ONLY"], ["dataPermission", false], ["replitStoragePermission", false], ["manualCleanupConfirmed", false],
    ["captureMode", "SIMULATED"], ["trialId", "../other"], ["directory", "relative"], ["directory", "/private/\0"],
    ["issuedAtMs", now + 1], ["issuedAtMs", -1], ["deleteByMs", now + MAX_RETENTION_MS + 1],
    ["deleteByMs", now], ["deleteByMs", NaN],
  ])("refuses invalid %s before anything can connect/write", (key, value) => {
    expect(() => authorizeLiveStorage({ ...input, [key]: value } as any, now)).toThrow(/LIVE_AUTH_/);
  });
  it("rejects at the exact deadline and does not extend on restart", () => {
    const a = authorizeLiveStorage(input, now);
    expect(() => assertLiveAuthorization(a, input.deleteByMs - 1)).not.toThrow();
    expect(() => assertLiveAuthorization(a, input.deleteByMs)).toThrow("LIVE_AUTH_EXPIRED");
    expect(() => authorizeLiveStorage(input, input.deleteByMs)).toThrow("LIVE_AUTH_EXPIRED");
    expect(() => assertLiveAuthorization(a, now - 1)).toThrow("LIVE_AUTH_SCOPE");
  });
});
