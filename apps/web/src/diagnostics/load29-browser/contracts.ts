import type { AnalysisInput, AnalysisRenderFrame } from "@workspace/core/analysis-hub";
import type { Workload } from "../../bench/finiteMockWorkload";
import type { DeltaFrame } from "@workspace/core/delta-timeline";

/** Reproduce the baseline's 717px ChartShell content width, not a Canvas override.
 * 765 - 2*24 padding - 2 border - 72 price axis - 240 VP = 403 CSSpx.
 */
export const LAYOUT = Object.freeze({
  viewportWidth: 852, viewportHeight: 760, parentWidth: 765, padding: 24,
  width: 403, height: 324, dpr: 1,
});
export function layoutGate(layout: any) {
  if (!layout || layout.dpr !== LAYOUT.dpr || layout.innerWidth !== LAYOUT.viewportWidth ||
      layout.innerHeight !== LAYOUT.viewportHeight || layout.parentWidth !== LAYOUT.parentWidth)
    throw Error("LAYOUT_ENV_MISMATCH");
  for (const layer of ["heatmap", "bubble"]) {
    const c = layout.canvases.find((v: any) => v.layer === layer && v.connected);
    if (!c || c.cssWidth !== LAYOUT.width || c.cssHeight !== LAYOUT.height ||
        c.width !== LAYOUT.width || c.height !== LAYOUT.height ||
        c.bufferWidth !== LAYOUT.width || c.bufferHeight !== LAYOUT.height)
      throw Error(`CANVAS_DIMENSION_MISMATCH:${layer}`);
  }
}
/** Independent geometry/data check over actual Canvas2D API observations.
 * A background fill, the zero axis, or an incomplete hatch is not a valid zero bar.
 */
export function deltaDrawingGate(draw: any, frame: DeltaFrame, revision: number) {
  if (!draw || draw.kind !== "delta-draw" || draw.revision !== revision ||
      !draw.canvasId || !draw.contextId || draw.ended < draw.started ||
      draw.width !== LAYOUT.width || draw.height !== frame.height)
    throw Error("DELTA_IDENTITY_OR_REVISION");
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const coords = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => close(v, b[i]));
  const ops = draw.operations as any[];
  if (!ops.some(o => o.api === "fillRect" && o.style === "#08090d" &&
      coords(o.args, [0, 0, LAYOUT.width, frame.height]))) throw Error("DELTA_BACKGROUND_MISSING");
  if (draw.binRows.length !== frame.bars.length) throw Error("DELTA_BIN_COUNT");
  let valid = 0;
  for (const bar of frame.bars) {
    const bin = bar.bin, row = draw.binRows.find((r: any) => r.id === bin.id);
    if (!row || row.delta !== (bin.delta === null ? "" : bin.delta.toString()) ||
        row.B !== bin.B.toString() || row.S !== bin.S.toString() || row.U !== bin.U.toString() ||
        row.revision !== bin.revision || row.quality !== bin.quality ||
        !close(row.x0, bar.x0) || !close(row.x1, bar.x1) || row.direction !== bar.direction)
      throw Error("DELTA_INPUT_MISMATCH");
    const width = Math.max(0, bar.x1 - bar.x0);
    if (bar.direction === "UP" || bar.direction === "DOWN") {
      const expected = [bar.x0, Math.min(bar.top!, bar.bottom!), width,
        Math.max(1, Math.abs(bar.bottom! - bar.top!))];
      if (!ops.some(o => o.api === "fillRect" &&
          o.style === (bar.direction === "UP" ? "#17c96b" : "#b548db") &&
          close(o.alpha, bar.opacity) && coords(o.args, expected))) throw Error("DELTA_DATA_DRAW_MISSING");
      valid++;
    } else if (bar.direction === "ZERO") {
      if (!ops.some(o => o.api === "stroke" && o.style === "#aab0c0" && o.lineWidth === 2 &&
          o.path.length === 2 && coords(o.path[0], [bar.x0, frame.zeroY]) &&
          coords(o.path[1], [bar.x0 + width, frame.zeroY])) ||
          !ops.some(o => o.api === "fillText" && o.text === "0" &&
            coords(o.args, [bar.x0 + 2, frame.zeroY - 4]))) throw Error("DELTA_ZERO_DRAW_MISSING");
      valid++;
    } else if (!ops.some(o => o.api === "fillRect" &&
        o.style === "rgba(213, 167, 75, 0.08)" && coords(o.args, [bar.x0, 0, width, frame.height]))) {
      throw Error("DELTA_WITHHELD_DRAW_MISSING");
    }
  }
  return { status: "PASS", revision, validBins: valid, withheldBins: frame.bars.length - valid,
    empty: frame.bars.length === 0 };
}

