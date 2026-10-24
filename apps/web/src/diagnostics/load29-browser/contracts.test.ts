import { describe, it, expect } from "vitest";
import { definition } from "../load29/generator";
import { canonical as reference } from "../../bench/runAnalysisBenchmark";
import { atomic, BUDGET, canonical, deadlineBudget, orderedStages, validate, viewportSeed,
  LAYOUT, layoutGate, deltaDrawingGate } from "./contracts";
import { replay } from "../load29/replay-bench";

describe("browser-only contracts (no browser launch)", () => {
  for (const stage of [0, 1, 2] as const) it(`accepts saved scope caps for stage${stage}`, () => {
    const d = definition(stage); expect(() => validate(d, stage)).not.toThrow();
    const seed = viewportSeed(d);
    expect(BigInt(seed.endNs)).toBeGreaterThan(BigInt(d.query.endNs));
    expect(seed.priceMaxTick).toBeGreaterThan(seed.priceMinTick);
    expect(d.inputs.length).toBe([128, 256, 500][stage]);
  });
  it("does not import the Node encoder into the browser, but encodes identically", () => {
    const x = { z: 9999999999999999999999n, a: new Map([[2, { qty: 0n }], [1, null]]) };
    expect(canonical(x)).toBe(reference(x));
  });
  it("rejects count inflation", () => {
    const d = structuredClone(definition(0)); d.inputs = [...d.inputs, d.inputs[0]];
    expect(() => validate(d, 0)).toThrow("COUNT");
  });
  it("rejects scope cap inflation", () => {
    const d = structuredClone(definition(0));
    Object.assign(d.scope.budget, { inputs: 1024 });
    expect(() => validate(d, 0)).toThrow("CAP");
  });
  it("rejects non-MOCK identity", () => {
    const d = structuredClone(definition(0)); Object.assign(d.scope.config.identity, { environment: "LIVE" });
    expect(() => validate(d, 0)).toThrow("MOCK");
  });
  it("requires atomic part revisions", () => {
    expect(() => atomic({ revision: 1, book: { revision: 2 }, heatmap: {}, bubbles: {}, delta: {},
      volumeProfile: {}, quality: {} } as never)).toThrow("REVISION");
  });
  it("stops after failure and preserves checkpoint", async () => {
    const ran: number[] = [], kept: unknown[] = [];
    const r = await orderedStages(async stage => { ran.push(stage); return { status: "FAIL", reason: "WALL_TIMEOUT" }; },
      async (_, x) => { kept.push(x); });
    expect(ran).toEqual([0]); expect(kept).toEqual(r); expect(r[0].reason).toBe("WALL_TIMEOUT");
  });
  it("does not turn checkpoint failure into a PASS or next stage", async () => {
    const ran: number[] = [], preserved: unknown[] = [];
    await expect(orderedStages(async stage => { ran.push(stage); return { status: "FAIL" }; },
      async (_, r) => { preserved.push(r); throw Error("SAVE_FAILED"); })).rejects.toThrow("SAVE_FAILED");
    expect(ran).toEqual([0]); expect(preserved).toEqual([{ status: "FAIL" }]);
  });
  it("preserves order in the successful stage plan", async () => {
    const ran: number[] = [];
    await orderedStages(async stage => { ran.push(stage); return { status: "PASS" }; }, async () => {});
    expect(ran).toEqual([0, 1, 2]); expect(BUDGET.totalWallMs).toBe(420000);
  });
  it("imports replay library without starting its CLI", () => { expect(typeof replay).toBe("function"); });
  it("enforces both the stage and global wall budgets", () => {
    expect(deadlineBudget(2, 100, 1100)).toBe(1000);
    expect(deadlineBudget(0, 0, 420000)).toBe(70000);
    expect(() => deadlineBudget(2, 100, 100)).toThrow("OVERALL_WALL");
  });
});
const geometry = () => ({ dpr: 1, innerWidth: 852, innerHeight: 760, parentWidth: 765,
  canvases: ["heatmap", "bubble"].map(layer => ({ layer, connected: true,
    cssWidth: 403, cssHeight: 324, width: 403, height: 324, bufferWidth: 403, bufferHeight: 324 })) });
