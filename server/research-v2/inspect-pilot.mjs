import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { readTable } from "./csv.mjs";
const args = process.argv.slice(2), arg = flag => args[args.indexOf(flag) + 1];
if (!["--dataset", "--out"].every(f => args.includes(f) && arg(f)))
  throw Error("usage: inspect-pilot.mjs --dataset DATASET_DIR --out NEW_EVIDENCE_JSON");
const dir = path.resolve(arg("--dataset")), csv = name => readTable(dir, name);
const samples = await csv("samples"), history = await csv("history"), features = await csv("features"), targets = await csv("targets");
const manifest = JSON.parse(await fs.readFile(`${dir}/manifest.json`, "utf8"));
const quality = JSON.parse(await fs.readFile(`${dir}/quality.json`, "utf8"));
const config = JSON.parse(await fs.readFile(`${dir}/config.json`, "utf8"));
assert.equal(config.calculation.mode, "event_time_research", "raw event-time verification only; no legacy arrival proof");
const proof = [], scanned = new Set();
const newer = (x, y) => !y || x.tsUs > y.tsUs || x.tsUs === y.tsUs && x.seq >= y.seq;
const older = (x, y) => !y || x.tsUs < y.tsUs || x.tsUs === y.tsUs && x.seq <= y.seq;
for (const s of samples) {
  const start = Number(s.feature_start_us), asof = Number(s.as_of_us), end = Number(s.target_end_us);
  const source = config.sources.find(v => v.symbol === s.symbol && v.contract === s.contract);
  const bars = Array.from({ length: config.calculation.lookbackSeconds }, () => ({ count: 0, buy: 0, sell: 0, unknown: 0, first: null, last: null, high: -Infinity, low: Infinity }));
  const ys = config.calculation.horizonsSeconds.map(h => ({ h, last: null, high: Number(s.reference_price_ticks), low: Number(s.reference_price_ticks) }));
  let reference = null, seed = null;
  const scanStart = s.history_initial_price_used === "1" ? Math.min(start, Number(s.history_initial_price_ts)) : start;
  for (let hour = Math.floor(scanStart / 3600e6) * 3600e6; hour < end; hour += 3600e6) {
    const iso = new Date(hour / 1000).toISOString();
    const file = path.join(source.root, `trades/${s.symbol}/${iso.slice(0, 10)}/${iso.slice(11, 13)}.jsonl.gz`);
    scanned.add(file);
    const input = createReadStream(file), unzip = createGunzip(), lines = createInterface({ input: input.pipe(unzip), crlfDelay: Infinity });
    input.on("error", e => unzip.destroy(e));
    try {
      for await (const line of lines) {
        if (!line) continue; const t = JSON.parse(line);
        if (t.tsUs < scanStart || t.tsUs >= end) continue;
        assert.equal(t.contract, s.contract);
        if (t.tsUs < start) { if (newer(t, seed)) seed = t; continue; }
        if (t.tsUs < asof) {
          if (newer(t, reference)) reference = t;
          const b = bars[Math.floor((t.tsUs - start) / 1e6)];
          b.count++; b[t.side] += t.size; b.high = Math.max(b.high, t.price); b.low = Math.min(b.low, t.price);
          if (older(t, b.first)) b.first = t; if (newer(t, b.last)) b.last = t;
        } else for (const y of ys) if (t.tsUs < asof + y.h * 1e6) {
          if (newer(t, y.last)) y.last = t; y.high = Math.max(y.high, t.price); y.low = Math.min(y.low, t.price);
        }
      }
    } finally { lines.close(); unzip.destroy(); input.destroy(); }
  }
  reference ??= seed;
  assert.equal(reference.price, Number(s.reference_price_ticks)); assert.equal(String(reference.tsUs), s.reference_price_ts);
  const coverageFile = path.join(source.root, "coverage.json");
  const ranges = JSON.parse(await fs.readFile(coverageFile, "utf8")).tick;
  scanned.add(coverageFile);
  function contiguous(from, to) {
    let cursor = from;
    for (const [a, b] of [...ranges].sort((u, v) => u[0] - v[0])) {
      if (b * 1e6 <= cursor) continue;
      if (a * 1e6 > cursor) return false;
      cursor = b * 1e6; if (cursor >= to) return true;
    }
    return cursor >= to;
  }
  assert.ok(contiguous(reference.tsUs, asof), "reference continuity");
  assert.ok(contiguous(start, end), "history/target continuous coverage");
  if (seed) assert.ok(contiguous(seed.tsUs, start), "pre-window seed continuity");
  const hist = history.filter(h => h.sample_id === s.sample_id);
  assert.equal(hist.length, bars.length);
  const sums = { count: 0, buy: 0, sell: 0, unknown: 0 };
  let carry = seed?.price ?? null, fromSeed = !!seed, rv30 = 0, previous = null;
  bars.forEach((b, i) => {
    const row = hist[i]; assert.equal(row.coverage_mask, "1"); assert.equal(row.contract_mask, "1");
    for (const k of Object.keys(sums)) { assert.equal(Number(row[k]), b[k], `${s.symbol} ${i} ${k}`); sums[k] += b[k]; }
    for (const [key, value] of Object.entries({ open: b.first?.price, close: b.last?.price,
      high: b.count ? b.high : null, low: b.count ? b.low : null })) assert.equal(row[key], value == null ? "" : String(value));
    if (b.last) { carry = b.last.price; fromSeed = false; }
    assert.equal(row.carried_close, carry === null ? "" : String(carry));
    if ("carried_from_pre_window" in row) assert.equal(Number(row.carried_from_pre_window), +(!b.last && fromSeed));
    if (i >= bars.length - 1800) {
      if (carry === null || (i > bars.length - 1800 && previous === null)) rv30 = NaN;
      else if (i > bars.length - 1800) rv30 += (carry - previous) ** 2;
    }
    previous = carry;
  });
  for (const y of ys) {
    const row = targets.find(t => t.sample_id === s.sample_id && Number(t.horizon_seconds) === y.h);
    const ref = Number(s.reference_price_ticks);
    assert.equal(Number(row.endpoint_change_ticks), (y.last?.price ?? ref) - ref);
    assert.equal(Number(row.upward_excursion_ticks), y.high - ref);
    assert.equal(Number(row.downward_excursion_ticks), ref - y.low);
    assert.equal(row.observation_end_us, String(asof + y.h * 1e6));
  }
  const q = quality.samples.find(q => q.sample_id === s.sample_id), x = features.find(x => x.sample_id === s.sample_id);
  if (bars.length >= 1800) assert.equal(x.rv_30m, Number.isFinite(rv30) ? String(Math.sqrt(rv30)) : "");
  if (s.history_initial_price_used === "1") {
    assert.equal(s.history_initial_price_ticks, String(seed.price));
    assert.equal(s.history_initial_price_ts, String(seed.tsUs));
  }
  proof.push({ symbol: s.symbol, contract: s.contract, asOf: new Date(asof / 1000).toISOString(),
    referenceTicks: s.reference_price_ticks, referenceAgeUs: s.reference_age_us, historySeconds: hist.length, sums,
    adoptedXNonnull: q.x_nonnull, adoptedXCount: manifest.x_allowlist.length, total60: x.total_60s,
    unknown60: x.unknown_60s, delta60: x.delta_60s, historyAndReferenceMatched: true, allThreeTargetsMatched: true,
    rv30: x.rv_30m || null, initialPriceUsed: s.history_initial_price_used ?? "0",
    marketScan: q.market_audit, missing: q.feature_missing });
}
for (const file of scanned) {
  const p = manifest.input.flatMap(v => v.files).find(p => p.path === file); assert.ok(p, "scanned file in frozen input manifest");
  const h = createHash("sha256"); for await (const b of createReadStream(file)) h.update(b);
  assert.equal(h.digest("hex"), p.sha256);
}
const result = { code: manifest.code, samples: proof, sourceFilesRescanned: scanned.size,
  inputUnchanged: true, zipBytes: (await fs.stat(`${dir}/dataset-v2.zip`)).size };
await fs.mkdir(path.dirname(arg("--out")), { recursive: true, mode: 0o700 });
await fs.writeFile(arg("--out"), JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(result));
