import { describe, expect, it, vi } from "vitest";
import { GATE_B_REVIEW, reviewGateB, emptyGateBReport, readGateBReport, type GateBReview } from "./gateBConfig";
import { executeGateB } from "./gateBProcess";
import { liveConnectionGate } from "./liveConfig";

const syntheticReview: GateBReview = {
  endpoint: "wss://stream.tick-stream.xyz/v1/stream", authority: "PROVIDER_REPLY",
  evidenceReference: "SYNTHETIC_UNIT_TEST_CONFIRMATION_ONLY", replitRamReceivePermissionConfirmed: true,
};
describe("new explicit Gate B path; old gate unchanged", () => {
  it("keeps the unresolved production review HOLD and old BLOCKED intact", () => {
    expect(reviewGateB(GATE_B_REVIEW, true)).toEqual(["ENDPOINT_UNCONFIRMED", "REPLIT_PERMISSION_UNCONFIRMED"]);
    expect(Object.isFrozen(GATE_B_REVIEW)).toBe(true);
    expect(liveConnectionGate({ executeGateB: true }).decision).toBe("BLOCKED");
  });
  it.each([
    "ws://stream.tick-stream.xyz/v1/stream", "wss://stream.tick-stream.xyz/v1/stream/",
    "wss://stream.tick-stream.xyz:443/v1/stream", "wss://external.invalid/v1/stream",
    "wss://SENTINEL@stream.tick-stream.xyz/v1/stream", "wss://stream.tick-stream.xyz/v1/stream?key=SENTINEL",
  ])("rejects unsafe or unconfirmed endpoint variants without probing", endpoint => {
    expect(reviewGateB({ ...syntheticReview, endpoint } as GateBReview, true)).toContain("ENDPOINT_UNCONFIRMED");
  });
  it.each(["wss://stream.tick-stream.xyz/v1", "wss://stream.tick-stream.xyz/v1/stream"] as const)(
    "can model a separately confirmed single endpoint, never a fallback list", endpoint => {
      expect(reviewGateB({ ...syntheticReview, endpoint }, true)).toEqual([]);
    },
  );
  it("does not inspect even artificial keys or launch a worker while any review condition is missing", async () => {
    const readKey = vi.fn(() => { throw Error("SECRET_SENTINEL"); }), startWorker = vi.fn();
    const r = await executeGateB({ review: GATE_B_REVIEW, explicitExecution: true, readKey, startWorker });
    expect(r).toMatchObject({ phase: "NOT_RUNNING", counters: null, authentication: "NOT_CHECKED" });
    expect(readKey).not.toHaveBeenCalled(); expect(startWorker).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });
  it("requires the explicit operation even for a synthetic confirmed review", async () => {
    const readKey = vi.fn(), startWorker = vi.fn();
    const r = await executeGateB({ review: syntheticReview, explicitExecution: false, readKey, startWorker });
    expect(r.holdReasons).toEqual(["EXECUTION_NOT_APPROVED"]); expect(readKey).not.toHaveBeenCalled();
  });
  it.each([undefined, null, "", 1, {}, "x".repeat(4097)])("fails closed for artificial missing/invalid credentials", async value => {
    const startWorker = vi.fn();
    const r = await executeGateB({ review: syntheticReview, explicitExecution: true, readKey: () => value, startWorker });
    expect(r.holdReasons).toEqual(["KEY_NOT_CONFIGURED"]); expect(startWorker).not.toHaveBeenCalled();
  });
  it("keeps artificial credentials confined to the worker boundary and sanitizes its result", async () => {
    const workerReport = { ...emptyGateBReport("COMPLETED"), raw: "RAW_SENTINEL", key: "SECRET_SENTINEL" };
    const r = await executeGateB({ review: syntheticReview, explicitExecution: true,
      readKey: () => "SECRET_SENTINEL", startWorker: async key => {
        expect(key).toBe("SECRET_SENTINEL"); return workerReport;
      } });
    expect(JSON.stringify(r)).not.toMatch(/SENTINEL|raw|key=/);
  });
  it("contains credential-reader and worker exceptions without raw errors", async () => {
    const a = await executeGateB({ review: syntheticReview, explicitExecution: true,
      readKey: () => { throw Error("KEY_URL_SENTINEL"); }, startWorker: vi.fn() });
    expect(a.holdReasons).toEqual(["KEY_NOT_CONFIGURED"]);
    const b = await executeGateB({ review: syntheticReview, explicitExecution: true, readKey: () => "ARTIFICIAL",
      startWorker: async () => { throw Error("KEY_URL_SENTINEL"); } });
    expect(b.stopReason).toBe("CHILD_FAILURE"); expect(JSON.stringify([a, b])).not.toContain("SENTINEL");
  });
  it("whitelists nested reports and rejects unsafe free text/nonfinite counters", () => {
    expect(readGateBReport({ ...emptyGateBReport(), URL: "SECRET_SENTINEL", raw: "RAW_SENTINEL" }))
      .toEqual(emptyGateBReport());
    expect(readGateBReport({ ...emptyGateBReport(), stopReason: "SECRET_SENTINEL" })).toBeNull();
    expect(readGateBReport({ ...emptyGateBReport(), memory: { measurement: "MEASURED", childRssPeak: Infinity, totalRssPeak: 1 } })).toBeNull();
    expect(readGateBReport({ ...emptyGateBReport(), counters: { received: "SECRET_SENTINEL" } })).toBeNull();
  });
});
