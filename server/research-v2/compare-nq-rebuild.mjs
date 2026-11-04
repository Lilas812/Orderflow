/** Compare counts/completeness only for NQ. No X/Y distribution inspection. */
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { setPriority } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { parseCsv } from "./csv.mjs";
import { census } from "./rebuild-nq-generation.ts";
import { sessionStartSec } from "../src/vp/state.ts";
const args = process.argv.slice(2), arg = f => args[args.indexOf(f) + 1];
if (!["--old", "--new", "--generation", "--out"].every(f => args.includes(f))) throw Error("old/new/generation/out required");
const old = arg("--old"), fresh = arg("--new"), generation = arg("--generation"), out = path.resolve(arg("--out"));
if (!out.startsWith(path.resolve("data/research-v2") + path.sep)) throw Error("research_output_required");
setPriority(process.pid, 19);
await fs.mkdir(out, { recursive: false, mode: 0o700 });
const json = async (d, n) => JSON.parse(await fs.readFile(path.join(d, n), "utf8"));
async function* rows(d, n) {
  const input = createReadStream(path.join(d, n), { encoding: "utf8", highWaterMark: 65536 });
  const lines = createInterface({ input, crlfDelay: Infinity }); let header;
  try {
    for await (const line of lines) {
      if (!header) { header = line; continue; }
      if (line) yield { line, row: parseCsv(header + "\n" + line + "\n")[0], header };
    }
  } finally { lines.close(); input.destroy(); }
}
const a = await json(old, "manifest.json"), b = await json(fresh, "manifest.json");
assert.equal(a.code.sourceHash, b.code.sourceHash, "calculation source must be unchanged");
assert.equal(a.settings_hash, b.settings_hash);
assert.deepEqual(a.input_versions.find(s => s.symbol === "GC"), b.input_versions.find(s => s.symbol === "GC"));
assert.notEqual(a.input_versions.find(s => s.symbol === "NQ").input_version, b.input_versions.find(s => s.symbol === "NQ").input_version);
const cfg = await json(fresh, "config.json"), prior = await json(old, "config.json");
const resetRoot = structuredClone(cfg); resetRoot.sources[0].root = prior.sources[0].root;
assert.deepEqual(resetRoot, prior, "ONLY NQ root may change");
async function gcSubset(dir) {
  const ids = new Set(), series = new Set(), stats = {};
  for await (const { row } of rows(dir, "samples.csv")) if (row.symbol === "GC") {
    ids.add(row.sample_id);
    for (const r of JSON.parse(row.history_ranges)) series.add(r.series_id);
  }
  for (const name of ["samples.csv", "features.csv", "targets.csv", "history-shared.csv"]) {
    let count = 0, header;
    const h = createHash("sha256");
    for await (const x of rows(dir, name)) {
      header ??= x.header;
      if (name === "history-shared.csv" ? series.has(x.row.series_id) : ids.has(x.row.sample_id)) {
        h.update(x.line + "\n"); count++;
      }
    }
    stats[name] = { count, header, ordered_rows_sha256: h.digest("hex") };
  }
  return stats;
}
const gcOld = await gcSubset(old), gcNew = await gcSubset(fresh);
assert.deepEqual(gcNew, gcOld, "all GC columns/row order must match");
const qa = await json(old, "quality.json"), qb = await json(fresh, "quality.json");
const importInfo = await json(generation, "import.json");
assert.deepEqual(qa.inventory.filter(s => s.symbol === "GC"), qb.inventory.filter(s => s.symbol === "GC"));
// Match LocalStore.labelHourInput(): index coverage WITHOUT its hourly body is
// not certified. Old baseline indexes can contain a pause-hour phantom range.
const coverage = async s => (await json(s.root, "coverage.json")).tick;
const oldTick = await coverage(prior.sources[0]), newTick = await coverage(cfg.sources[0]), gcTick = await coverage(cfg.sources[1]);
async function bodyRanges(source, tick, from, to) {
  const ranges = [];
  for (let h = Math.floor(from / 3600) * 3600; h < to; h += 3600) {
    const date = new Date(h * 1000).toISOString();
    const file = path.join(source.root, "trades", source.symbol, date.slice(0, 10), date.slice(11, 13) + ".jsonl.gz");
    try { await fs.access(file); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    for (const [a, b] of tick) {
      const start = Math.max(a, h, from), end = Math.min(b, h + 3600, to);
      if (start < end) ranges.push([start, end]);
    }
  }
  return ranges;
}
const seconds = ranges => ranges.reduce((n, [a, b]) => n + b - a, 0);
const rawSeconds = (ranges, a, b) => ranges.reduce((n, [x, y]) => n + Math.max(0, Math.min(y, b) - Math.max(x, a)), 0);
const rawSessions = parseCsv(await fs.readFile(path.join(generation, "session-coverage.csv"), "utf8"));
const bodySessions = [], gaps = [];
for (const s of rawSessions) {
  const date = s.ct_date, a = Number(qb.inventory.find(x => x.symbol === "NQ" && x.ct_date === date)?.session_start_us
    ?? qa.inventory.find(x => x.symbol === "GC" && x.ct_date === date)?.session_start_us) / 1e6,
    end = sessionStartSec(a + 27 * 3600);
  assert.ok(Number.isFinite(a));
  const o = await bodyRanges(prior.sources[0], oldTick, a, end);
  const n = await bodyRanges(cfg.sources[0], newTick, a, end), g = await bodyRanges(cfg.sources[1], gcTick, a, end);
  const oldBody = seconds(o), newBody = seconds(n), gcBody = seconds(g);
  const oldQ = qa.inventory.find(x => x.symbol === "NQ" && x.ct_date === date);
  if (oldQ) assert.equal(oldBody, oldQ.coverage_seconds);
  assert.equal(gcBody, qa.inventory.find(x => x.symbol === "GC" && x.ct_date === date).coverage_seconds);
  bodySessions.push({ ct_date: date, old_nq_index_seconds: rawSeconds(oldTick, a, end),
    old_nq_body_seconds: oldBody, new_nq_body_seconds: newBody, gc_index_seconds: rawSeconds(gcTick, a, end),
    gc_body_seconds: gcBody, explained_missing_seconds: Number(s.explained_old_missing_seconds),
    other_missing_seconds: end - a - oldBody - Number(s.explained_old_missing_seconds),
    remaining_new_missing_seconds: end - a - newBody, fixed_grid: s.fixed_grid_includes_session });
  const addGap = (start, stop) => {
    const startUs = start * 1e6, utcHour = new Date(start * 1000).getUTCHours();
    const reason = startUs < importInfo.fromUs || startUs >= importInfo.toUs ? "outside_purchased_query"
      : utcHour === 21 && stop - start === 3600 ? "scheduled_ct16_17_pause_no_certified_body" : "unexplained_source_gap";
    gaps.push({ ct_date: date, from_utc: new Date(start * 1000).toISOString(), to_utc: new Date(stop * 1000).toISOString(), seconds: stop - start, reason });
  };
  let cursor = a;
  for (const [x, y] of n) { if (x > cursor) addGap(cursor, x); cursor = Math.max(cursor, y); }
  if (cursor < end) addGap(cursor, end);
}
const before = new Map(qa.inventory.filter(s => s.symbol === "NQ").map(s => [s.ct_date, s]));
const sessions = [], xs = [], ys = [];
for (const s of qb.inventory.filter(s => s.symbol === "NQ")) {
  const p = before.get(s.ct_date); assert.ok(p); assert.equal(p.samples, s.samples);
  sessions.push({ ct_date: s.ct_date, old_coverage_seconds: p.coverage_seconds, new_coverage_seconds: s.coverage_seconds,
    old_samples: p.samples, new_samples: s.samples, old_reference_missing: p.reference_missing, new_reference_missing: s.reference_missing,
    old_unknown_volume: p.unknown_volume, new_unknown_volume: s.unknown_volume });
  for (const x of Object.keys(s.x_nonnull)) xs.push({ ct_date: s.ct_date, x, old_nonnull: p.x_nonnull[x],
    new_nonnull: s.x_nonnull[x], old_rate: p.x_nonnull_rate[x], new_rate: s.x_nonnull_rate[x] });
  for (const h of Object.keys(s.y_complete)) ys.push({ ct_date: s.ct_date, horizon_seconds: h,
    old_complete: p.y_complete[h], new_complete: s.y_complete[h], old_rate: p.y_complete_rate[h], new_rate: s.y_complete_rate[h] });
}
async function folds(dir) {
  const symbols = new Map(), sessions = new Map(), result = {};
  for await (const { row: r } of rows(dir, "samples.csv")) {
    symbols.set(r.sample_id, r.symbol); sessions.set(r.sample_id, r.session_group);
  }
  const sets = new Map();
  for await (const { row: r } of rows(dir, "splits.csv")) {
    const key = `${symbols.get(r.sample_id)}:${r.fold}:${r.status}:${r.reason}`;
    result[key] ??= { samples: 0, sessions: 0 }; result[key].samples++;
    const s = sets.get(key) ?? new Set(); s.add(sessions.get(r.sample_id)); sets.set(key, s);
  }
  for (const [key, s] of sets) result[key].sessions = s.size;
  return result;
}
const oldFolds = await folds(old), newFolds = await folds(fresh);
assert.deepEqual(oldFolds, newFolds);
const protectedBefore = await json(generation, "protected-before.json");
// Recheck whole protected trees, not only listed files: detect new files.
const protectedRoots = [JSON.parse(await fs.readFile(path.join(generation, "import.json"), "utf8")).archive,
  JSON.parse(await fs.readFile("data/databento-gc-import/active.json", "utf8")).original,
  "data/databento-import/generations", "data/databento-gc-import/generations",
  "data/databento-import/verified-v1", "data/databento-gc-import/verified-v1",
  "data/databento-import/active.json", "data/databento-gc-import/active.json"];
const protectedAfter = await census(protectedRoots);
assert.deepEqual(protectedAfter, protectedBefore);
await fs.writeFile(path.join(out, "protected-after-all-exports.json"), JSON.stringify(protectedAfter, null, 2), { mode: 0o600 });
async function csv(name, data) {
  const keys = Object.keys(data[0]);
  await fs.writeFile(path.join(out, name), keys.join(",") + "\n" +
    data.map(r => keys.map(k => JSON.stringify(r[k])).join(",")).join("\n") + "\n", { mode: 0o600 });
}
await csv("nq-sessions.csv", sessions); await csv("nq-x-nonnull.csv", xs); await csv("nq-y-completeness.csv", ys);
await csv("session-coverage-body-backed.csv", bodySessions); await csv("remaining-gaps.csv", gaps);
const totals = {};
for (const [name, q] of [["old", qa], ["new", qb]]) {
  const ss = q.inventory.filter(s => s.symbol === "NQ");
  totals[name] = { sessions: ss.length, samples: ss.reduce((n, s) => n + s.samples, 0),
    coverage_seconds: ss.reduce((n, s) => n + s.coverage_seconds, 0),
    reference_missing: ss.reduce((n, s) => n + s.reference_missing, 0),
    unknown_volume: ss.reduce((n, s) => n + s.unknown_volume, 0),
    x_nonnull: Object.fromEntries(Object.keys(ss[0].x_nonnull).map(k => [k, ss.reduce((n, s) => n + s.x_nonnull[k], 0)])),
    y_complete: Object.fromEntries(Object.keys(ss[0].y_complete).map(k => [k, ss.reduce((n, s) => n + s.y_complete[k], 0)])) };
}
const result = { pass: true, onlyConfigChange: "NQ root", settings_hash: b.settings_hash, sourceHash: b.code.sourceHash,
  oldInputVersions: a.input_versions.map(({ symbol, input_version }) => ({ symbol, input_version })),
  newInputVersions: b.input_versions.map(({ symbol, input_version }) => ({ symbol, input_version })),
  gc: gcNew, gcExact: true, oldFolds, newFolds, totals,
  coverageExplanationExact: bodySessions.every(s => s.other_missing_seconds === s.remaining_new_missing_seconds),
  indexWithoutBody: bodySessions.filter(s => s.old_nq_index_seconds !== s.old_nq_body_seconds || s.gc_index_seconds !== s.gc_body_seconds),
  unexplainedNewGaps: gaps.filter(s => s.reason === "unexplained_source_gap"),
  protectedFiles: protectedAfter.length, allProtectedUnchanged: true, xYValuesUsedForSelection: false };
await fs.writeFile(path.join(out, "comparison.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
