import * as fs from "node:fs/promises";
import path from "node:path";
import { readTable } from "./csv.mjs";
const args = process.argv.slice(2), arg = flag => args[args.indexOf(flag) + 1];
if (!["--before", "--after", "--out"].every(f => args.includes(f) && arg(f)))
  throw Error("usage: compare-pilot.mjs --before DATASET_DIR --after DATASET_DIR --out NEW_EVIDENCE_JSON");
const tables = ["samples", "features", "history", "annotations", "targets", "splits"];
const [before, after] = await Promise.all([arg("--before"), arg("--after")].map(async dir =>
  Object.fromEntries(await Promise.all(tables.map(async t => [t, await readTable(dir, t)])))));
const context = s => `${s.symbol}:${s.contract}:${s.as_of_us}`;
const old = new Map(before.samples.map(s => [context(s), s]));
const result = [];
for (const s of after.samples) {
  const b = old.get(context(s)); if (!b) throw Error("sample_context_changed");
  const changes = {};
  for (const t of tables) {
    const arows = before[t].filter(r => r.sample_id === b.sample_id), brows = after[t].filter(r => r.sample_id === s.sample_id);
    const key = r => t === "history" ? r.from_us : t === "targets" ? r.horizon_seconds : t === "annotations" ? r.annotation_id : "single";
    const index = new Map(arows.map(r => [key(r), r])), columns = {}, examples = [];
    if (arows.length !== brows.length) throw Error("row_count_changed");
    for (const r of brows) {
      const previous = index.get(key(r)); if (!previous) throw Error("row_join_failed");
      for (const c of new Set([...Object.keys(previous), ...Object.keys(r)])) {
        if (previous[c] === r[c]) continue;
        const stat = columns[c] ??= { changedRows: 0, added: !(c in previous), removed: !(c in r) };
        stat.changedRows++;
        if (examples.length < 16 && c !== "sample_id") examples.push({ row: key(r), column: c, before: previous[c] ?? null, after: r[c] ?? null });
      }
    }
    changes[t] = { columns, examples };
  }
  result.push({ symbol: s.symbol, contract: s.contract, as_of_us: s.as_of_us, beforeSampleId: b.sample_id, afterSampleId: s.sample_id, changes });
}
if (result.length !== before.samples.length) throw Error("sample_removed");
await fs.mkdir(path.dirname(arg("--out")), { recursive: true, mode: 0o700 });
await fs.writeFile(arg("--out"), JSON.stringify({ before: arg("--before"), after: arg("--after"), samples: result }, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(result.map(s => ({ symbol: s.symbol, as_of_us: s.as_of_us,
  changedFeatures: Object.keys(s.changes.features.columns), changedHistory: s.changes.history.columns,
  sampleMetadata: s.changes.samples.examples }))));
