/** Stream row-identity checks only: never inspect X distributions or Y outcomes. */
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { setPriority } from "node:os";
import { parseCsv } from "./csv.mjs";
import { addNqCt1026, CT1026 } from "./add-nq-ct1026.ts";
import { historyRanges } from "../src/research-v2/history.ts";
import { census } from "./rebuild-nq-generation.ts";
const args = process.argv.slice(2), arg = flag => args[args.indexOf(flag) + 1];
assert.ok(["--old", "--new", "--audit", "--out"].every(f => args.includes(f)), "old/new/audit/out required");
const old = arg("--old"), fresh = arg("--new"), audit = arg("--audit"), out = path.resolve(arg("--out"));
assert.ok(out.startsWith(path.resolve("data/research-v2") + path.sep), "research output only");
setPriority(process.pid, 19);
const started = performance.now(), cpuStart = process.cpuUsage();
const json = async (d, f) => JSON.parse(await fs.readFile(path.join(d, f), "utf8"));
async function* lines(dir, name) {
  const stream = createReadStream(path.join(dir, name), { encoding: "utf8", highWaterMark: 65536 });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of reader) yield line; }
  finally { reader.close(); stream.destroy(); }
}
async function* rows(dir, file) {
  let header;
  for await (const line of lines(dir, file)) {
    if (!header) { header = line; continue; }
    if (line) yield parseCsv(header + "\n" + line + "\n")[0];
  }
}
const a = await json(old, "manifest.json"), b = await json(fresh, "manifest.json");
assert.equal(a.code.sourceHash, b.code.sourceHash);
assert.equal(a.settings_hash, b.settings_hash);
assert.deepEqual(a.input_versions, b.input_versions);
assert.deepEqual(await json(fresh, "config.json"), addNqCt1026(await json(old, "config.json")));
const existing = new Map(), added = new Map(), counts = {}, sessionSets = {};
for await (const s of rows(old, "samples.csv")) existing.set(s.sample_id, s.symbol);
const splitIterator = rows(fresh, "splits.csv")[Symbol.asyncIterator]();
let seen = 0;
for await (const s of rows(fresh, "samples.csv")) {
  const r = (await splitIterator.next()).value; assert.ok(r);
  assert.equal(r.sample_id, s.sample_id); assert.equal(r.status, "assigned");
  const key = `${s.symbol}:${r.fold}`;
  counts[key] = (counts[key] ?? 0) + 1;
  (sessionSets[key] ??= new Set()).add(s.session_group);
  if (existing.has(s.sample_id)) { assert.equal(s.symbol, existing.get(s.sample_id)); seen++; continue; }
  assert.equal(s.symbol, "NQ"); assert.equal(s.contract, "NQZ26");
  const t = Number(s.as_of_us);
  assert.ok(t >= Number(CT1026.fromUs) && t < Number(CT1026.toUs));
  assert.equal((t - Number(CT1026.fromUs)) % Number(CT1026.stepUs), 0);
  assert.ok(!added.has(s.sample_id)); added.set(s.sample_id, s.as_of_us);
  assert.equal(r.fold, "test");
}
assert.equal((await splitIterator.next()).done, true);
assert.equal(seen, existing.size); assert.equal(added.size, 1440);
assert.equal(new Set(added.values()).size, 1440);
// Hash all columns verbatim, preserving order and legitimate equal observations.
const unchanged = {}, addedRows = {};
for (const file of ["samples.csv", "features.csv", "targets.csv", "splits.csv"]) {
  const digests = [];
  for (const dir of [old, fresh]) {
    const hashes = { NQ: createHash("sha256"), GC: createHash("sha256") }, sizes = { NQ: 0, GC: 0 };
    let header, extras = 0;
    for await (const line of lines(dir, file)) {
      if (!header) { header = line; continue; }
      if (!line) continue;
      const id = line.slice(0, line.indexOf(","));
      const symbol = existing.get(id);
      if (symbol) { hashes[symbol].update(line + "\n"); sizes[symbol]++; }
      else { assert.equal(dir, fresh); assert.ok(added.has(id), "unexpected added sample"); extras++; }
    }
    digests.push({ header, NQ: { count: sizes.NQ, sha256: hashes.NQ.digest("hex") },
      GC: { count: sizes.GC, sha256: hashes.GC.digest("hex") } });
    if (dir === fresh) addedRows[file] = extras;
  }
  assert.deepEqual(digests[0], digests[1], file + ": existing rows changed");
  assert.equal(addedRows[file], file === "targets.csv" ? 4320 : 1440);
  unchanged[file] = digests[1];
}
// Compact interval indexes, not millions of raw row keys, identify old seconds.
const ranges = new Map(), seriesSymbol = new Map(), historyStats = [];
for await (const s of rows(old, "samples.csv")) for (const r of JSON.parse(s.history_ranges)) {
  const symbol = seriesSymbol.get(r.series_id);
  assert.ok(!symbol || symbol === s.symbol); seriesSymbol.set(r.series_id, s.symbol);
}
const version = b.input_versions.find(s => s.symbol === "NQ").input_version;
const allowed = historyRanges(version, "NQ", "NQZ26", Number(CT1026.fromUs) - 1800e6,
  Number(CT1026.toUs) - Number(CT1026.stepUs));
