/** Research-only caller of the CURRENT importer. Never reads a product baseline
 * or writes active.json. Existing verified stages are read-only inputs. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setPriority } from "node:os";
import assert from "node:assert/strict";
import { atomic, sha, emptyStats, count, type StagedFile } from "../src/import/databento-stage.ts";
import { install, mergeIncoming } from "../src/import/databento-install.ts";
import { rebuild } from "../src/import/databento-rebuild.ts";
import { tradeFileEntries } from "../src/store/records.ts";
import { indexedSessions, ctDate } from "../src/research-v2/inventory.ts";
import { sessionStartSec } from "../src/vp/state.ts";
import type { Trade } from "../src/types.ts";

export function nqOnly(staged: StagedFile[]): StagedFile[] {
  return staged.map((f): StagedFile => ({ ...f, contracts: f.contracts.NQZ26 ? { NQZ26: f.contracts.NQZ26 } : {},
    outputs: f.outputs.filter(o => /^(known|unknown)\/NQZ26\//.test(o.path)) }));
}
export async function emptyBaseline(directory: string) {
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  const coverage = { book: [], tick: [] };
  await atomic(path.join(directory, "coverage.json"), coverage);
  await atomic(path.join(directory, "snapshot.json"), { files: [], coverage });
}
export async function census(paths: string[], signal?: AbortSignal) {
  const files: { path: string; sha256: string; bytes: number }[] = [];
  async function walk(p: string) {
    signal?.throwIfAborted();
    const stat = await fs.stat(p);
    if (stat.isDirectory()) for (const name of (await fs.readdir(p)).sort()) await walk(path.join(p, name));
    else files.push({ path: p, sha256: await sha(p), bytes: stat.size });
  }
  for (const p of paths) await walk(p);
  return files;
}
const knownSeconds = (rs: [number, number][], a: number, b: number) =>
  rs.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
export function hourCauses(hours: any[], old: [number, number][]) {
  return hours.filter(h => h.unknownSide || h.blocked).map(h => {
    const from = Date.parse(h.hour.slice(0, 10) + "T" + h.hour.slice(11) + ":00:00Z") / 1000;
    return { hour_utc: h.hour, ct_session: ctDate(sessionStartSec(from) * 1e6),
      unknown_side: !!h.unknownSide, blocked: h.blocked ?? null,
      old_coverage_seconds: knownSeconds(old, from, from + 3600),
      missing_seconds: 3600 - knownSeconds(old, from, from + 3600) };
  });
}
function csv(rows: Record<string, any>[]) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]!);
  return keys.join(",") + "\n" + rows.map(r => keys.map(k => JSON.stringify(r[k] ?? "")).join(",")).join("\n") + "\n";
}
export async function run(out: string, signal: AbortSignal) {
  const started = performance.now(), cpu = process.cpuUsage();
  const base = JSON.parse(await fs.readFile("server/research-v2/grid-v22.json", "utf8"));
  const old = JSON.parse(await fs.readFile("data/databento-import/active.json", "utf8"));
  const gc = JSON.parse(await fs.readFile("data/databento-gc-import/active.json", "utf8"));
  const archive = path.resolve(old.original);
  assert.equal(await sha(archive), old.archiveSha256);
  const stage = path.resolve(old.stage);
  const manifest = JSON.parse(execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" }));
  const conditions = JSON.parse(execFileSync("unzip", ["-p", archive, "condition.json"], { encoding: "utf8" }));
  const protectedPaths = [archive, gc.original, "data/databento-import/generations",
    "data/databento-gc-import/generations", "data/databento-import/verified-v1",
    "data/databento-gc-import/verified-v1", "data/databento-import/active.json", "data/databento-gc-import/active.json"];
  // Exclusive research directory. Never reset/delete a previous attempt.
  await fs.mkdir(out, { recursive: false, mode: 0o700 });
  const before = await census(protectedPaths, signal);
  await atomic(path.join(out, "protected-before.json"), before);
  const staged: StagedFile[] = [];
  for (const f of old.staged as StagedFile[]) {
    signal.throwIfAborted();
    const verified = JSON.parse(await fs.readFile(path.join(stage, f.sha256, "verified.json"), "utf8"));
    assert.deepEqual(verified, f);
    assert.equal(manifest.files.find((m: any) => m.filename === f.member)?.hash, "sha256:" + f.sha256);
    assert.equal(f.errors, 0);
    for (const o of f.outputs) assert.equal(await sha(path.join(stage, f.sha256, o.path)), o.sha256);
    staged.push(f);
  }
  const baseline = path.join(out, "empty-baseline"), generation = path.join(out, "generation");
  await emptyBaseline(baseline);
  const installed = await install(nqOnly(staged), stage, generation, baseline, old.fromUs, old.toUs,
    new Set(conditions.filter((d: any) => d.condition === "available").map((d: any) => d.date)), signal);
  assert.deepEqual(Object.keys(installed), ["NQZ26"]);
  const detail = installed.NQZ26 as any, root = path.join(generation, "NQZ26");
  assert.ok(detail.hours.every((h: any) => !h.blocked));
  const rebuilt = await rebuild(root, "NQZ26", signal, detail.coverage.tick);
  // Independent streaming equality against the verified original-index tapes,
  // including original order/duplicates/rewinds, side counts AND every price.
  const groups = new Map<string, string[]>(), expected = emptyStats(), actual = emptyStats();
  const expectedCounts = { buy: 0, sell: 0, unknown: 0 }, actualCounts = { ...expectedCounts };
  const prices = new Map<number, { buy: number; sell: number; unknown: number }>();
  for (const f of nqOnly(staged)) for (const o of f.outputs) {
    const hour = o.path.split("/").slice(2).join("/"), files = groups.get(hour) ?? [];
    files.push(path.join(stage, f.sha256, o.path)); groups.set(hour, files);
  }
  let verifiedHours = 0;
  for (const [hour, files] of [...groups].sort()) {
    const a = createHash("sha256"), b = createHash("sha256");
    for await (const { line, trade } of mergeIncoming(files, signal)) {
      const t = trade as Trade;
      if (t.tsUs < old.fromUs || t.tsUs >= old.toUs) continue;
      count(expected, t); expectedCounts[t.side]++; a.update(line + "\n");
      const p = prices.get(t.price) ?? { buy: 0, sell: 0, unknown: 0 };
      p[t.side] += t.size; prices.set(t.price, p);
    }
    for await (const { line, trade: t } of tradeFileEntries(path.join(root, "trades/NQ", hour), signal)) {
      assert.equal(t.contract, "NQZ26"); count(actual, t); actualCounts[t.side]++; b.update(line + "\n");
    }
    assert.equal(a.digest("hex"), b.digest("hex"), hour); verifiedHours++;
  }
  assert.deepEqual(expected, actual); assert.deepEqual(expectedCounts, actualCounts);
  assert.deepEqual(expected, rebuilt.totals);
  const priceRows = JSON.parse(await fs.readFile(path.join(root, "price-volumes.json"), "utf8"));
  for (const [p, v] of priceRows) {
    const expected = prices.get(p); assert.ok(expected);
    assert.equal(v.buy, expected.buy); assert.equal(v.sell, expected.sell); assert.equal(v.unknown ?? 0, expected.unknown);
  }
  assert.equal(priceRows.length, prices.size);
  const originalIndex = emptyStats();
  for (const f of staged) if (f.contracts.NQZ26) {
    const v = f.contracts.NQZ26;
    for (const k of ["count", "buy", "sell", "unknown", "weighted"] as const) originalIndex[k] += v[k];
    originalIndex.minUs = Math.min(originalIndex.minUs, v.minUs);
    originalIndex.maxUs = Math.max(originalIndex.maxUs, v.maxUs);
  }
  assert.deepEqual(expected, originalIndex);
  await atomic(path.join(out, "import.json"), { state: "verified_research_only", sidePolicy: "all-outright-v2",
    archive, archiveSha256: old.archiveSha256, stage, root, fromUs: old.fromUs, toUs: old.toUs,
    expected, actual, expectedCounts, actualCounts, originalIndex, verifiedHours, priceLevels: prices.size,
    inputRows: staged.reduce((n, f) => n + f.rows, 0), spreads: staged.reduce((n, f) => n + f.spreads, 0),
    otherContracts: Object.keys(old.installed).filter(k => k !== "NQZ26"), installed, rebuilt,
    baseline: "empty; no product data copied", activePointerWritten: false });
  const oldCoverage = JSON.parse(await fs.readFile(path.join(base.sources[0].root, "coverage.json"), "utf8")).tick;
  const causes = hourCauses(old.installed.NQZ26.hours, oldCoverage);
  await fs.writeFile(path.join(out, "hour-causes.csv"), csv(causes));
  const sessions = await indexedSessions({ ...base.sources[0], root });
  const gcCoverage = JSON.parse(await fs.readFile(path.join(base.sources[1].root, "coverage.json"), "utf8")).tick;
  const sessionRows = sessions.map(s => {
    const a = Number(s.from_us) / 1e6, b = Number(s.to_us) / 1e6;
    let explained = 0;
    // Hour causes can overlap (N + blocked); count their UNION exactly once.
    for (const h of causes) {
      const x = Date.parse(h.hour_utc.slice(0, 10) + "T" + h.hour_utc.slice(11) + ":00:00Z") / 1000;
      const l = Math.max(a, x), r = Math.min(b, x + 3600);
      if (r > l) explained += r - l - knownSeconds(oldCoverage, l, r);
    }
    const oldSec = knownSeconds(oldCoverage, a, b), newSec = s.coverage_seconds;
    return { ct_date: s.date, old_nq_seconds: oldSec, new_nq_seconds: newSec,
      gc_seconds: knownSeconds(gcCoverage, a, b), explained_old_missing_seconds: explained,
      remaining_old_missing_seconds: b - a - oldSec - explained,
      remaining_new_missing_seconds: b - a - newSec,
      fixed_grid_includes_session: base.sources[0].grids.some((g: any) => g.fromUs === s.from_us) };
  });
  await fs.writeFile(path.join(out, "session-coverage.csv"), csv(sessionRows));
  // List every old gap not in the two proven importer exclusions, including
  // scheduled pauses/weekends and requested archive boundaries. No zero-fill.
  const unexplained = [];
  const allRanges = [...oldCoverage, ...causes.map(h => {
    const x = Date.parse(h.hour_utc.slice(0, 10) + "T" + h.hour_utc.slice(11) + ":00:00Z") / 1000;
    return [x, x + 3600];
  })].sort(([a], [b]) => a - b);
  for (const s of sessions) {
    let cursor = Number(s.from_us) / 1e6, end = Number(s.to_us) / 1e6;
    for (const [a, b] of allRanges) {
      if (b <= cursor || a >= end) continue;
      if (a > cursor) unexplained.push({ ct_date: s.date, from_utc: new Date(cursor * 1000).toISOString(),
        to_utc: new Date(Math.min(a, end) * 1000).toISOString(), seconds: Math.min(a, end) - cursor,
        reason: cursor < old.fromUs / 1e6 || cursor >= old.toUs / 1e6 ? "outside_purchased_query" : "no_certified_hour_in_source_index" });
      cursor = Math.min(end, Math.max(cursor, b));
    }
    if (cursor < end) unexplained.push({ ct_date: s.date, from_utc: new Date(cursor * 1000).toISOString(),
      to_utc: new Date(end * 1000).toISOString(), seconds: end - cursor,
      reason: cursor >= old.toUs / 1e6 ? "outside_purchased_query" : "no_certified_hour_in_source_index" });
  }
  await fs.writeFile(path.join(out, "unexplained-old-gaps.csv"), csv(unexplained));
  const config = structuredClone(base); config.sources[0].root = root;
  assert.deepEqual({ ...config.sources[0], root: base.sources[0].root }, base.sources[0]);
  await atomic(path.join(out, "config.json"), config);
  const after = await census(protectedPaths, signal); assert.deepEqual(after, before);
  await atomic(path.join(out, "protected-after.json"), after);
  const metrics = { elapsedMs: performance.now() - started, cpuUs: process.cpuUsage(cpu),
    peakRssKiB: process.resourceUsage().maxRSS, protectedFiles: before.length,
    allProtectedUnchanged: true, root, expected, expectedCounts, verifiedHours,
    unknownHourCount: causes.filter(h => h.unknown_side).length, blockedHourCount: causes.filter(h => h.blocked).length,
    newCoverageSeconds: sessionRows.reduce((n, s) => n + s.new_nq_seconds, 0) };
  await atomic(path.join(out, "metrics.json"), metrics); console.log(JSON.stringify(metrics));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (!process.argv.includes("--out") || !path.resolve(out!).startsWith(path.resolve("data/research-v2") + path.sep))
    throw Error("new_private_research_output_required");
  setPriority(process.pid, 19);
  const c = new AbortController(), abort = () => c.abort(Error("research_import_cancelled"));
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try { await run(out!, c.signal); }
  finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
}
