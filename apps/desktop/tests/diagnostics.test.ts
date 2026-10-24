import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inputGate, verifyFrames, recheckSavedDraw } from "../diagnostics/verify";
const contractPath = "../diagnostics/contracts.mjs", runPath = "../diagnostics/run.mjs";
const { writer, geometryGate, stats, LIMITS, exitCode, signalTarget } = await import(contractPath);
const { environment, main } = await import(runPath);
const definition = () => JSON.parse(fs.readFileSync("../../.local/diagnostics/task29-a/stage0-input.json", "utf8"));
it("checks frozen input bytes and rejects reordered inputs", () => {
  const d = definition();
  expect(() => inputGate(d, 0, { inputSha256: d.inputSha256 })).not.toThrow();
  [d.inputs[0], d.inputs[1]] = [d.inputs[1], d.inputs[0]];
  expect(() => inputGate(d, 0, { inputSha256: d.inputSha256 })).toThrow("INPUT_SHA");
});
it("rejects missing prefixes and tampered same-prefix semantic frames", () => {
  const d = definition();
  expect(() => verifyFrames(d, {}, [], { rows: [] }, 647)).toThrow("FINAL_PREFIX");
  expect(() => verifyFrames(d, {}, [{ kind: "frame", prefix: 1, revision: 1, canonical: "tampered" }],
    { rows: [] }, 647)).toThrow("SAME_PREFIX_SAME_QUERY");
});
it("reclassifies only an exact old empty placeholder, without mutating the old evidence", () => {
  const original = { binRows: [{ id: "empty", revision: null, x0: null, x1: null }] };
  expect(recheckSavedDraw(original).binRows).toEqual([]);
  expect(original.binRows).toHaveLength(1);
  expect(() => recheckSavedDraw({ binRows: [{ ...original.binRows[0], delta: "0" }] })).toThrow("SAVED_PLACEHOLDER_FORGED");
});
it("imports the native runner without running a browser and requires an explicit CLI opt-in", async () => {
  await expect(main([])).rejects.toThrow("EXPLICIT_RUN_REQUIRED");
});
it("does not forward project Secrets or Node preload options", () => {
  const e = environment("/artificial/libraries");
  expect(e.DISPLAY).toBe(":0");
  expect(e.TICKSTREAM_API_KEY).toBeUndefined();
  expect(e.SESSION_SECRET).toBeUndefined();
  expect(e.NODE_OPTIONS).toBeUndefined();
  expect(e.ELECTRON_RUN_AS_NODE).toBeUndefined();
});
it("enforces the original finite stage and resource budgets", () => {
  expect(LIMITS.wall).toEqual([70000, 120000, 210000]);
  expect(LIMITS.total).toBe(420000); expect(LIMITS.rss).toBe(2 * 1024 ** 3);
  expect(LIMITS.processes).toBe(24);
  expect(LIMITS.file).toBe(8 * 1024 ** 2); expect(LIMITS.totalBytes).toBe(32 * 1024 ** 2);
});
const geo = () => ({ dpr: 1, innerWidth: 1024, innerHeight: 720,
  canvases: ["heatmap", "bubble"].map(layer => ({ layer, connected: true,
    cssWidth: 647, cssHeight: 324, width: 647, height: 324, bufferWidth: 647, bufferHeight: 324 })) });
const expected = { dpr: 1, innerWidth: 1024, innerHeight: 720, width: 647, height: 324 };
it("uses native predeclared geometry, not the old 403px browser constant", () => {
  expect(() => geometryGate(geo(), expected)).not.toThrow();
  expect(() => geometryGate(geo(), { ...expected, width: 403 })).toThrow();
});
it("rejects missing canvas, native resize during a stage, DPR, attributes or buffer mismatch", () => {
  for (const change of [(g: any) => g.canvases.pop(), (g: any) => g.dpr = 2,
    (g: any) => g.innerWidth++, (g: any) => g.canvases[0].width++, (g: any) => g.canvases[1].bufferWidth++]) {
    const g = geo(); change(g); expect(() => geometryGate(g, expected)).toThrow();
  }
});
it("never reports incomplete stages or cleanup faults as PASS", () => {
  expect(exitCode({ status: "PASS", stages: [] })).toBe(1);
  const stages = [0, 1, 2].map(stage => ({ stage, status: "PASS", cleanup: { remaining: 0 } }));
  expect(exitCode({ status: "PASS", stages })).toBe(0);
  stages[1].cleanup.remaining = 1;
  expect(exitCode({ status: "PASS", stages })).toBe(1);
});
it("distinguishes measured statistics from UNKNOWN and retains maxima", () => {
  expect(stats([]).status).toBe("UNKNOWN");
  expect(stats([1, 2, 20.1]).max).toBe(20.1);
  expect(stats([1, 2]).median).toBe(1.5);
  expect(() => stats([NaN])).toThrow();
});
it("publishes evidence exclusively, validates paths, and refuses oversized evidence", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "orderflow-a2-evidence-")); fs.chmodSync(temp, 0o700);
  try {
    const save = writer(temp);
    const receipt = save("checkpoint.json", { status: "FAIL", prefix: 2 });
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => save("checkpoint.json", {})).toThrow("OUTPUT_EXISTS");
    expect(() => save("../escape.json", {})).toThrow("OUTPUT_FILENAME");
    expect(() => save("big.json", { data: "x".repeat(LIMITS.file) })).toThrow("CAP");
    expect(fs.readdirSync(temp)).toEqual(["checkpoint.json"]);
    fs.chmodSync(temp, 0o755);
    expect(() => save("bad-permissions.json", {})).toThrow("OUTPUT_CHANGED");
  } finally { fs.rmSync(temp, { recursive: true }); }
});
const leader = { pid: 7001, pgid: 7001, sid: 7001, uid: 1000, startTicks: "42", state: "S" };
it("authorizes only the currently held identical live leader", () => {
  expect(signalTarget(leader, { ...leader }, true)).toBe(7001);
  expect(() => signalTarget(leader, leader, false)).toThrow();
  expect(() => signalTarget(leader, { ...leader, state: "Z" }, true)).toThrow();
});
for (const field of ["pid", "pgid", "sid", "uid", "startTicks"]) it(`refuses a stale or foreign ${field}`, () => {
  expect(() => signalTarget(leader, { ...leader, [field]: "changed" }, true)).toThrow("SIGNAL_OWNER");
});
it("keeps the real host/preload and sandbox, a production-built shared renderer, and no SIGKILL", () => {
  const native = fs.readFileSync("diagnostics/native.cjs", "utf8");
  expect(native).toContain('require("../dist/main/main.js")');
  expect(native).toContain("original(request, build)");
  const run = fs.readFileSync("diagnostics/run.mjs", "utf8");
  expect(run).not.toContain('kill("SIGKILL")');
  expect(run).not.toContain('"--no-sandbox"');
  expect(run).toContain('status !== "PASS"');
});
