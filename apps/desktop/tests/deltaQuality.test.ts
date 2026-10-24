import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createAnalysisHub } from "@workspace/core/analysis-hub";
import { createViewport } from "@workspace/core/viewport";
import { projectDeltaTimeline } from "@workspace/core/delta-timeline";
import { canonical, deltaDrawingGate, deltaLayoutGate, stageDeltaGate, STAGE_DELTA_CONTRACTS,
  inputGate, verifyFrames } from "../diagnostics/verify";
import { viewportSeed } from "../../web/src/diagnostics/load29-browser/contracts";

function drawOf(frame: any, revision = 7, viewport: any = { dpr: 1 }, width = 647) {
  const operations: any[] = [{ api: "fillRect", style: "#08090d", args: [0, 0, width, 126] }];
  const binRows = frame.bars.map((b: any) => {
    const bin = b.bin, w = Math.max(0, b.x1 - b.x0);
    if (["UP", "DOWN"].includes(b.direction)) operations.push({ api: "fillRect",
      style: b.direction === "UP" ? "#17c96b" : "#b548db", alpha: b.opacity,
      args: [b.x0, Math.min(b.top, b.bottom), w, Math.max(1, Math.abs(b.bottom - b.top))] });
    else if (b.direction === "ZERO") operations.push(
      { api: "stroke", style: "#aab0c0", lineWidth: 2, path: [[b.x0, frame.zeroY], [b.x1, frame.zeroY]] },
      { api: "fillText", style: "#aab0c0", text: "0", args: [b.x0 + 2, frame.zeroY - 4] });
    else operations.push({ api: "fillRect", style: "rgba(213, 167, 75, 0.08)", args: [b.x0, 0, w, 126] });
    return { id: bin.id, delta: bin.delta === null ? "" : bin.delta.toString(),
      B: bin.B.toString(), S: bin.S.toString(), U: bin.U.toString(), revision: bin.revision,
      quality: bin.quality, x0: b.x0, x1: b.x1, direction: b.direction };
  });
  return { kind: "delta-draw", revision, canvasId: 1, contextId: 2, width, height: 126,
    started: 1, ended: 2, viewport, operations, binRows,
    placeholders: binRows.length ? [] : [{ text: "NO DATA: no Delta bin", hasBinFields: false }] };
}
function fixture(direction = "ZERO", unknown = 0n) {
  const withheld = ["NO DATA", "INCOMPLETE"].includes(direction);
  const delta = withheld ? null : direction === "UP" ? 2n : direction === "DOWN" ? -2n : 0n;
  const bin = { id: "artificial-bin", B: 4n, S: delta === null ? 4n : 4n - delta, U: unknown,
    delta, revision: 3, quality: withheld ? direction : "VALID" };
  const frame = { bars: [{ bin, x0: 10, x1: 50, top: withheld ? null : 53,
    bottom: withheld ? null : 63, direction, opacity: .45 }], zeroY: 63, height: 126 };
  return { frame, draw: drawOf(frame) };
}
describe("strict numeric / withheld / placeholder Canvas gate", () => {
  for (const direction of ["UP", "DOWN", "ZERO", "INCOMPLETE", "NO DATA"]) it(`accepts exact ${direction} observation`, () => {
    const x = fixture(direction);
    const r = deltaDrawingGate(x.draw, x.frame, 7, 647);
    expect(r.validBins).toBe(["UP", "DOWN", "ZERO"].includes(direction) ? 1 : 0);
  });
  for (const unknown of [0n, 57n]) it(`UNKNOWN quantity ${unknown} cannot become known-zero`, () => {
    const x = fixture("INCOMPLETE", unknown);
    expect(deltaDrawingGate(x.draw, x.frame, 7, 647).withheldBins).toBe(1);
    x.draw.binRows[0].delta = "0";
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow("INPUT_MISMATCH");
  });
  it("empty placeholder is not a withheld real bin", () => {
    const frame = { bars: [], zeroY: 63, height: 126 }, draw = drawOf(frame);
    expect(deltaDrawingGate(draw, frame, 7, 647).empty).toBe(true);
    const x = fixture("NO DATA"); x.draw.placeholders = draw.placeholders;
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow("PLACEHOLDER");
  });
  for (const forged of ["0", "19"]) it(`rejects Stage1's forged numerical Delta ${forged}`, () => {
    const x = fixture("NO DATA", 57n); x.draw.binRows[0].delta = forged;
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow("INPUT_MISMATCH");
    const b = { ...STAGE_DELTA_CONTRACTS[1].final, delta: BigInt(forged) };
    expect(() => stageDeltaGate(1, [b], new Set(["NO DATA"]), [])).toThrow("DELTA_STAGE_FINAL:delta");
  });
  for (const extra of [
    { api: "fillRect", style: "#17c96b", alpha: 1, args: [10, 53, 40, 10] },
    { api: "stroke", style: "#aab0c0", lineWidth: 2, path: [[10, 63], [50, 63]] },
    { api: "fillText", style: "#aab0c0", text: "0", args: [12, 59] },
  ]) it(`rejects extra fabricated ${extra.api} over withheld data`, () => {
    const x = fixture("NO DATA", 57n); x.draw.operations.push(extra);
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow("EXTRA_NUMERIC_BAR");
  });
  it("does not allow a fabricated bar with a different paint color", () => {
    const x = fixture("NO DATA");
    x.draw.operations.push({ api: "fillRect", style: "#123456", args: [10, 40, 40, 20] });
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow("UNEXPECTED_FILL");
  });
  for (const change of ["missing", "extra", "duplicate"]) it(`rejects ${change} bins`, () => {
    const x = fixture("ZERO");
    if (change === "missing") x.draw.binRows = [];
    else x.draw.binRows.push({ ...x.draw.binRows[0], id: change === "extra" ? "extra" : "artificial-bin" });
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow("BIN_COUNT");
  });
  it("rejects duplicated IDs even when counts match", () => {
    const x = fixture(); x.frame.bars.push({ ...x.frame.bars[0], bin: { ...x.frame.bars[0].bin, id: "second" } });
    x.draw = drawOf(x.frame); x.draw.binRows[1].id = x.draw.binRows[0].id;
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow("ROW_INVALID");
  });
  for (const key of ["B", "S", "U", "quality", "revision", "x0", "x1", "direction"]) it(`rejects changed ${key}`, () => {
    const x = fixture(); (x.draw.binRows[0] as any)[key] = key === "revision" ? 7 : key.startsWith("x") ? 999 : "wrong";
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow();
  });
  it("global and correction revisions are separate", () => {
    const x = fixture();
    expect(() => deltaDrawingGate(x.draw, x.frame, 3, 647)).toThrow("IDENTITY_OR_REVISION");
    x.draw.binRows[0].revision = 7;
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow("INPUT_MISMATCH");
  });
  it("requires an actual withheld fill, not just valid DOM quantities", () => {
    const x = fixture("NO DATA"); x.draw.operations.pop();
    expect(() => deltaDrawingGate(x.draw, x.frame, 7, 647)).toThrow("WITHHELD_DRAW_MISSING");
  });
  it("rejects a changed formal layout generation", () => {
    const draw: any = { ...fixture().draw, started: 11, ended: 12, viewport: { dpr: 1, bounds: { width: 647 } },
      layout: { generation: 5, at: 11.5, dpr: 1, cssWidth: 647, cssHeight: 126, phase: "formal" } };
    const interval = { start: { at: 10, generation: 4, snapshot: { geometry: { dpr: 1 } } }, end: 13 };
    expect(() => deltaLayoutGate(draw, interval, 647)).toThrow("FORMAL_DELTA_LAYOUT_CHANGED");
  });
});

