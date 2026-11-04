import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { setPriority } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { parseCsv } from "./csv.mjs";
import { digest } from "../src/research-v2/engine.ts";
import { hashFile } from "../src/research-v2/snapshot.ts";
import { assertInputVersions } from "../src/research-v2/inventory.ts";
import { assignSplits } from "../src/research-v2/splits.ts";
import { csvCell } from "../src/labels/export.ts";
const args = process.argv.slice(2), arg = f => args[args.indexOf(f) + 1];
if (!["--first", "--second", "--out"].every(f => args.includes(f))) throw Error("usage: verify-batch.mjs --first DATASET --second DATASET --out NEW_PRIVATE_DIR");
const out = path.resolve(arg("--out"));
if (!out.startsWith(path.resolve("data/research-v2") + path.sep)) throw Error("private_output_required");
setPriority(process.pid, 19);
async function* table(dir, file) {
  // These machine tables contain no user note/text newlines; annotations are not read by this streaming validator.
  const stream = createReadStream(path.join(dir, file), { encoding: "utf8", highWaterMark: 65536 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity }); let header;
  try { for await (const line of lines) { if (!header) { header = line; continue; } if (line) yield parseCsv(header + "\n" + line + "\n")[0]; } }
  finally { lines.close(); stream.destroy(); }
}
const first = path.resolve(arg("--first")), second = path.resolve(arg("--second"));
const a = JSON.parse(await fs.readFile(path.join(first, "manifest.json"))), b = JSON.parse(await fs.readFile(path.join(second, "manifest.json")));
for (const [dir, m] of [[first, a], [second, b]]) {
  assert.equal(m.schema, "orderflow.research.v2.2"); assert.equal(digest(m.files), m.content_hash);
  for (const f of m.files) assert.equal(await hashFile(path.join(dir, f.name)), f.sha256, f.name);
  for (const s of m.input_versions) for (const f of s.files) assert.equal(f.after_sha256, f.sha256);
  execFileSync("unzip", ["-t", path.join(dir, "dataset-v2.zip")], { stdio: "pipe" });
}
assert.equal(a.code.sourceHash, b.code.sourceHash); assert.equal(a.content_hash, b.content_hash);
assert.deepEqual(a.input_versions, b.input_versions);
assertInputVersions([...a.input_versions, ...b.input_versions]);
const config = JSON.parse(await fs.readFile(path.join(first, "config.json")));
const quality = JSON.parse(await fs.readFile(path.join(first, "quality.json")));
const sourceVersion = new Map(a.input_versions.map(s => [`${s.symbol}:${s.contract}`, s.input_version]));
// Only bounded metadata/interval indexes are retained, never the monthly history/tape.
const series = new Map(); let sharedRows = 0, lastId;
for await (const row of table(first, "history-shared.csv")) {
  let state = series.get(row.series_id), from = Number(row.from_us), to = Number(row.to_us);
  if (!state) series.set(row.series_id, state = { end: -Infinity, ranges: [] });
  else if (lastId !== row.series_id) throw Error("shared_series_reopened");
  assert.equal(to - from, 1e6); assert.ok(from >= state.end, "shared second duplication/order");
  if (from === state.end) state.ranges.at(-1).to = to;
  else state.ranges.push({ from, to });
  state.end = to; lastId = row.series_id; sharedRows++;
}
assert.equal(sharedRows, a.counts.sharedHistoryRows);
const splitIterator = table(first, "splits.csv")[Symbol.asyncIterator]();
const sampleSession = new Map(), foldCounts = {}, foldSessions = {}, seen = new Set(); let samples = 0;
for await (const s of table(first, "samples.csv")) {
  assert.ok(!seen.has(s.sample_id), "duplicate sample"); seen.add(s.sample_id);
  assert.equal(s.input_version, sourceVersion.get(`${s.symbol}:${s.contract}`));
  assert.equal(digest({ symbol: s.symbol, contract: s.contract, as_of_us: s.as_of_us, settingsHash: a.settings_hash, input_version: s.input_version }), s.sample_id);
  const split = (await splitIterator.next()).value; assert.ok(split); assert.equal(split.sample_id, s.sample_id);
  const expected = assignSplits([s], config.splits)[0];
  for (const k of ["fold", "status", "reason"]) assert.equal(split[k], expected[k] ?? "");
  for (const range of JSON.parse(s.history_ranges)) assert.ok(series.get(range.series_id)?.ranges.some(r =>
    Number(range.from_us) >= r.from && Number(range.to_us) <= r.to), "unresolvable shared history range");
  const key = `${s.symbol}:${split.fold}:${split.status}:${split.reason}`;
  foldCounts[key] = (foldCounts[key] ?? 0) + 1;
  (foldSessions[key] ??= new Set()).add(s.session_group);
  sampleSession.set(s.sample_id, s.session_group); samples++;
}
assert.equal((await splitIterator.next()).done, true); assert.equal(samples, a.counts.samples);
const targetMissing = {}; let targetRows = 0;
for await (const row of table(first, "targets.csv")) {
  assert.ok(seen.has(row.sample_id));
  if (row.missing_reason) {
    const key = `${sampleSession.get(row.sample_id)}:${row.horizon_seconds}:${row.missing_reason}`;
    targetMissing[key] = (targetMissing[key] ?? 0) + 1;
  }
  targetRows++;
}
assert.equal(targetRows, a.counts.targetRows);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
async function csv(file, keys, rows) {
  const bytes = keys.join(",") + "\n" + rows.map(r => keys.map(k => csvCell(r[k])).join(",")).join("\n") + "\n";
  await fs.writeFile(path.join(out, file), bytes, { mode: 0o600, flag: "wx" });
}
await csv("sessions.csv", ["symbol", "contract", "ct_date", "session_start_us", "samples", "coverage_seconds", "reference_missing", "unknown_volume"], quality.inventory);
const rates = [], ys = [], missing = [];
for (const s of quality.inventory) {
  for (const [x, count] of Object.entries(s.x_nonnull)) rates.push({ symbol: s.symbol, ct_date: s.ct_date, x, nonnull: count, samples: s.samples, rate: s.x_nonnull_rate[x] });
  for (const [horizon, count] of Object.entries(s.y_complete)) ys.push({ symbol: s.symbol, ct_date: s.ct_date, horizon_seconds: horizon, complete: count, samples: s.samples, rate: s.y_complete_rate[horizon] });
  for (const [reason, count] of Object.entries(s.reasons)) missing.push({ symbol: s.symbol, ct_date: s.ct_date, category: "X_null_columns", reason, count });
  for (const [reason, count] of Object.entries(s.reference_reasons)) missing.push({ symbol: s.symbol, ct_date: s.ct_date, category: "reference_samples", reason, count });
}
for (const [key, count] of Object.entries(targetMissing)) missing.push({ symbol: key, ct_date: "", category: "Y_samples_per_horizon", reason: key.split(":").at(-1), count });
await csv("x-nonnull.csv", ["symbol", "ct_date", "x", "nonnull", "samples", "rate"], rates);
await csv("y-completeness.csv", ["symbol", "ct_date", "horizon_seconds", "complete", "samples", "rate"], ys);
await csv("missing-reasons.csv", ["symbol", "ct_date", "category", "reason", "count"], missing);
const summary = { pass: true, first, second, schema: a.schema, content_hash: a.content_hash, sourceHash: a.code.sourceHash,
  samples, sharedRows, targetRows, sessions: quality.inventory.length, foldCounts,
  foldSessionCounts: Object.fromEntries(Object.entries(foldSessions).map(([k, v]) => [k, v.size])),
  originalFilesVerified: a.input_versions.reduce((n, s) => n + s.files.length, 0),
  zipCrc: "both passed unzip -t", marketValuesNotUsedForSplitSelection: true };
await fs.writeFile(path.join(out, "verification.json"), JSON.stringify(summary, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(summary, null, 2));
