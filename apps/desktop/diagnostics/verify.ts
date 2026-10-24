import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAnalysisHub } from "@workspace/core/analysis-hub";
import { projectDeltaTimeline } from "@workspace/core/delta-timeline";
import { canonical, validate, atomic, deltaDrawingGate as sharedDeltaDrawingGate } from "../../web/src/diagnostics/load29-browser/contracts";
export { canonical, validate };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Every initialization draw is checked at its own observed geometry, never dropped.
 * Formal draws require the settled generation and width, even at revision zero. */
export function deltaLayoutGate(draw: any, interval: any, width: number) {
  const l = draw.layout;
  assert(l && Number.isSafeInteger(l.generation) && l.generation >= 0 &&
    Number.isFinite(l.at) && l.at >= draw.started && l.at <= draw.ended && l.dpr > 0 &&
    l.cssWidth > 0 && l.cssHeight === 126 &&
    draw.width === Math.round(l.cssWidth * l.dpr) &&
    draw.height === Math.round(l.cssHeight * l.dpr) &&
    draw.viewport?.dpr === l.dpr && draw.viewport?.bounds.width === l.cssWidth,
  "DELTA_LAYOUT_OBSERVATION");
  if (l.phase === "initial") {
    assert(draw.ended <= interval.start.at && draw.revision === 0 &&
      l.generation <= interval.start.generation, "INITIAL_DELTA_PERIOD");
    return { phase: "initial", width: l.cssWidth, generation: l.generation, at: l.at };
  }
  assert(l.phase === "formal" && draw.started >= interval.start.at && draw.ended <= interval.end &&
    l.generation === interval.start.generation && l.cssWidth === width &&
    l.dpr === interval.start.snapshot.geometry.dpr, "FORMAL_DELTA_LAYOUT_CHANGED");
  return { phase: "formal", width, generation: l.generation, at: l.at };
}
export function inputGate(d: any, stage: number, reference: any) {
  validate(d, stage);
  assert.equal(sha(JSON.stringify(d.inputs)), reference.inputSha256, "INPUT_SHA");
  assert.equal(d.inputSha256, reference.inputSha256, "DECLARED_INPUT_SHA");
}
export const STAGE_DELTA_CONTRACTS = Object.freeze([
  Object.freeze({ stage: 0, inputs: 128, requireDirections: Object.freeze(["UP", "ZERO"]),
    final: Object.freeze({ B: 31n, S: 31n, U: 0n, V_raw: 62n, V: 62n, delta: 0n,
      quality: "VALID", status: "PROVISIONAL", issues: Object.freeze([] as string[]) }) }),
  Object.freeze({ stage: 1, inputs: 256, requireDirections: Object.freeze(["NO DATA"]),
    final: Object.freeze({ B: 83n, S: 64n, U: 57n, V_raw: 204n, V: null, delta: null,
      quality: "NO DATA", status: "INCOMPLETE",
      issues: Object.freeze(["NO_TRADE_COVERAGE", "INCOMPLETE_CLASSIFICATION"]) }) }),
  Object.freeze({ stage: 2, inputs: 500, requireDirections: Object.freeze([] as string[]),
    l2Conditions: Object.freeze(["GAP", "RESYNCING", "VALID"]),
    tradeContract: "Frozen frame SHA + per-bin exact quality; L2 Snapshot never repairs TRADES" }),
] as const);
/** Preserve the shared positive gate and additionally reject fabricated numeric drawing.
 * Every numeric primitive must correspond to exactly one real numeric bin. */
