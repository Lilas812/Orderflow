/** Purchased data + downloaded snapshots, LOCAL ONLY. No SDK/runtime imports or cloud writes. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { canonical } from "../src/import/databento-stage.ts";
import { preparePromotion, type PromotionPlan, type SourceFile } from "../src/import/longvp-package.ts";
import type { Inventory, Assignment } from "../src/import/longvp-promotion.ts";
import type { DayData } from "../src/long-vp/day.ts";

const arg = (key: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
if (!arg("nq-inventory") || !arg("gc-inventory") || !arg("out")) throw Error("three paths required");
const out = path.resolve(arg("out")!);
if (!out.startsWith(path.resolve("data/longvp-promotion") + path.sep)) throw Error("isolated_output_required");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.mkdir(out, { recursive: false });
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const fileHash = async (file: string) => sha(await fs.readFile(file));
const readDay = async (file: string) => {
  const b = await fs.readFile(file);
  return JSON.parse((b[0] === 31 ? gunzipSync(b) : b).toString()) as DayData;
};
type Prices = Map<string, number[]>;
function prices(d: DayData, selected?: Set<number>, mapping?: Assignment[], result: Prices = new Map()): Prices {
  for (const r of d.vp30m) {
    if (selected && !selected.has(r[0])) continue;
    const target = mapping?.find(w => w.fromSec <= r[0] && r[0] + 1800 <= w.toSec)?.targetContract;
    const key = `${target ?? d.contracts[r[4]]!.contract}:${r[1]}`, old = result.get(key) ?? [0, 0, 0];
    result.set(key, [old[0]! + r[2], old[1]! + r[3], old[2]! + (r[5] ?? 0)]);
  }
  return result;
}
function retained(old: number[][], next: number[][]) {
  let i = 0;
  for (const row of next) if (i < old.length && JSON.stringify(row) === JSON.stringify(old[i])) i++;
  assert.equal(i, old.length);
}
const results: unknown[] = [];
for (const symbol of ["NQ", "GC"] as const) {
  const inventoryFile = path.resolve(arg(symbol === "NQ" ? "nq-inventory" : "gc-inventory")!);
  const inventory = JSON.parse(await fs.readFile(inventoryFile, "utf8")) as Inventory;
  const activeFile = path.resolve(symbol === "NQ" ? "data/databento-import/active.json" : "data/databento-gc-import/active.json");
  const originalActiveHash = await fileHash(activeFile);
  const active = JSON.parse(await fs.readFile(activeFile, "utf8"));
  assert.equal(active.state, "verified_isolated");
  const inputs: SourceFile[] = [], assignments: Assignment[] = [], watched = new Map<string, string>();
  for (const object of inventory.objects) {
    watched.set(object.file, object.sha256);
    if (symbol !== "NQ") continue;
    const d = await readDay(object.file);
    for (const c of d.contracts) {
      // Only existing production attribution, not a guessed historical front-month.
      if (canonical(c.contract, Number(d.tradingDate.slice(0, 4))) !== "NQZ26") continue;
      assignments.push({ fromSec: Math.ceil(c.fromSec), toSec: Math.floor(c.toSec),
        sourceContract: "NQZ26", targetContract: c.contract,
        evidence: `Existing production snapshot ${object.name} SHA256=${object.sha256}; canonical(${c.contract},${d.tradingDate.slice(0, 4)})=NQZ26. No extension beyond that span.` });
    }
  }
  for (const item of await fs.readdir(active.generation, { withFileTypes: true })) {
    if (!item.isDirectory() || (symbol === "NQ" && item.name !== "NQZ26")) continue;
    const folder = path.join(active.generation, item.name, "longvp");
    let files: string[];
    try { files = await fs.readdir(folder); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    for (const name of files.filter(f => f.endsWith(".json")).sort()) {
      const file = path.join(folder, name);
      if (symbol === "NQ" && !inventory.objects.some(o => o.name.endsWith("/" + name + ".gz"))) continue;
      const expected = active.outputHashes.find((f: { file: string }) => f.file === file)?.sha256;
      assert.ok(expected);
      inputs.push({ file, sha256: expected, contract: item.name }); watched.set(file, expected);
    }
  }
  const plan: PromotionPlan = { version: 1, symbol, builtAtUs: Date.parse(inventory.capturedAt) * 1000,
    inventoryFile, inventorySha256: await fileHash(inventoryFile), sources: inputs, assignments };
  const planFile = path.join(out, symbol + "-plan.json");
  await fs.writeFile(planFile, JSON.stringify(plan, null, 2), { flag: "wx" });
  const root = path.join(out, symbol.toLowerCase()), prepared = await preparePromotion(plan, root);
  for (const d of prepared.manifest.days.filter(d => d.changed)) {
    const original = inventory.objects.find(o => o.name === d.name);
    const before = original ? await readDay(original.file) : null;
    const after = await readDay(path.join(root, d.file!));
    const expected = before ? prices(before) : new Map<string, number[]>();
    const dateInputs: SourceFile[] = [];
    for (const input of inputs) if ((await readDay(input.file)).tradingDate === d.date) dateInputs.push(input);
    for (let i = 0; i < dateInputs.length; i++)
      prices(await readDay(dateInputs[i]!.file), new Set(d.audits[i]!.accepted), assignments, expected);
    assert.deepEqual([...prices(after)].sort(), [...expected].sort());
    if (before) {
      // Optional tuple fields are retained byte-for-byte within each original row.
      retained(before.bars1m as number[][], after.bars1m as number[][]);
      retained(before.vp30m as number[][], after.vp30m as number[][]);
      assert.deepEqual(after.contracts.slice(0, before.contracts.length), before.contracts);
    }
  }
  const again = await preparePromotion(plan, root);
  assert.equal(again.state, "already_prepared"); assert.deepEqual(again.manifest, prepared.manifest);
  for (const [file, hash] of watched) assert.equal(await fileHash(file), hash);
  assert.equal(await fileHash(activeFile), originalActiveHash);
  results.push({ symbol, state: prepared.state, generation: prepared.generation, planFile,
    sourceDays: inputs.length, sourceFilesUnchanged: watched.size, activeImportUnchanged: true,
    changed: prepared.manifest.days.filter(d => d.changed).map(d => ({ date: d.date,
      buckets: d.audits.flatMap(a => a.accepted).length,
      buy: d.audits.reduce((n, a) => n + a.buy, 0), sell: d.audits.reduce((n, a) => n + a.sell, 0),
      unknown: d.audits.reduce((n, a) => n + a.unknown, 0) })),
    skipped: prepared.manifest.days.flatMap(d => d.audits).reduce((acc, a) => {
      for (const [reason, count] of Object.entries(a.skipped)) acc[reason] = (acc[reason] ?? 0) + count;
      return acc;
    }, {} as Record<string, number>),
    priceReconciliation: true, rerunAddsNothing: true,
    note: symbol === "GC" ? "No front-month timeline assigned; all candidates held." : "Only existing production contract spans; other historical dates held." });
}
await fs.writeFile(path.join(out, "verification.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ out, results }));
