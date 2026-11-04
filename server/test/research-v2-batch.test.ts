import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { SampleBuilder, digest } from "../src/research-v2/engine.ts";
import { BatchCalculator, streamBatch, type Result } from "../src/research-v2/batch.ts";
import { sharedRow, reconstructHistory, historyRanges } from "../src/research-v2/history.ts";
import { assertInputVersions, freezeInput } from "../src/research-v2/inventory.ts";
import { Snapshot } from "../src/research-v2/snapshot.ts";
import { exportBulk } from "../src/research-v2/bulk-export.ts";
import { assignSplits } from "../src/research-v2/splits.ts";
import { orderedHour } from "../src/research-v2/ordered.ts";
import type { Tick, MarketInput, Calculation, Config, Source } from "../src/research-v2/model.ts";
import { execFileSync } from "node:child_process";
const start = Date.parse("2026-10-28T22:00:00Z") * 1000;
const calculation: Calculation = { mode: "event_time_research", lookbackSeconds: 1800, horizonsSeconds: [60, 300, 900], maxDivergenceEvents: 100_000 };
const source = { symbol: "GC", contract: "GCZ26" } as const;
function fixture() {
  const ticks: Tick[] = [];
  for (let i = -1900; i < 6000; i++) if (i % 11 !== 0) {
    ticks.push({ tsUs: start + i * 1e6 + 21, recvUs: start + i * 1e6 + 21, seq: i + 1900,
      price: 40000 + (Math.floor(i / 20) % 21), size: Math.abs(i % 3) + 1,
      side: i % 5 === 0 ? "unknown" : i % 2 === 0 ? "buy" : "sell", contract: i === 2201 ? "GCG27" : "GCZ26" });
  }
  const input: MarketInput = { ticks: [{ fromUs: start - 2000e6, toUs: start + 1200e6 },
    { fromUs: start + 1202e6, toUs: start + 8000e6 }], books: [] };
  return { ticks, input };
}
function market(r: Result) { const { audit: _a, ...rest } = r; return rest; }
async function batch(anchors: number[], ticks: Tick[], input: MarketInput) {
  const rows = new Map<number, Result>(), signal = new AbortController().signal;
  const c = new BatchCalculator(source, anchors, calculation, input, async (a, r) => { rows.set(a, r); }, signal);
  for (const t of [...ticks].sort((a, b) => a.tsUs - b.tsUs || a.seq - b.seq)) {
    await c.watermark(Math.floor(t.tsUs / 1e6) * 1e6); c.accept(t);
  }
  await c.watermark(anchors.at(-1)! + 900e6); return { rows, metrics: c.metrics };
}
test("batch equals reference X/reference/history/Y/reasons across CT17, gaps, contract changes, known empty, initial price", async () => {
  const f = fixture(), anchors = [start, start + 60e6, start + 1800e6, start + 2400e6, start + 3600e6];
  const actual = await batch(anchors, f.ticks, f.input);
  for (const a of anchors) {
    const oracle = new SampleBuilder({ ...source, asOfUs: a }, calculation, f.input);
    f.ticks.forEach(t => oracle.accept(t));
    assert.deepEqual(market(actual.rows.get(a)!), market(oracle.finish()), String(a));
    const r = actual.rows.get(a)!;
    assert.deepEqual(reconstructHistory(r.history.map(sharedRow), r), r.history);
  }
  assert.ok(actual.metrics.maxSeconds <= 2701);
});
test("grid addition/removal cannot change any remaining market output, including initial-price provenance", async () => {
  const f = fixture(), common = [start + 1800e6, start + 3600e6];
  const a = await batch(common, f.ticks, f.input), b = await batch([start, start + 60e6, ...common], f.ticks, f.input);
  for (const t of common) assert.deepEqual(market(a.rows.get(t)!), market(b.rows.get(t)!));
});
test("shared range splits at actual CT17/DST; incompatible input editions are rejected", () => {
  const a = Date.parse("2026-11-01T23:10:00Z") * 1000, rows = historyRanges("a".repeat(64), "GC", "GCZ26", a - 1800e6, a);
  assert.equal(rows.length, 2); assert.equal(rows[0]!.to_us, String(Date.parse("2026-11-01T23:00:00Z") * 1000));
  assert.doesNotThrow(() => assertInputVersions([{ ...source, input_version: "a".repeat(64) }, { ...source, input_version: "a".repeat(64) }]));
  assert.throws(() => assertInputVersions([{ ...source, input_version: "a".repeat(64) }, { ...source, input_version: "b".repeat(64) }]), /incompatible/);
});
test("validation Y intrusion into test is excluded; exact half-open boundary is allowed", () => {
  const s = (t: number) => ({ sample_id: String(t), as_of_us: String(t), feature_start_us: "0", target_end_us: String(t + 900e6) });
  const boundary = start + 3600e6, config: Config["splits"] = [
    { fold: "validation", fromUs: String(start), toUs: String(boundary) },
    { fold: "test", fromUs: String(boundary), toUs: String(boundary + 3600e6) }];
  assert.equal(assignSplits([s(boundary - 900e6)], config)[0]!.status, "assigned");
  assert.equal(assignSplits([s(boundary - 899e6)], config)[0]!.reason, "validation_target_overlaps_test_judgment_interval");
});
test("integer batch refuses fractional/oversized anchors rather than silently thinning", () => {
  assert.throws(() => new BatchCalculator(source, [start + 1], calculation, { ticks: [], books: [] }, async () => {}, new AbortController().signal));
  assert.throws(() => new BatchCalculator(source, Array.from({ length: 100001 }, (_, i) => start + i * 1e6),
    calculation, { ticks: [], books: [] }, async () => {}, new AbortController().signal), /bounded/);
});
test("batch's event-order sufficient statistics retain nonzero bearish divergence, not equality of missing cells", async () => {
  const prices = [40000, 40005, 40004, 40006], offsets = [-590, -580, -290, -280];
  const ticks: Tick[] = prices.map((price, i) => ({ price, tsUs: start + offsets[i]! * 1e6, recvUs: start + offsets[i]! * 1e6,
    size: i === 2 ? 5 : 10, seq: i, side: i < 2 ? "buy" : "sell", contract: "GCZ26" }));
  const input: MarketInput = { ticks: [{ fromUs: start - 3600e6, toUs: start + 3600e6 }], books: [] };
  const actual = (await batch([start], ticks, input)).rows.get(start)!;
  assert.equal(actual.x.cvd_divergence, 1);
  const ref = new SampleBuilder({ ...source, asOfUs: start }, calculation, input); ticks.forEach(t => ref.accept(t));
  assert.deepEqual(market(actual), market(ref.finish()));
});
test("external stable sorting crosses a 25000-row run boundary; early return and failure release only owned runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-sort-fixture-"));
  try {
    const file = path.join(dir, "input.gz");
    const rows: Tick[] = Array.from({ length: 26_002 }, (_, i) => ({ tsUs: start + (26002 - Math.floor(i / 2)),
      recvUs: start + 30000, seq: i % 3, price: 40000 + i, size: 1, side: "unknown", contract: "GCZ26" }));
    await fs.writeFile(file, gzipSync(rows.map(t => JSON.stringify(t)).join("\n") + "\n"));
    const expected = [...rows].sort((a, b) => a.tsUs - b.tsUs || a.seq - b.seq);
    const actual: Tick[] = [];
    for await (const t of orderedHour(file, dir, new AbortController().signal)) actual.push(t);
    assert.deepEqual(actual, expected);
    for await (const _ of orderedHour(file, dir, new AbortController().signal)) break;
    assert.deepEqual(await fs.readdir(dir), ["input.gz"]);
    await fs.writeFile(file, "not gzip");
    await assert.rejects(async () => { for await (const _ of orderedHour(file, dir, new AbortController().signal)) {} });
    assert.deepEqual(await fs.readdir(dir), ["input.gz"]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("real gzip path is decoded once per hour, stable duplicates/rewind match oracle; export repeats, input edition changes, cancellation owns cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-batch-fixture-"));
  try {
    const s: Source = { ...source, root: path.join(root, "input"), sourceKind: "synthetic_fixture_only", asOfUs: [String(start + 1800e6), String(start + 1860e6)] };
    const f = fixture(), groups = new Map<string, Tick[]>();
    for (const t of f.ticks) {
      const date = new Date(t.tsUs / 1000).toISOString(), suffix = `${date.slice(0, 10)}/${date.slice(11, 13)}.jsonl.gz`;
      let rows = groups.get(suffix); if (!rows) groups.set(suffix, rows = []); rows.push(t);
    }
    for (const [suffix, rows] of groups) {
      const file = path.join(s.root, "trades/GC", suffix); await fs.mkdir(path.dirname(file), { recursive: true });
      const reversed = [...rows].reverse(); reversed.push({ ...rows[0]! }); // Legitimate identical separate trade, retained.
      await fs.writeFile(file, gzipSync(reversed.map(t => JSON.stringify(t)).join("\n") + "\n"));
    }
    await fs.writeFile(path.join(s.root, "coverage.json"), JSON.stringify({ tick: f.input.ticks.map(r => [r.fromUs / 1e6, r.toUs / 1e6]), book: [] }));
    const signal = new AbortController().signal, snap = new Snapshot(s, path.join(root, "snapshot"), signal), actual = new Map<number, Result>();
    const anchors = s.asOfUs.map(Number);
    const metrics = await streamBatch(snap, anchors, calculation, async (a, r) => { actual.set(a, r); });
    for (const a of anchors) {
      const ref = new Snapshot(s, path.join(root, "reference", String(a)), signal);
      const input = await ref.prepare(Math.min(start, a - 1800e6), a + 900e6);
      const b = new SampleBuilder({ ...source, asOfUs: a }, calculation, input);
      await ref.feed(b); assert.deepEqual(market(actual.get(a)!), market(b.finish()));
    }
    assert.ok(metrics.tradeGzipScans <= groups.size);
    const cfg: Config = { schema: "orderflow.research.v2.2", sources: [s], calculation, splits: null };
    const first = await exportBulk(cfg, path.join(root, "one"), { revision: "fixture", sourceHash: "fixture" }, signal);
    const second = await exportBulk(cfg, path.join(root, "two"), { revision: "fixture", sourceHash: "fixture" }, signal);
    assert.equal(first.manifest.content_hash, second.manifest.content_hash);
    execFileSync("unzip", ["-t", path.join(first.directory, "dataset-v2.zip")]);
    const edition = (await freezeInput(s, signal)).input_version;
    await fs.appendFile(path.join(s.root, "coverage.json"), "\n");
    assert.notEqual((await freezeInput(s, signal)).input_version, edition);
    const cancel = new AbortController(), dir = path.join(root, "cancel"); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "other-job"), "keep");
    const running = exportBulk(cfg, dir, { revision: "fixture", sourceHash: "fixture" }, cancel.signal);
    setTimeout(() => cancel.abort(Error("test_cancel")), 15);
    await assert.rejects(running, (e: any) => e.message === "test_cancel" || e.cause?.message === "test_cancel");
    assert.deepEqual(await fs.readdir(dir), ["other-job"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
