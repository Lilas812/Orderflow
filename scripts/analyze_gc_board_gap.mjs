/** Read-only GCZ26/app comparison. Only new ignored diagnostic/copy files are written. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ReplitObjects, digest } from "../server/src/store/objects.ts";
import { columnFileRange, tradeFileEntries } from "../server/src/store/records.ts";
import { Distribution, packed, bbo, overlap, counter, count, rates } from "./gc_board_metrics.mjs";

if (os.getPriority() < 19) throw Error("run_with_nice_-n_19");
const root = path.resolve("data/research-v2/mbo-01"), dir = path.join(root, "board-diagnostics");
const copy = path.join(root, "cloud-copy"), day = "2026-11-03";
fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(copy, { recursive: true });
const sampling = JSON.parse(fs.readFileSync(path.join(dir, "sampling.json")));
const sampleMaps = Object.fromEntries(Object.entries(sampling.rows).map(([key, rows]) =>
  [key, new Map(rows.map(([sec, bid, ask]) => [sec, { bids: [bid, 0], asks: [ask, 0] }]))]));
const cloud = new ReplitObjects(), provenanceFile = path.join(dir, "objects.json");
const provenance = fs.existsSync(provenanceFile) ? JSON.parse(fs.readFileSync(provenanceFile)) : [];
async function copied(name, basename) {
  const file = path.join(copy, basename);
  let row = provenance.find(x => x.name === name);
  if (!row) {
    let generation;
    try { generation = await cloud.downloadVersion(name, file); }
    catch { throw Error("read_only_object_download_failed:" + name); }
    row = { name, file: path.relative(root, file), generation, exists: generation !== null };
    if (row.exists) row.sha256 = await digest(file);
    provenance.push(row); fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2));
  }
  if (!row.exists) return null;
  if (await digest(file) !== row.sha256) throw Error("copy_hash_mismatch");
  return file;
}
async function load(file, start, end) {
  const map = new Map();
  if (file && fs.existsSync(file)) for await (const c of columnFileRange(file, start, end)) map.set(c.tsSec, packed(c));
  return map;
}
const shift = Object.fromEntries(Array.from({ length: 11 }, (_, i) =>
  [i - 5, { available: counter(), fixedCohort: counter() }]));
const depth = Object.fromEntries([10, 50].map(n => [n, Object.fromEntries(["bids", "asks"].map(side =>
  [side, { a: 0, b: 0, shared: 0, union: 0, missingPrice: 0,
    ratioAll: new Distribution(), ratioCommon: new Distribution() }]))]));
const sampleCounts = Object.fromEntries(Object.keys(sampleMaps).map(key => [key, counter()]));
const sampleFixed = Object.fromEntries(Object.keys(sampleMaps).map(key => [key, counter()]));
const bidDifference = new Distribution(), askDifference = new Distribution(), appSpread = new Distribution(), mboSpread = new Distribution();
const report = { day, rangeUtc: ["2026-11-03T13:00:00Z", "2026-11-04T00:00:00Z"],
  shiftConvention: "app time + delta seconds; compare app(t) with MBO(t+delta); integer-second resolution",
  quantityConvention: "MBO/App at each app top-N price; missing MBO price = 0, with separate shared-price-only quantiles",
  sourceCounts: {}, sourceMatches: {}, contractCounts: {}, contractMissing: 0, tradeCount: 0, rows: [],
  samplingAgainstDense: counter(), appMoreAggressiveBoth: 0, appLessAggressiveEither: 0 };
let fixedEligible = 0;
for (let hh = 13; hh < 24; hh++) {
  const hour = String(hh).padStart(2, "0"), start = Date.parse(`${day}T${hour}:00:00Z`) / 1000, end = start + 3600;
  const name = `prod/instruments/GC/columns/GC/1s/${day}/${hour}.bin.gz`;
  const appFile = await copied(name, `${day}-${hour}.bin.gz`);
  if (!appFile) throw Error("comparison_app_hour_missing");
  const app = await load(appFile, start, end), mbo = new Map();
  for (let h = hh - 1; h <= hh + 1 && h < 24; h++) {
    const file = path.join(root, "rebuilt/GCZ26", day, String(h).padStart(2, "0") + ".bin.gz");
    for (const [sec, c] of await load(file, start - 5, end + 5)) mbo.set(sec, c);
  }
  const local = counter(), localSamples = Object.fromEntries(Object.keys(sampleMaps).map(k => [k, counter()]));
  for (const [sec, a] of app) {
    report.sourceCounts[a.source] = (report.sourceCounts[a.source] ?? 0) + 1;
    const fixed = Object.keys(shift).every(delta => bbo(a, mbo.get(sec + +delta)));
    if (fixed) fixedEligible++;
    for (const [delta, metric] of Object.entries(shift)) {
      const match = bbo(a, mbo.get(sec + +delta));
      count(metric.available, match); if (fixed) count(metric.fixedCohort, match);
    }
    const b = mbo.get(sec), match = bbo(a, b);
    if (!match) continue;
    count(local, match);
    report.sourceMatches[a.source] ??= counter();
    count(report.sourceMatches[a.source], match);
    const samplesFixed = Object.values(sampleMaps).every(map => bbo(a, map.get(sec)));
    for (const [key, map] of Object.entries(sampleMaps)) {
      const matchSample = bbo(a, map.get(sec));
      count(localSamples[key], matchSample); count(sampleCounts[key], matchSample);
      if (samplesFixed) count(sampleFixed[key], matchSample);
    }
    count(report.samplingAgainstDense, bbo(sampleMaps.eventLast.get(sec), b));
    bidDifference.add(a.bids[0] - b.bids[0]); askDifference.add(a.asks[0] - b.asks[0]);
    appSpread.add(a.asks[0] - a.bids[0]); mboSpread.add(b.asks[0] - b.bids[0]);
    if (a.bids[0] >= b.bids[0] && a.asks[0] <= b.asks[0]) report.appMoreAggressiveBoth++;
    if (a.bids[0] < b.bids[0] || a.asks[0] > b.asks[0]) report.appLessAggressiveEither++;
    for (const [n, sides] of Object.entries(depth)) for (const side of ["bids", "asks"]) {
      const x = overlap(a[side], b[side], +n), target = sides[side];
      for (const k of ["a", "b", "shared", "union"]) target[k] += x[k];
      for (const r of x.ratios) {
        target.ratioAll.add(r.value);
        if (r.sharedPrice) target.ratioCommon.add(r.value); else target.missingPrice++;
      }
    }
  }
  report.rows.push({ hour, appSeconds: app.size, baseline: rates(local),
    sampling: Object.fromEntries(Object.entries(localSamples).map(([k,v]) => [k, rates(v)])) });
  const tradeFile = await copied(`prod/instruments/GC/trades/GC/${day}/${hour}.jsonl.gz`, `${day}-${hour}-trades.jsonl.gz`);
  if (tradeFile) for await (const { trade } of tradeFileEntries(tradeFile, new AbortController().signal)) {
    if (trade.tsUs < start * 1e6 || trade.tsUs >= end * 1e6) throw Error("trade_outside_hour");
    report.tradeCount++;
    if (trade.contract) report.contractCounts[trade.contract] = (report.contractCounts[trade.contract] ?? 0) + 1;
    else report.contractMissing++;
  }
  console.log(JSON.stringify({ hour, compared: local.seconds, both: rates(local).bothRate }));
}
report.fixedEligibleSeconds = fixedEligible;
report.sourceMatches = Object.fromEntries(Object.entries(report.sourceMatches).map(([k,v]) => [k, rates(v)]));
report.shifts = Object.fromEntries(Object.entries(shift).map(([d,v]) =>
  [d, { available: rates(v.available), fixedCohort: rates(v.fixedCohort) }]));
report.bestShift = Object.entries(report.shifts).sort((a,b) =>
  (b[1].fixedCohort.bothRate ?? -1) - (a[1].fixedCohort.bothRate ?? -1) || Math.abs(+a[0]) - Math.abs(+b[0]))[0][0];
report.sampling = Object.fromEntries(Object.keys(sampleMaps).map(k =>
  [k, { available: rates(sampleCounts[k]), sameCohort: rates(sampleFixed[k]) }]));
report.samplingAgainstDense = rates(report.samplingAgainstDense);
report.depth = Object.fromEntries(Object.entries(depth).map(([n,sides]) => [n,
  Object.fromEntries(Object.entries(sides).map(([side,v]) => [side, { ...v, appTopNRecall: v.shared / v.a,
    mboTopNRecall: v.shared / v.b, jaccard: v.shared / v.union,
    ratioAll: v.ratioAll.result(), ratioCommon: v.ratioCommon.result() }]))]));
report.priceDifferenceTicks = { bidAppMinusMbo: bidDifference.result(), askAppMinusMbo: askDifference.result(),
  appSpread: appSpread.result(), mboSpread: mboSpread.result() };
report.inputRawSha256 = sampling.inputSha256;
report.finishedAtUtc = new Date().toISOString();
fs.writeFileSync(path.join(dir, "comparison.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ baseline: report.shifts[0].available, bestShift: report.bestShift,
  best: report.shifts[report.bestShift], tradeCount: report.tradeCount, contractCounts: report.contractCounts }));
