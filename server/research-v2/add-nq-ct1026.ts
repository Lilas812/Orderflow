/** Research configuration only: no calculation, split, input or product changes. */
import assert from "node:assert/strict";
type Grid = { fromUs: string; toUs: string; stepUs: string };
type GridConfig = { sources: { symbol: string; grids?: Grid[] }[] };
export const CT1026 = { fromUs: "1793052000000000", toUs: "1793138400000000", stepUs: "60000000" };
export function addNqCt1026<T extends GridConfig>(prior: T): T {
  const next = structuredClone(prior);
  const nq = next.sources.find(s => s.symbol === "NQ"), gc = next.sources.find(s => s.symbol === "GC");
  assert.ok(nq?.grids && gc?.grids, "NQ/GC grids required");
  const reference = gc.grids.find(g => g.fromUs === CT1026.fromUs);
  assert.deepEqual(reference, CT1026, "GC reference must be the full CT10/26 60s grid");
  assert.ok(!nq.grids.some(g => Number(g.fromUs) < Number(CT1026.toUs) && Number(g.toUs) > Number(CT1026.fromUs)),
    "NQ CT10/26 already present or overlaps");
  nq.grids.push(structuredClone(reference));
  nq.grids.sort((a, b) => Number(a.fromUs) - Number(b.fromUs));
  const reverted = structuredClone(next);
  reverted.sources.find(s => s.symbol === "NQ")!.grids =
    nq.grids.filter(g => g.fromUs !== CT1026.fromUs);
  assert.deepEqual(reverted, prior, "only the NQ CT10/26 grid may change");
  return next;
}