let newSeconds = 0;
for (const dir of [old, fresh]) {
  const hashes = { NQ: createHash("sha256"), GC: createHash("sha256") }, sizes = { NQ: 0, GC: 0 };
  let header;
  for await (const line of lines(dir, "history-shared.csv")) {
    if (!header) { header = line; continue; }
    if (!line) continue;
    const i = line.indexOf(","), j = line.indexOf(",", i + 1), k = line.indexOf(",", j + 1);
    const id = line.slice(0, i), from = Number(line.slice(i + 1, j)), to = Number(line.slice(j + 1, k));
    assert.equal(to - from, 1e6);
    let intervals = ranges.get(id);
    if (dir === old) {
      if (!intervals) ranges.set(id, intervals = []);
      if (intervals.at(-1)?.[1] === from) intervals.at(-1)[1] = to;
      else { assert.ok(!intervals.length || intervals.at(-1)[1] <= from); intervals.push([from, to]); }
    }
    const retained = dir === old || intervals?.some(([a, b]) => from >= a && to <= b);
    if (retained) {
      const symbol = seriesSymbol.get(id); assert.ok(symbol === "NQ" || symbol === "GC");
      hashes[symbol].update(line + "\n"); sizes[symbol]++;
    } else {
      assert.ok(allowed.some(r => id === r.series_id && from >= Number(r.from_us) && to <= Number(r.to_us)),
        "extra history outside the added NQ windows");
      newSeconds++;
    }
  }
  historyStats.push({ header, NQ: { count: sizes.NQ, sha256: hashes.NQ.digest("hex") },
    GC: { count: sizes.GC, sha256: hashes.GC.digest("hex") } });
}
assert.deepEqual(historyStats[0], historyStats[1], "existing shared seconds changed");
unchanged["history-shared.csv"] = historyStats[1]; addedRows["history-shared.csv"] = newSeconds;
assert.equal(b.counts.samples - a.counts.samples, 1440);
assert.equal(b.counts.sharedHistoryRows - a.counts.sharedHistoryRows, newSeconds);
const before = await json(audit, "before.json"), after = await census(before.roots);
assert.deepEqual(after, before.files, "protected originals/generations/previous outputs/config changed");
await fs.mkdir(out, { recursive: false, mode: 0o700 });
await fs.writeFile(path.join(out, "protected-after.json"), JSON.stringify(after, null, 2), { flag: "wx", mode: 0o600 });
const result = { pass: true, sourceHash: b.code.sourceHash, settings_hash: b.settings_hash,
  inputVersionsUnchanged: true, onlyConfigChange: "NQ CT10/26 1440 anchors", unchanged, addedRows,
  samples: b.counts.samples, addedSampleBounds: CT1026, foldSamples: counts,
  foldSessions: Object.fromEntries(Object.entries(sessionSets).map(([k, v]) => [k, v.size])),
  protectedFiles: after.length, allProtectedUnchanged: true, outcomeOrFeatureDistributionsInspected: false,
  metrics: { elapsedMs: performance.now() - started, cpuUs: process.cpuUsage(cpuStart), peakRssKiB: process.resourceUsage().maxRSS } };
await fs.writeFile(path.join(out, "comparison.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