const definitions = [0, 1, 2].map(stage =>
  JSON.parse(fs.readFileSync(`../../.local/diagnostics/task29-a/stage${stage}-input.json`, "utf8")));
const references = JSON.parse(fs.readFileSync("../../.local/diagnostics/task29-a/independent-audit.json", "utf8")).summaries;
function offlineReplay(stage: number) {
  const d = definitions[stage], hub = createAnalysisHub(d.scope, () => 0), records: any[] = [], draws: any[] = [];
  const seed = viewportSeed(d), base = createViewport({ bounds: { left: 0, top: 0, width: 647, height: 324 },
    latestNs: seed.endNs, dpr: 1, price: { minTick: seed.priceMinTick, maxTick: seed.priceMaxTick } });
  // Same explicit finite verification domain as ChartShell.verificationViewport;
  // do not pass its sub-minute MOCK range as the ordinary LIVE initialSpanNs.
  const vp = { ...base, time: { minNs: (BigInt(seed.endNs) - seed.spanNs).toString(), maxNs: seed.endNs } };
  let final: any;
  d.inputs.forEach((input: any, i: number) => {
    expect(hub.ingest(input).disposition).toBe("ACCEPTED");
    // Few finite semantic checkpoints, no pacing, browser, child or performance measurement.
    if (i === 2 || i === d.inputs.length - 1 || input.type === "CONDITION") {
      final = hub.readRenderFrame(d.query);
      const probe = input.type === "CONDITION";
      records.push({ kind: probe ? "probe" : "frame", prefix: i + 1, revision: final.revision, canonical: canonical(final) });
      if (!probe) draws.push(drawOf(projectDeltaTimeline(final.delta.items, vp, 126), final.revision, vp));
    }
  });
  return { d, records, draws, final };
}
describe("frozen Stage contracts (offline semantic verification, not an Electron Stage)", () => {
  for (const stage of [0, 1, 2]) it(`keeps Stage ${stage} reference SHA and accepts exact observed-bin contracts`, () => {
    const x = offlineReplay(stage);
    inputGate(x.d, stage, references[stage]);
    expect(createHash("sha256").update(canonical(x.final)).digest("hex")).toBe(references[stage].publicFrameSha256);
    const result = verifyFrames(x.d, references[stage], x.records, { rows: x.draws }, 647);
    expect(result.status).toBe("PASS"); expect(result.qualityContract.stage).toBe(stage);
    if (stage === 1) {
      const bin = x.final.delta.items[0];
      expect(bin.B).toBe(83n); expect(bin.S).toBe(64n); expect(bin.U).toBe(57n);
      expect(bin.delta).toBeNull(); expect(bin.V).toBeNull(); expect(bin.quality).toBe("NO DATA");
      expect(result.delta.some(d => d.withheldBins > 0 && !d.empty)).toBe(true);
    }
    if (stage === 2) expect(x.final.delta.items.some((b: any) => b.delta === null)).toBe(true);
  });
  it("Stage1 coverage/classification issues cannot be removed", () => {
    const expected = STAGE_DELTA_CONTRACTS[1].final!;
    for (const issue of expected.issues) expect(() => stageDeltaGate(1,
      [{ ...expected, issues: expected.issues.filter(i => i !== issue) }], new Set(["NO DATA"]), [])).toThrow("ISSUES");
  });
  it("L2 recovery alone cannot make Stage2 TRADES valid", () => {
    const checks = ["GAP", "RESYNCING", "VALID"].map(quality => ({ quality }));
    expect(() => stageDeltaGate(2, [{ delta: 19n, V: 27n, status: "FINAL", issues: [] }], new Set(), checks))
      .toThrow("STAGE2_TRADE_COVERAGE");
    expect(() => stageDeltaGate(2, [], new Set(), [])).toThrow("L2_GAP_RECOVERY");
  });
});
