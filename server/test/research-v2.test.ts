import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { SampleBuilder, digest, X_ALLOWLIST } from "../src/research-v2/engine.ts";
import { exportV2, validateConfig } from "../src/research-v2/export.ts";
import { assignSplits } from "../src/research-v2/splits.ts";
import type { Anchor, Calculation, MarketInput, Tick, Board, Config } from "../src/research-v2/model.ts";
import { hashFile } from "../src/research-v2/snapshot.ts";
import { sessionStartSec } from "../src/vp/state.ts";
import { nextSession } from "../src/labels/features.ts";
import { ENTRIES } from "../src/research-v2/zip.ts";

const a = Date.parse("2026-10-29T22:30:00Z") * 1000;
const calc: Calculation = { mode: "event_time_research", lookbackSeconds: 1800, horizonsSeconds: [60, 300, 900], maxDivergenceEvents: 100_000 };
const anchor: Anchor = { symbol: "NQ", contract: "NQZ6", asOfUs: a };
const proof = (us: number) => ({ basis: "local_arrival_and_finalization" as const, localArrivalUs: us - 1, finalizedUs: us });
function fixture() {
  const ticks: Tick[] = [];
  for (let i = 0; i < 1800; i++) ticks.push({ tsUs: a - (1800 - i) * 1e6 + 1, recvUs: a + 1e6,
    seq: i, price: 100, size: 1, side: "buy", contract: "NQZ6", availability: proof(a - (1799 - i) * 1e6) });
  ticks.push({ ...ticks.at(-1)!, seq: 2000, tsUs: a - 1e6 + 2, side: "unknown", size: 4 });
  const coverage: MarketInput = { ticks: [{ fromUs: a - 1800e6, toUs: a, availability: proof(a) },
    { fromUs: a, toUs: a + 900e6 }], books: [{ fromUs: a - 61e6, toUs: a, availability: proof(a) }] };
  const boards: Board[] = Array.from({ length: 61 }, (_, i) => ({ contract: "NQZ6", availability: proof(a - (60 - i) * 1e6),
    column: { tsSec: a / 1e6 - 61 + i, source: "history", bids: Array.from({ length: 10 }, (_, j) => ({ price: 99 - j, size: 20 })),
      asks: Array.from({ length: 10 }, (_, j) => ({ price: 101 + j, size: 10 })) } }));
  return { ticks, coverage, boards };
}
function build(f = fixture(), config = calc, at = anchor) {
  const b = new SampleBuilder(at, config, f.coverage);
  f.ticks.forEach(t => b.accept(t)); f.boards.forEach(v => b.acceptBoard(v)); return b.finish();
}
test("completed v2 X: every adopted group nonnull and hand-calculated, not null equality", () => {
  const r = build();
  assert.equal(r.reference_price_ticks, 100); assert.equal(r.reference_age_us, "999998");
  for (const [name, expected] of Object.entries({ buy_60s: 60, unknown_60s: 4, total_60s: 64, delta_60s: 60,
    rv_5m: 0, rv_30m: 0, range_30m: 0, distance_session_high: 0, distance_session_low: 0,
    distance_poc: 0, distance_vah: 0, distance_val: 0, cvd_slope_10m: 60, cvd_divergence: 0,
    absorption_buy_60s: 60, absorption_sell_60s: 0, imbalance_1: 1 / 3, imbalance_5: 1 / 3,
    imbalance_10: 1 / 3, near_size: 60, near_change_60s: 0 })) assert.equal(r.x[name], expected, name);
  assert.equal(r.history.at(-1)!.unknown, 4);
  assert.ok(r.targets.every(t => t.endpoint_change_ticks === 0 && t.upward_excursion_ticks === 0));
  assert.ok(X_ALLOWLIST.every(k => !/kind|expectedDirection|confidence|note|priceTicks|futureSeconds|move_/.test(k)));
});
test("all post-as_of prices/quantities/contract/books alter Y, never completed X/history/reference", () => {
  const base = build(), f = fixture();
  f.ticks.push({ ...f.ticks[0]!, tsUs: a, recvUs: a, price: 130, size: 10000 });
  f.boards.push({ contract: "NQH7", column: { tsSec: a / 1e6, source: "history", bids: [], asks: [] } });
  const changed = build(f);
  assert.equal(digest(base.x), digest(changed.x)); assert.equal(digest(base.history), digest(changed.history));
  assert.equal(changed.reference_price_ticks, base.reference_price_ticks);
  assert.equal(changed.targets[0]!.endpoint_change_ticks, 30);
  f.ticks[1801]!.contract = "NQH7";
  const mixed = build(f);
  assert.equal(digest(mixed.x), digest(base.x)); assert.equal(mixed.targets[0]!.missing_reason, "future_contract_changed_or_unknown");
});
test("unknown volume changes VP without directional allocation; exact event-order divergence has a nonzero expected value", () => {
  const f = fixture();
  f.ticks.push({ ...f.ticks.at(-1)!, tsUs: a - 1, seq: 3000, price: 101, size: 2000 });
  const r = build(f);
  assert.equal(r.reference_price_ticks, 101);
  assert.equal(r.x.distance_poc, 0); assert.equal(r.x.distance_val, 1); assert.equal(r.x.distance_vah, 0);
  assert.equal(r.x.unknown_60s, 2004); assert.equal(r.x.delta_60s, 60);
  assert.equal(r.x.rv_5m, 1); assert.equal(r.x.direction_30m, 1);
  const div = fixture();
  for (let i = 1500; i < 1800; i++) div.ticks[i]!.side = "sell";
  div.ticks.push({ ...div.ticks.at(-1)!, tsUs: a - 500e6 + 2, seq: 5000, price: 110, size: 1 });
  div.ticks.push({ ...div.ticks.at(-1)!, tsUs: a - 1, seq: 6000, price: 111 });
  div.ticks.reverse(); // Arrival/event rewind must not change the first extreme's actual CVD.
  assert.equal(build(div).x.cvd_divergence, 1);
  const gc = fixture();
  gc.ticks.forEach(t => t.contract = "GCZ6"); gc.boards.forEach(b => b.contract = "GCZ6");
  assert.equal(build(gc, calc, { ...anchor, symbol: "GC", contract: "GCZ6" }).x.distance_round, 0);
});
test("strict arrival excludes late events and does not promote recvUs or missing aggregate evidence", () => {
  const f = fixture(), strict = { ...calc, mode: "arrival_verified" as const };
  assert.equal(build(f, strict).x.buy_60s, 60);
  f.ticks[1790]!.availability = proof(a + 2);
  const late = build(f, strict);
  assert.equal(late.x.buy_60s, 59); assert.equal(late.history[1790]!.coverage_mask, 1);
  assert.equal(late.history[1790]!.buy, 0); assert.equal(late.audit.verifiedLatePast, 1);
  const oneUnknown = fixture(); delete oneUnknown.ticks[1790]!.availability;
  const uncertain = build(oneUnknown, strict);
  assert.equal(uncertain.x.buy_60s, null); assert.equal(uncertain.x.distance_poc, null);
  assert.equal(uncertain.x.cvd_slope_10m, null); assert.equal(uncertain.history[1790]!.coverage_mask, 0);
  assert.equal(uncertain.history[1790]!.buy, null); assert.equal(uncertain.history[1790]!.close, null);
  assert.equal(uncertain.history[1790]!.missing_reason, "trade_arrival_or_finalization_evidence_missing");
  assert.equal(uncertain.reference_price_ticks, 100); // A later verified price does not cross this unknown second.
  delete oneUnknown.ticks.at(-1)!.availability;
  const lastUnknown = build(oneUnknown, strict);
  assert.equal(lastUnknown.reference_price_ticks, null);
  assert.equal(lastUnknown.reference_reason, "trade_arrival_or_finalization_evidence_missing");
  f.ticks.forEach(t => { delete t.availability; t.recvUs = 0; });
  const r = build(f, strict);
  assert.equal(r.reference_price_ticks, null); assert.equal(r.x.buy_60s, null);
  assert.ok(r.history.every(b => b.coverage_mask === 0 && b.buy === null && b.carried_close === null));
  f.coverage.ticks.forEach(c => { delete c.availability; });
  const unknown = build(f, strict);
  assert.equal(unknown.x.buy_60s, null); assert.ok(unknown.history.every(b => b.buy === null));
});
test("pre-window real price seeds empty leading seconds: hand RV=2, provenance and no fabricated OHLC", () => {
  const f = fixture();
  f.ticks = f.ticks.slice(3);
  f.ticks.push({ ...f.ticks[0]!, tsUs: a - 1800e6 - 1, seq: -1, price: 98 });
  f.coverage.ticks[0]!.fromUs = a - 1801e6;
  const r = build(f);
  assert.equal(r.x.rv_30m, 2); assert.equal(r.x.rv_5m, 0);
  assert.equal(r.history_initial_price_used, 1); assert.equal(r.history_initial_price_ticks, 98);
  assert.equal(r.history_initial_price_ts, String(a - 1800e6 - 1));
  assert.ok(r.history.slice(0, 3).every(h => h.carried_close === 98 && h.carried_from_pre_window === 1 && h.open === null && h.count === 0));
  assert.equal(r.history[3]!.carried_from_pre_window, 0);
  for (const failure of ["gap", "contract", "unknown_arrival", "late"] as const) {
    const bad = structuredClone(f), seed = bad.ticks.at(-1)!;
    if (failure === "gap") bad.coverage.ticks[0]!.fromUs = a - 1800e6;
    if (failure === "contract") seed.contract = "NQH7";
    if (failure === "unknown_arrival") delete seed.availability;
    if (failure === "late") seed.availability = proof(a + 2);
    const b = build(bad, failure === "unknown_arrival" || failure === "late" ? { ...calc, mode: "arrival_verified" } : calc);
    assert.equal(b.x.rv_30m, null, failure); assert.equal(b.history_initial_price_used, 0, failure);
  }
});
test("known empty vs gap, exact duplicate trades, contract change, missing reference, partial outcome", () => {
  const f = fixture();
  f.ticks.push({ ...f.ticks[1799]! });
  assert.equal(build(f).x.buy_60s, 61);
  f.ticks = f.ticks.filter(t => t.tsUs < a - 10e6);
  const quiet = build(f);
  assert.equal(quiet.history.at(-1)!.buy, 0); assert.equal(quiet.history.at(-1)!.open, null);
  assert.equal(quiet.history.at(-1)!.carried, 1);
  f.coverage.ticks[0]!.toUs = a - 1;
  const gap = build(f);
  assert.equal(gap.history.at(-1)!.buy, null); assert.equal(gap.reference_price_ticks, null);
  const roll = fixture(); roll.ticks[1799]!.contract = "UNKNOWN";
  assert.equal(build(roll).x.buy_60s, null);
  const partial = fixture(); partial.coverage.ticks[1]!.toUs = a + 60e6;
  assert.equal(build(partial).targets[0]!.endpoint_change_ticks, 0);
  assert.equal(build(partial).targets[1]!.endpoint_change_ticks, null);
});
test("fractional-second integer-microsecond cutoff, CT17 and DST are real boundaries", () => {
  const f = fixture(), at = { ...anchor, asOfUs: a + 500000 };
  f.ticks.push({ ...f.ticks[0]!, tsUs: at.asOfUs - 1, price: 101 });
  f.ticks.push({ ...f.ticks[0]!, tsUs: at.asOfUs, price: 999 });
  assert.equal(build(f, calc, at).reference_price_ticks, 101);
  assert.ok(build(f, calc, at).history.every(b => Number(b.to_us) <= at.asOfUs));
  const ds = sessionStartSec(Date.parse("2026-11-01T21:30:00Z") / 1000);
  assert.equal(new Date(ds * 1000).toISOString(), "2026-10-31T22:00:00.000Z");
  assert.equal(nextSession(ds) - ds, 25 * 3600);
  const r = build(f, calc, { ...anchor, asOfUs: Date.parse("2026-10-29T22:00:00Z") * 1000 });
  assert.equal(r.x.minutes_from_ct17, 0); assert.equal(r.x.distance_poc, null);
});
test("future target half-open endpoints, both directions, and incomplete board proof", () => {
  const f = fixture();
  for (const [offset, price] of [[0, 105], [59999999, 95], [60e6, 500]] as const)
    f.ticks.push({ ...f.ticks[0]!, tsUs: a + offset, price });
  const r = build(f);
  assert.equal(r.targets[0]!.endpoint_change_ticks, -5);
  assert.equal(r.targets[0]!.upward_excursion_ticks, 5);
  assert.equal(r.targets[0]!.downward_excursion_ticks, 5);
  f.boards.forEach(b => b.contract = null);
  assert.equal(build(f).x.imbalance_1, null);
});
test("splits detect duplicate market sample assignment and train Y overlap, not legitimate past overlap", () => {
  const s = { sample_id: "same", as_of_us: String(a), feature_start_us: String(a - 1800e6), target_end_us: String(a + 900e6) };
  const folds = [{ fold: "train" as const, fromUs: String(a - 1), toUs: String(a + 1) },
    { fold: "test" as const, fromUs: String(a + 30e6), toUs: String(a + 1800e6) }];
  assert.match(assignSplits([s], folds)[0]!.reason!, /train_target_overlaps/);
  folds[1]!.fromUs = String(a);
  assert.match(assignSplits([s], folds)[0]!.reason!, /same_market_sample/);
  assert.equal(assignSplits([{ ...s, as_of_us: String(a + 100e6) }], folds)[0]!.status, "assigned");
  assert.equal(assignSplits([s], null)[0]!.status, "unconfigured");
});
function parseCsv(text: string) {
  const out: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === "," || c === "\n")) { row.push(cell); cell = ""; if (c === "\n") { out.push(row); row = []; } }
    else if (quoted || c !== "\r") cell += c;
  }
  return out;
}
test("actual v2 export: annotation blindness, grid equivalence, dedup, repeat hash, ZIP/IDs/columns and unchanged originals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-v2-test-"));
  try {
    const data = fixture(), ticks = path.join(root, "source/trades/NQ/2026-10-29/22.jsonl.gz");
    await fs.mkdir(path.dirname(ticks), { recursive: true });
    await fs.writeFile(ticks, gzipSync(data.ticks.map(({ availability, ...t }) => JSON.stringify(t)).join("\n") + "\n"));
    await fs.writeFile(path.join(root, "source/coverage.json"), JSON.stringify({ tick: [[a / 1e6 - 1800, a / 1e6 + 900]], book: [] }));
    const labelsFile = path.join(root, "labels.json");
    const labels = [1, 2].map(i => ({ id: String(i), symbol: "NQ", tsSec: a / 1e6, priceTicks: 99,
      kind: "top", expectedDirection: "down", confidence: 2, note: "=test", viewMode: "hindsight", futureSeconds: 60,
      screen: "heatmap", createdUs: a, updatedUs: a }));
    await fs.writeFile(labelsFile, JSON.stringify({ labels }));
    const config: Config = { schema: "orderflow.research.v2.1", calculation: calc, splits: null,
      sources: [{ symbol: "NQ", contract: "NQZ6", root: path.join(root, "source"), sourceKind: "synthetic_test_only",
        asOfUs: [String(a)], grid: { fromUs: String(a), toUs: String(a + 1), stepUs: "1000000" },
        annotationFile: labelsFile, annotationIds: ["1", "2"] }] };
    const before = await hashFile(ticks), code = { revision: "fixture", sourceHash: "fixture" };
    const r1 = await exportV2(config, path.join(root, "a"), code, new AbortController().signal);
    const r2 = await exportV2(config, path.join(root, "b"), code, new AbortController().signal);
    assert.equal(r1.manifest.counts.samples, 1); assert.equal(r1.manifest.counts.annotations, 2);
    assert.equal(r1.zipSha256, r2.zipSha256); assert.equal(r1.manifest.content_hash, r2.manifest.content_hash);
    execFileSync("unzip", ["-t", path.join(r1.directory, "dataset-v2.zip")]);
    assert.deepEqual(execFileSync("unzip", ["-Z", "-1", path.join(r1.directory, "dataset-v2.zip")], { encoding: "utf8" }).trim().split("\n"), [...ENTRIES]);
    for (const file of ["samples", "features", "history", "annotations", "targets", "splits"]) {
      const rows = parseCsv(await fs.readFile(path.join(r1.directory, file + ".csv"), "utf8"));
      assert.ok(rows.every(r => r.length === rows[0]!.length), file);
      const id = rows[0]!.indexOf("sample_id");
      assert.ok(rows.slice(1).every(r => r[id] === rows[1]![id]), file);
    }
    assert.match(await fs.readFile(path.join(r1.directory, "annotations.csv"), "utf8"), /'=test/);
    labels.forEach(l => { l.kind = "failed"; l.expectedDirection = "up"; l.confidence = 1; l.note = "changed"; l.priceTicks = 90000;
      l.viewMode = "live"; l.futureSeconds = 0; l.createdUs = a + 10e6; l.screen = "footprint"; });
    await fs.writeFile(labelsFile, JSON.stringify({ labels }));
    const r3 = await exportV2(config, path.join(root, "c"), code, new AbortController().signal);
    for (const file of ["features.csv", "history.csv"])
      assert.equal(await hashFile(path.join(r1.directory, file)), await hashFile(path.join(r3.directory, file)), file);
    const sample = parseCsv(await fs.readFile(path.join(r3.directory, "samples.csv"), "utf8"));
    assert.equal(sample[1]![sample[0]!.indexOf("reference_price_ticks")], "100");
    assert.notEqual(r1.manifest.content_hash, r3.manifest.content_hash);
    assert.equal(await hashFile(ticks), before);
    assert.ok(!(await fs.readdir(path.join(root, "a"))).some(x => x.startsWith(".v2-working-")));
    const ctrl = new AbortController(), dest = path.join(root, "cancel");
    const job = exportV2(config, dest, code, ctrl.signal); const caught = job.catch(e => e);
    for (let i = 0; i < 50; i++) {
      if ((await fs.readdir(dest).catch(() => [])).some(x => x.startsWith(".v2-working-"))) break;
      await new Promise(r => setTimeout(r, 1));
    }
    ctrl.abort(Error("fixture_cancel"));
    assert.match((await caught).message, /fixture_cancel/);
    assert.deepEqual(await fs.readdir(dest), []);
    await fs.writeFile(ticks, gzipSync("{broken-json}\n"));
    const failed = path.join(root, "failed");
    await assert.rejects(exportV2(config, failed, code, new AbortController().signal));
    assert.deepEqual(await fs.readdir(failed), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("explicit research settings validation has no fitted quantiles or implicit grid", () => {
  const config: Config = { schema: "orderflow.research.v2.1", calculation: calc, sources: [], splits: null };
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, calculation: { ...calc, lookbackSeconds: NaN } }));
});
test("real read path finds a continuous same-contract seed across the preceding hour without modifying input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-v2-test-seed-"));
  try {
    const f = fixture(), source = path.join(root, "source"), directory = path.join(source, "trades/NQ/2026-10-29");
    await fs.mkdir(directory, { recursive: true });
    const seed = { ...f.ticks[0]!, tsUs: a - 1800e6 - 1, price: 98 };
    await fs.writeFile(path.join(directory, "21.jsonl.gz"), gzipSync(JSON.stringify(seed) + "\n"));
    await fs.writeFile(path.join(directory, "22.jsonl.gz"), gzipSync(f.ticks.slice(3).map(t => JSON.stringify(t)).join("\n") + "\n"));
    await fs.writeFile(path.join(source, "coverage.json"), JSON.stringify({ tick: [[a / 1e6 - 1801, a / 1e6 + 900]], book: [] }));
    const before = await hashFile(path.join(directory, "21.jsonl.gz"));
    const c: Config = { schema: "orderflow.research.v2.1", calculation: calc, splits: null,
      sources: [{ symbol: "NQ", contract: "NQZ6", root: source, sourceKind: "synthetic_test_only", asOfUs: [String(a)] }] };
    const out = await exportV2(c, path.join(root, "out"), { revision: "fixture", sourceHash: "fixture" }, new AbortController().signal);
    const rows = parseCsv(await fs.readFile(path.join(out.directory, "features.csv"), "utf8"));
    assert.equal(rows[1]![rows[0]!.indexOf("rv_30m")], "2");
    const samples = parseCsv(await fs.readFile(path.join(out.directory, "samples.csv"), "utf8"));
    assert.equal(samples[1]![samples[0]!.indexOf("history_initial_price_used")], "1");
    assert.equal(await hashFile(path.join(directory, "21.jsonl.gz")), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
