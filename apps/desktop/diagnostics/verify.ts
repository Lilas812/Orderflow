import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAnalysisHub } from "@workspace/core/analysis-hub";
import { projectDeltaTimeline } from "@workspace/core/delta-timeline";
import { canonical, validate, atomic, deltaDrawingGate } from "../../web/src/diagnostics/load29-browser/contracts";
export { canonical, validate, deltaDrawingGate };
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
export function verifyFrames(d: any, reference: any, records: any[], observer: any, width: number, finalUi?: any, interval?: any) {
  const hub = createAnalysisHub(d.scope, () => 0);
  let consumed = 0, final = "";
  const checks: any[] = [], delta: any[] = [], published = new Set<number>();
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
        for (const draw of matching) delta.push({ ...deltaDrawingGate(draw,
          projectDeltaTimeline(frame.delta.items, draw.viewport, 126), r.revision, width),
          ...(interval ? { layout: classified.get(draw) } : {}) });
      }
      checks.push({ prefix: r.prefix, kind: r.kind, revision: r.revision, sha256: sha(final),
        quality: frame.quality.channels.L2_MBP.status });
    }
    assert.equal(consumed, d.inputs.length, "FINAL_PREFIX");
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
    assert(delta.some(x => x.validBins > 0), "NO_REAL_DELTA_DATA");
    for (const draw of draws.filter((x: any) => !interval || classified.get(x).phase === "formal"))
      assert(published.has(draw.revision), `UNPUBLISHED_DELTA_DRAW:${draw.revision}`);
    for (const [i, input] of d.inputs.entries()) {
      if (input.type === "CONDITION") assert(checks.some(x => x.prefix === i + 1 && x.kind === "probe"), "BOUNDARY_PROBE");
    }
    return { status: "PASS", checks, delta, finalSha256: sha(final) };
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
