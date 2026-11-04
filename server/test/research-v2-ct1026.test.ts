import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { addNqCt1026, CT1026 } from "../research-v2/add-nq-ct1026.ts";

test("CT10/26 research addition: exactly 1440 NQ anchors; config/input/splits/GC unchanged; source immutable", async () => {
  const cfg = JSON.parse(await readFile(new URL("../research-v2/grid-v22-nq-purchase-only.json", import.meta.url), "utf8"));
  const bytes = JSON.stringify(cfg), next = addNqCt1026(cfg);
  assert.equal(JSON.stringify(cfg), bytes);
  const oldNq = cfg.sources.find((s: any) => s.symbol === "NQ");
  const nq = next.sources.find((s: any) => s.symbol === "NQ");
  assert.equal(oldNq.grids.length, 22); assert.equal(nq.grids.length, 23);
  assert.equal((Number(CT1026.toUs) - Number(CT1026.fromUs)) / Number(CT1026.stepUs), 1440);
  assert.deepEqual(next.sources.find((s: any) => s.symbol === "GC"), cfg.sources.find((s: any) => s.symbol === "GC"));
  assert.throws(() => addNqCt1026(next), /already present/);
  const wrong = structuredClone(cfg);
  wrong.sources.find((s: any) => s.symbol === "GC").grids.find((g: any) => g.fromUs === CT1026.fromUs).stepUs = "1000000";
  assert.throws(() => addNqCt1026(wrong), /GC reference/);
  const overlap = structuredClone(cfg);
  overlap.sources.find((s: any) => s.symbol === "NQ").grids.push({ ...CT1026, toUs: String(Number(CT1026.fromUs) + 1e6) });
  assert.throws(() => addNqCt1026(overlap), /overlaps/);
});