describe("fixed layout without overriding a product Canvas", () => {
  it("reproduces the same available width for all three stages", () => {
    expect(LAYOUT.parentWidth - 2 * LAYOUT.padding - 2 - 72 - 240).toBe(403);
    for (const stage of [0, 1, 2]) { expect(stage).toBeLessThan(3); expect(() => layoutGate(geometry())).not.toThrow(); }
  });
  it("rejects R4's 523 CSSpx even with an otherwise valid buffer", () => {
    const g = geometry(); g.canvases[0].cssWidth = 523;
    expect(() => layoutGate(g)).toThrow("DIMENSION");
  });
  it("rejects DPR and buffer mismatches independently", () => {
    const g = geometry(); g.dpr = 2;
    expect(() => layoutGate(g)).toThrow("ENV");
    g.dpr = 1; g.canvases[1].bufferWidth = 806;
    expect(() => layoutGate(g)).toThrow("DIMENSION");
  });
});
function deltaFixture(delta = 0n) {
  const bin = { id: "b", delta, B: 4n, S: 4n - delta, U: 0n, revision: 6, quality: "VALID" };
  const bar = { bin, x0: 0, x1: 40, top: 53, bottom: 63,
    direction: delta === 0n ? "ZERO" : "UP", opacity: .45 };
  const frame = { bars: [bar], zeroY: 63, height: 126 } as never;
  const draw = { kind: "delta-draw", revision: 7, canvasId: 1, contextId: 2,
    width: 403, height: 126, started: 1, ended: 2,
    binRows: [{ id: "b", delta: delta.toString(), B: "4", S: (4n - delta).toString(), U: "0",
      revision: 6, quality: "VALID", x0: 0, x1: 40, direction: bar.direction }],
    operations: [{ api: "fillRect", style: "#08090d", args: [0, 0, 403, 126] }] as any[] };
  return { draw, frame };
}
describe("Delta data geometry is not a background or axis", () => {
  it("rejects background-only even when the revision and bins look valid", () => {
    const x = deltaFixture();
    expect(() => deltaDrawingGate(x.draw, x.frame, 7)).toThrow("ZERO_DRAW");
  });
  it("accepts a real zero bar stroke and label, not the generic axis", () => {
    const x = deltaFixture();
    x.draw.operations.push({ api: "stroke", style: "#aab0c0", lineWidth: 2, path: [[0, 63], [40, 63]] },
      { api: "fillText", text: "0", args: [2, 59] });
    expect(deltaDrawingGate(x.draw, x.frame, 7).validBins).toBe(1);
    x.draw.operations[1].style = "#6b7390";
    expect(() => deltaDrawingGate(x.draw, x.frame, 7)).toThrow("ZERO_DRAW");
  });
  it("checks nonzero bar quantity, geometry, opacity and sign color", () => {
    const x = deltaFixture(2n);
    x.draw.operations.push({ api: "fillRect", style: "#17c96b", alpha: .45, args: [0, 53, 40, 10] });
    expect(deltaDrawingGate(x.draw, x.frame, 7).validBins).toBe(1);
    x.draw.operations[1].args[3] = 9;
    expect(() => deltaDrawingGate(x.draw, x.frame, 7)).toThrow("DATA_DRAW");
  });
  it("rejects revision mismatch, missing draw and falsified bin values", () => {
    const x = deltaFixture();
    expect(() => deltaDrawingGate(null, x.frame, 7)).toThrow("IDENTITY");
    expect(() => deltaDrawingGate(x.draw, x.frame, 8)).toThrow("REVISION");
    x.draw.binRows[0].delta = "9";
    expect(() => deltaDrawingGate(x.draw, x.frame, 7)).toThrow("INPUT");
  });
});