export const BUDGET = Object.freeze({
  inputMs: 300, publishMs: 250, wallMs: [70_000, 120_000, 210_000],
  totalWallMs: 420_000, processes: 24, browserRss: 2 * 1024 ** 3,
  totalRss: 3 * 1024 ** 3, parentRss: 512 * 1024 ** 2,
  wireBytes: 8 * 1024 ** 2, blockBytes: 1024 ** 2, observerRows: 8192,
});
export type Definition = Pick<Workload, "scope" | "inputs" | "query"> & { inputSha256: string };
/** Byte-identical encoding to the frozen Node helper; no Node imports in the browser. */
export function canonical(value: unknown): string {
  const encode = (v: unknown): unknown => {
    if (typeof v === "bigint") return { bigint: v.toString() };
    if (v instanceof Map) return { map: [...v].map(([k, x]) => [encode(k), encode(x)]) };
    if (Array.isArray(v)) return v.map(encode);
    if (v !== null && typeof v === "object") return Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, encode(x)]));
    return v;
  };
  return JSON.stringify(encode(value));
}
export function validate(d: Definition, stage: number) {
  if (![0, 1, 2].includes(stage) || d.inputs.length !== [128, 256, 500][stage])
    throw Error("STAGE_INPUT_COUNT");
  if (d.scope.budget.inputs > 512 || d.inputs.length > d.scope.budget.inputs ||
      d.scope.budget.bookLevels > 64 || d.query.cells.length > 512 ||
      d.scope.budget.normalizedBytes > 1048576) throw Error("INPUT_CAP");
  if (d.scope.config.identity.environment !== "MOCK" ||
      d.inputs.some(i => i.type === "EVENT" && i.event.header.environment !== "MOCK"))
    throw Error("NOT_MOCK");
}
export function atomic(frame: AnalysisRenderFrame) {
  if (![frame.book, frame.heatmap, frame.bubbles, frame.delta, frame.volumeProfile, frame.quality]
    .every(p => p.revision === frame.revision)) throw Error("FRAME_REVISION_MISMATCH");
}
export function viewportSeed(d: Definition) {
  const prices: number[] = [];
  for (const input of d.inputs) {
    if (input.type !== "EVENT") continue;
    const e = input.event;
    if (e.kind === "L2_SNAPSHOT") prices.push(...e.bids.map(l => l.priceTicks), ...e.asks.map(l => l.priceTicks));
    else if ("priceTicks" in e) prices.push(e.priceTicks);
  }
  if (!prices.length) throw Error("NO_PRICE_RANGE");
  const end = BigInt(d.query.endNs) + 250_000_000n;
  return { endNs: end.toString(), spanNs: end - BigInt(d.query.startNs) + 250_000_000n,
    priceMinTick: Math.min(...prices) - 1, priceMaxTick: Math.max(...prices) + 1 };
}
export function marketCount(inputs: readonly AnalysisInput[]) {
  return inputs.reduce((n, i) => n + (i.type === "EVENT" ? 1 : i.type === "BATCH" ? i.events.length : 0), 0);
}
export function deadlineBudget(stage: number, now: number, globalDeadline: number) {
  if (![0, 1, 2].includes(stage) || globalDeadline <= now) throw Error("OVERALL_WALL");
  return Math.min(BUDGET.wallMs[stage], globalDeadline - now);
}
export async function orderedStages<T>(run: (stage: number) => Promise<T & { status: string }>,
  checkpoint: (stage: number, result: T) => Promise<void>) {
  const result = [];
  for (const stage of [0, 1, 2]) {
    const r = await run(stage);
    await checkpoint(stage, r);
    result.push(r);
    if (r.status !== "PASS") break;
  }
  return result;
}
