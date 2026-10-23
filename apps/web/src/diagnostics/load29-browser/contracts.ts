import type { AnalysisInput, AnalysisRenderFrame } from "@workspace/core/analysis-hub";
import type { Workload } from "../../bench/finiteMockWorkload";

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