export function deltaDrawingGate(draw: any, frame: any, revision: number, width?: number) {
  const result = sharedDeltaDrawingGate(draw, frame, revision, width);
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const eq = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => close(x, b[i]));
  const expected: any[] = [];
  for (const b of frame.bars) {
    if (b.direction === "UP" || b.direction === "DOWN")
      expected.push({ api: "fillRect", style: b.direction === "UP" ? "#17c96b" : "#b548db",
        alpha: b.opacity, args: [b.x0, Math.min(b.top, b.bottom), Math.max(0, b.x1 - b.x0),
          Math.max(1, Math.abs(b.bottom - b.top))] });
    if (b.direction === "ZERO") {
      expected.push({ api: "stroke", style: "#aab0c0", lineWidth: 2,
        path: [[b.x0, frame.zeroY], [b.x1, frame.zeroY]] });
      expected.push({ api: "fillText", style: "#aab0c0", text: "0", args: [b.x0 + 2, frame.zeroY - 4] });
    }
  }
  const numeric = draw.operations.filter((o: any) =>
    o.api === "fillRect" && ["#17c96b", "#b548db"].includes(o.style) ||
    o.api === "stroke" && (o.lineWidth === 2 || o.style === "#aab0c0") ||
    o.api === "fillText" && /^[+-]?\d+(?:\.\d+)?$/.test(o.text));
  assert.equal(numeric.length, expected.length, "DELTA_EXTRA_NUMERIC_BAR");
  for (const o of numeric) {
    const i = expected.findIndex(e => e.api === o.api && e.style === o.style &&
      (e.api === "fillRect" ? close(e.alpha, o.alpha) && eq(e.args, o.args) :
        e.api === "fillText" ? e.text === o.text && eq(e.args, o.args) :
          e.lineWidth === o.lineWidth && o.path.length === 2 && e.path.every((p: number[], j: number) => eq(p, o.path[j]))));
    assert(i >= 0, "DELTA_EXTRA_NUMERIC_BAR"); expected.splice(i, 1);
  }
  const fills = [{ style: "#08090d", args: [0, 0, width ?? 403, frame.height] },
    ...frame.bars.map((b: any) => ["UP", "DOWN"].includes(b.direction) ?
      { style: b.direction === "UP" ? "#17c96b" : "#b548db",
        args: [b.x0, Math.min(b.top, b.bottom), Math.max(0, b.x1 - b.x0), Math.max(1, Math.abs(b.bottom - b.top))] } :
      b.direction !== "ZERO" ? { style: "rgba(213, 167, 75, 0.08)",
        args: [b.x0, 0, Math.max(0, b.x1 - b.x0), frame.height] } : null).filter(Boolean)];
  for (const o of draw.operations.filter((o: any) => o.api === "fillRect")) {
    const i = fills.findIndex(e => e.style === o.style && eq(e.args, o.args));
    assert(i >= 0, "DELTA_UNEXPECTED_FILL"); fills.splice(i, 1);
  }
  assert(fills.length === 0, "DELTA_FILL_MISSING");
  return result;
}
export function stageDeltaGate(stage: number, items: readonly any[], directions: Set<string>, checks: any[]) {
  const contract = STAGE_DELTA_CONTRACTS[stage];
  assert(contract, "DELTA_STAGE_UNKNOWN");
  for (const direction of contract.requireDirections) assert(directions.has(direction), `DELTA_DIRECTION_MISSING:${direction}`);
  if (stage === 0 || stage === 1) {
    assert("final" in contract, "DELTA_STAGE_CONTRACT");
    const bin = items.find(b => b.B > 0n || b.S > 0n || b.U > 0n);
    assert(bin, "DELTA_FINAL_BIN_MISSING");
    for (const [key, value] of Object.entries(contract.final)) {
      if (key === "issues") assert.deepEqual([...bin.issues].sort(), [...value as readonly string[]].sort(), "DELTA_STAGE_ISSUES");
      else assert.equal(bin[key], value, `DELTA_STAGE_FINAL:${key}`);
    }
    if (stage === 1) assert(items.length === 1, "DELTA_STAGE_BIN_COUNT");
  } else {
    assert(checks.some(c => c.quality === "GAP") && checks.some(c => c.quality === "RESYNCING") &&
      checks.at(-1)?.quality === "VALID", "L2_GAP_RECOVERY");
    assert(items.length > 0 && items.some(b => b.delta === null && b.V === null &&
      b.status === "INCOMPLETE" && b.issues.includes("NO_TRADE_COVERAGE")), "STAGE2_TRADE_COVERAGE");
  }
  return { status: "PASS", stage, contract: "predeclared", directions: [...directions] };
}
export function verifyFrames(d: any, reference: any, records: any[], observer: any, width: number, finalUi?: any, interval?: any) {
  const hub = createAnalysisHub(d.scope, () => 0);
  let consumed = 0, final = "";
  const checks: any[] = [], delta: any[] = [], published = new Set<number>(), directions = new Set<string>();
  try {
    const draws = observer.rows.filter((x: any) => x.kind === "delta-draw");
    const classified = new Map<any, any>();
    if (interval) {
      const empty = hub.readRenderFrame(d.query);
      for (const draw of draws) {
        const layout = deltaLayoutGate(draw, interval, width);
        classified.set(draw, layout);
        if (draw.revision === 0)
          delta.push({ ...deltaDrawingGate(draw, projectDeltaTimeline(empty.delta.items, draw.viewport, 126),
            0, layout.width), layout });
      }
    }
    for (const r of records) {
      if (r.kind !== "frame" && r.kind !== "probe") continue;
      assert(r.prefix >= consumed && r.prefix <= d.inputs.length, "PREFIX_ORDER");
      while (consumed < r.prefix) assert.equal(hub.ingest(d.inputs[consumed++]).disposition, "ACCEPTED", "REFERENCE_REJECTION");
      const frame = hub.readRenderFrame(d.query); atomic(frame);
      final = canonical(frame);
      assert.equal(r.canonical, final, `SAME_PREFIX_SAME_QUERY:${r.prefix}`);
      assert.equal(r.revision, frame.revision, "NOTICE_REVISION");
      if (r.kind === "frame") {
        if (interval && r.purpose === "pre-input-layout-only") {
          assert(r.prefix === 0 && r.revision === 0, "PRE_LAYOUT_FRAME");
          published.add(0);
          checks.push({ prefix: 0, kind: "initial-frame", revision: 0, sha256: sha(final),
            quality: frame.quality.channels.L2_MBP.status });
          continue;
        }
        assert(!published.has(r.revision), "DUPLICATE_PUBLICATION");
        published.add(r.revision);
        const matching = draws.filter((x: any) => x.revision === r.revision &&
          (!interval || classified.get(x).phase === "formal"));
        assert(matching.length > 0, `DELTA_DRAW_MISSING:${r.revision}`);
        for (const draw of matching) {
          const projected = projectDeltaTimeline(frame.delta.items, draw.viewport, 126);
          const checked = deltaDrawingGate(draw, projected, r.revision, width);
          projected.bars.forEach(b => directions.add(b.direction));
          delta.push({ ...checked, ...(interval ? { layout: classified.get(draw) } : {}) });
        }
      }
      checks.push({ prefix: r.prefix, kind: r.kind, revision: r.revision, sha256: sha(final),
        quality: frame.quality.channels.L2_MBP.status });
    }
    assert.equal(consumed, d.inputs.length, "FINAL_PREFIX");
    assert(published.has(d.inputs.length), "FINAL_DELTA_PUBLICATION_MISSING");
    assert.equal(sha(final), reference.publicFrameSha256, "FROZEN_REFERENCE");
    if (finalUi) {
      const p = hub.readRenderFrame(d.query).volumeProfile.value;
      assert(p, "VP_REFERENCE_MISSING");
      const t = p.totals, v = p.valueArea;
      assert.equal(finalUi.vpTotals.trim(), `B ${t.buyVolume} / S ${t.sellVolume} / U ${t.unknownVolume} / V ${t.totalVolume} / trades ${t.tradeCount}`, "VP_UI_TOTALS");
      assert.equal(finalUi.vpSummary.trim(), `POC ${p.pocTick ?? "none"} / VAL ${v.valTick ?? "none"} / VAH ${v.vahTick ?? "none"} ticks / VA volume ${v.includedVolume} (70%) / levels ${p.priceLevels}/${p.maxPriceLevels}`, "VP_UI_VA");
      assert.deepEqual(finalUi.vpRows, p.levels.map(l =>
        `${l.priceTicks}: B ${l.buyVolume} S ${l.sellVolume} U ${l.unknownVolume} = ${l.totalVolume}`), "VP_UI_LEVELS");
    }
    const stage = STAGE_DELTA_CONTRACTS.find(c => c.inputs === d.inputs.length)?.stage;
    assert(stage !== undefined, "DELTA_SCENARIO_NOT_DECLARED");
    const qualityContract = stageDeltaGate(stage, hub.readRenderFrame(d.query).delta.items, directions, checks);
    for (const draw of draws.filter((x: any) => !interval || classified.get(x).phase === "formal"))
      assert(published.has(draw.revision), `UNPUBLISHED_DELTA_DRAW:${draw.revision}`);
    for (const [i, input] of d.inputs.entries()) {
      if (input.type === "CONDITION") assert(checks.some(x => x.prefix === i + 1 && x.kind === "probe"), "BOUNDARY_PROBE");
    }
    return { status: "PASS", checks, delta, qualityContract, finalSha256: sha(final) };
  } finally { /* This RAM-only reference hub owns no timers or external resources. */ }
}
/** Reclassify only the exact saved placeholder. Never edit old trial evidence. */
export function recheckSavedDraw(draw: any) {
  const copy = structuredClone(draw), placeholders = copy.binRows.filter((r: any) => r.id === "empty");
  assert(placeholders.every((r: any) => r.revision === null && r.x0 === null && r.x1 === null &&
    !r.delta && !r.B && !r.S && !r.U && !r.quality && !r.direction), "SAVED_PLACEHOLDER_FORGED");
  copy.binRows = copy.binRows.filter((r: any) => r.id !== "empty");
  copy.placeholders = placeholders.map(() => ({ text: "NO DATA: no Delta bin", hasBinFields: false }));
  return copy;
}
