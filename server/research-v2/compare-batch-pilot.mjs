import * as fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { readTable } from "./csv.mjs";
import { reconstructHistory } from "../src/research-v2/history.ts";
const args = process.argv.slice(2), value = f => args[args.indexOf(f) + 1];
if (!["--before", "--after", "--out"].every(f => args.includes(f))) throw Error("usage: compare-batch-pilot.mjs --before DATASET --after DATASET --out NEW_JSON");
const before = path.resolve(value("--before")), after = path.resolve(value("--after")), out = path.resolve(value("--out"));
if (!out.startsWith(path.resolve("data/research-v2") + path.sep)) throw Error("private_output_required");
const a = await readTable(before, "samples"), b = await readTable(after, "samples");
assert.equal(a.length, 4); assert.equal(b.length, 4);
const ax = await readTable(before, "features"), bx = await readTable(after, "features");
const ay = await readTable(before, "targets"), by = await readTable(after, "targets"), ah = await readTable(before, "history");
const bh = await readTable(after, "history-shared"), aq = JSON.parse(await fs.readFile(path.join(before, "quality.json"))).samples;
const bq = await readTable(after, "sample-quality");
const metadataKeys = ["symbol", "contract", "as_of_us", "reference_price_ticks", "reference_price_ts", "reference_age_us", "reference_reason",
  "history_initial_price_used", "history_initial_price_ticks", "history_initial_price_ts", "feature_start_us", "target_end_us", "availability_mode", "tick_size"];
const withoutId = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "sample_id"));
const checks = [];
for (const s of a) {
  const t = b.find(t => t.symbol === s.symbol && t.contract === s.contract && t.as_of_us === s.as_of_us); assert.ok(t);
  for (const key of metadataKeys) assert.equal(t[key], s[key], key);
  assert.deepEqual(withoutId(ax.find(r => r.sample_id === s.sample_id)), withoutId(bx.find(r => r.sample_id === t.sample_id)));
  assert.deepEqual(ay.filter(r => r.sample_id === s.sample_id).map(withoutId), by.filter(r => r.sample_id === t.sample_id).map(withoutId));
  const ranges = JSON.parse(t.history_ranges);
  const base = ranges.flatMap(range => bh.filter(r => r.series_id === range.series_id && Number(r.from_us) >= Number(range.from_us) && Number(r.to_us) <= Number(range.to_us)));
  const numeric = base.map(r => Object.fromEntries(Object.entries(r).filter(([key]) => key !== "series_id").map(([key, val]) =>
    [key, ["from_us", "to_us", "missing_reason"].includes(key) ? val : val === "" ? null : Number(val)])));
  const rebuilt = reconstructHistory(numeric, { history_initial_price_used: Number(t.history_initial_price_used), history_initial_price_ticks: t.history_initial_price_ticks === "" ? null : Number(t.history_initial_price_ticks) })
    .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? "" : String(v)])));
  assert.deepEqual(rebuilt.map(r => ({ ...r, missing_reason: r.missing_reason ?? "" })), ah.filter(r => r.sample_id === s.sample_id).map(withoutId));
  assert.deepEqual(JSON.parse(bq.find(r => r.sample_id === t.sample_id).feature_missing), aq.find(r => r.sample_id === s.sample_id).feature_missing);
  checks.push({ symbol: s.symbol, contract: s.contract, as_of_us: s.as_of_us, x: "exact", history_seconds: rebuilt.length,
    reference: "exact", targets: "exact", missing_reasons: "exact" });
}
await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
await fs.writeFile(out, JSON.stringify({ pass: true, before, after, checks, allowedChanges: ["schema", "sample_id includes input_version", "shared history structure",
  "session-conservative near_group", "as_of_basis metadata", "source-level IO audit replaces per-anchor scan counts"] }, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ pass: true, samples: checks.length, historySeconds: checks.reduce((n, c) => n + c.history_seconds, 0) }));
