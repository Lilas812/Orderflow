import { describe, it, expect } from "vitest";
import { createAnalysisHub } from "@workspace/core/analysis-hub";
import { calculateTimeWeightedDepth } from "@workspace/core/time-weighted-depth";
import { at } from "../../bench/finiteMockWorkload";
import { defaults, generate, sha256, type Definition } from "./generator";
import { replay, validate, processSample } from "./replay-bench";
const small = () => generate({ ...defaults(1), maxEvents: 32, cells: 16 });
describe("load29 real-hub offline replay", () => {
  it("real pipeline completes with six atomic revisions and known counts", () => {
    const r = replay(small());
    expect(r.status).toBe("PASS");
    if (r.status !== "PASS") throw Error(JSON.stringify(r));
    expect(r.counts).toEqual({ inputs: 32, accepted: 32, rejected: 0, duplicate: 0 });
    expect(r.layerRevisions.every(v => v === r.revision)).toBe(true);
    expect(r.history.depthRecords).toBeGreaterThan(0); expect(r.history.trades).toBeGreaterThan(0);
  });
  it("same replay is deterministic despite timing/CPU/heap differences", () => {
    const a = replay(small()), b = replay(small());
    expect(a.status).toBe("PASS"); expect(b.status).toBe("PASS");
    if (a.status !== "PASS" || b.status !== "PASS") throw Error("incomplete");
    expect(a.meaningSha256).toBe(b.meaningSha256); expect(a.inputSha256).toBe(b.inputSha256);
  });
  it("virtual notices remain >=250ms apart, not one publication per input", () => {
    const r = replay(small()); expect(r.status).toBe("PASS");
    if (r.status !== "PASS") throw Error("incomplete");
    expect(r.notices.length).toBeLessThan(32);
    expect(r.timings.ingest.n).toBe(32); expect(r.timings.frameHit.n).toBe(r.reads.length);
    expect(r.frameGenerationCount).toBe(r.reads.length);
    expect(r.frameReadCalls).toBe(r.frameGenerationCount + r.frameCacheHitCalls);
    expect(r.reads.every(x => x.identical)).toBe(true);
    expect(r.notificationModel).toContain("no real-time 4Hz");
    expect(r.ownedTimers).toBe(0); expect(r.gc).toBe("UNKNOWN");
  });
  it("GAP/RESYNCING is unknown; Snapshot recovers L2 without invalidating TRADES", () => {
    const d = generate({ ...defaults(2), maxEvents: 64, cells: 16 }), r = replay(d);
    expect(r.status).toBe("PASS");
    if (r.status !== "PASS") throw Error(JSON.stringify(r));
    expect(r.checks.gapUnknown).toBe(true); expect(r.checks.recovered).toBe(true);
    expect(r.checks.tradeIndependent).toBe(true);
    expect(r.quality.L2_MBP.status).toBe("VALID");
  });
  it("never uses pre-GAP book as a valid held value", () => {
    const d = generate({ ...defaults(2), maxEvents: 64, cells: 16 }), hub = createAnalysisHub(d.scope, () => 0);
    d.inputs.slice(0, 33).forEach(x => hub.ingest(x)); expect(hub.read().book).toBeNull();
    hub.ingest(d.inputs[33]); expect(hub.read().book).toBeNull();
    hub.ingest(d.inputs[34]); expect(hub.read().book).toBeNull();
    hub.ingest(d.inputs[35]); expect(hub.read().book).not.toBeNull();
    const q = calculateTimeWeightedDepth(hub.read().depthHistory!, {
      side: "BID", priceTicks: 99999, width: 1, startNs: at(210), endNs: at(230),
    });
    expect(q.status).toBe("NO DATA"); expect(q.twa).toBeNull();
  });
  it("record or wall budget failure cannot become PASS", () => {
    expect(replay(small(), { records: 0 })).toMatchObject({ status: "FAIL", completedInputs: 0, failure: expect.stringContaining("RECORD_LIMIT") });
    expect(replay(small(), { wallMs: Number.MIN_VALUE })).toMatchObject({ status: "FAIL", completedInputs: 0, failure: expect.stringContaining("WALL_LIMIT") });
  });
  it("preflight refuses foreign input scope, changed SHA and cap inflation", () => {
    const d = JSON.parse(JSON.stringify(small()));
    d.inputs[0].event.header.environment = "LIVE"; d.inputSha256 = sha256(JSON.stringify(d.inputs));
    expect(() => validate(d)).toThrow();
    const a = JSON.parse(JSON.stringify(small())); a.inputSha256 = "0".repeat(64); expect(() => validate(a)).toThrow();
    const b = JSON.parse(JSON.stringify(small())); b.scope.budget.inputs = 4096; expect(() => validate(b)).toThrow("EXISTING_CAP");
  });
  it("real sequence rejection preserves partial FAIL, not successful final hash", () => {
    const d = JSON.parse(JSON.stringify(small())) as Definition;
    const x = d.inputs[3];
    if (x.type !== "EVENT") throw Error("event");
    const bad = JSON.parse(JSON.stringify(d)); bad.inputs[3].event.header.sequence = "1";
    bad.inputSha256 = sha256(JSON.stringify(bad.inputs));
    const r = replay(bad);
    expect(r.status).toBe("FAIL"); expect("meaningSha256" in r).toBe(false);
  });
  it("confirmed exited processes are not assigned fictitious zero RSS", () => {
    const stat = (state: string) => `123 (node) ${[state, ...Array(18).fill("0"), "42"].join(" ")}`;
    expect(processSample(stat("Z"), "")).toEqual({ start: "42", state: "Z", rss: null });
    expect(processSample(stat("R"), "VmRSS: 1024 kB\n").rss).toBe(1048576);
    expect(() => processSample(stat("R"), "")).toThrow("RUNNING_RSS_UNKNOWN");
    expect(() => processSample("bad", "")).toThrow("PROCESS_IDENTITY_UNKNOWN");
  });
});
