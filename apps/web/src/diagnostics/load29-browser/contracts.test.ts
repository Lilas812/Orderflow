import { describe, it, expect } from "vitest";
import { definition } from "../load29/generator";
import { canonical as reference } from "../../bench/runAnalysisBenchmark";
import { atomic, BUDGET, canonical, deadlineBudget, orderedStages, validate, viewportSeed } from "./contracts";
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
