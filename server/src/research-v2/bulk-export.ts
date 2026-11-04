import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { csvCell } from "../labels/export.ts";
import type { TurningLabel } from "../../../lib/market/labels.ts";
import { INSTRUMENTS } from "../../../lib/market/instruments.ts";
import { sessionStartSec } from "../vp/state.ts";
import { digest, FORMULAS, X_ALLOWLIST } from "./engine.ts";
import { validateConfig } from "./export.ts";
import { BATCH_LIMITS, streamBatch } from "./batch.ts";
import { sharedRow, historyRanges, seriesId } from "./history.ts";
import { freezeInput, verifyInput, ctDate } from "./inventory.ts";
import { Snapshot, hashFile } from "./snapshot.ts";
import { assignSplits } from "./splits.ts";
import { zipV2, ENTRIES } from "./zip.ts";
import { integerUs, type Config, type Source } from "./model.ts";

export const BULK_ENTRIES = [...ENTRIES, "history-shared.csv", "sample-quality.csv"];
const MAX_BYTES = 2_000_000_000;
class Csv {
  private buffer = ""; private bytes = 0;
  readonly handle: fs.FileHandle; readonly keys: string[];
  constructor(handle: fs.FileHandle, keys: string[]) { this.handle = handle; this.keys = keys; }
  async row(row: Record<string, unknown>) {
    this.buffer += this.keys.map(k => csvCell(row[k])).join(",") + "\r\n";
    if (this.buffer.length >= 262_144) await this.flush();
  }
  async flush() { if (this.buffer) { this.bytes += Buffer.byteLength(this.buffer); await this.handle.writeFile(this.buffer); this.buffer = ""; } }
  async close() { await this.flush(); await this.handle.close(); }
  get size() { return this.bytes + Buffer.byteLength(this.buffer); }
}
export function bulkAnchors(s: Source) {
  const out = new Map<number, Set<string>>();
  const add = (n: number, basis: string) => {
    if (!Number.isSafeInteger(n) || n % 1e6) throw Error("v2_bulk_use_reference_v21_for_fractional_anchors");
    let set = out.get(n); if (!set) out.set(n, set = new Set()); set.add(basis);
    if (out.size > BATCH_LIMITS.anchors) throw Error("v2_batch_anchor_budget");
  };
  for (const t of s.asOfUs) add(integerUs(t), "explicit_research_anchor");
  for (const g of [...(s.grids ?? []), ...(s.grid ? [s.grid] : [])]) {
    const a = integerUs(g.fromUs), b = integerUs(g.toUs), step = integerUs(g.stepUs);
    if (a >= b || step < 1e6 || step % 1e6 || Math.ceil((b - a) / step) > BATCH_LIMITS.anchors) throw Error("invalid_bulk_grid");
    for (let t = a; t < b; t += step) add(t, "configured_grid");
  }
  return { anchors: [...out.keys()].sort((a, b) => a - b), bases: out };
}
export async function exportBulk(config: Config, output: string, code: { revision: string; sourceHash: string }, signal: AbortSignal) {
  validateConfig({ ...config, schema: "orderflow.research.v2.1" });
  if (config.schema !== "orderflow.research.v2.2" || config.calculation.mode !== "event_time_research") throw Error("v2_bulk_requires_v22_event_time");
  if (new Set(config.sources.map(s => `${s.symbol}:${s.contract}`)).size !== config.sources.length) throw Error("v2_bulk_duplicate_contract_source");
  signal.throwIfAborted();
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const final = path.join(output, "dataset");
  try { await fs.access(final); throw Error("output_exists_choose_new_directory"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const own = await fs.mkdtemp(path.join(output, ".v2-bulk-")), csvs: Csv[] = [];
  const sources = [], inventories: Record<string, any>[] = [], annotationProofs = [], io = [];
  const settingsHash = digest({ schema: config.schema, calculation: config.calculation, formulas: FORMULAS });
  const counts = { samples: 0, annotations: 0, historyRows: 0, sharedHistoryRows: 0, targetRows: 0, completeTargets: 0, arrivalVerifiedSamples: 0 };
  const open = async (name: string, keys: string[]) => {
    const file = await fs.open(path.join(own, name), "wx", 0o600), csv = new Csv(file, keys);
    await file.writeFile(keys.join(",") + "\r\n"); csvs.push(csv); return csv;
  };
  let complete = false;
  try {
    const samples = await open("samples.csv", ["sample_id", "input_version", "symbol", "contract", "as_of_us", "as_of_basis",
      "actual_judgment_us", "availability_mode", "reference_price_ticks", "reference_price_ts", "reference_age_us", "reference_reason",
      "history_initial_price_used", "history_initial_price_ticks", "history_initial_price_ts", "session_group", "near_group",
      "feature_start_us", "target_end_us", "tick_size", "source_kind", "history_storage", "history_ranges"]);
    const xs = await open("features.csv", ["sample_id", ...X_ALLOWLIST]);
    const history = await open("history.csv", ["sample_id", "from_us", "to_us", "coverage_mask", "contract_mask", "open", "high", "low", "close",
      "buy", "sell", "unknown", "count", "carried_close", "carried", "carried_from_pre_window", "missing_reason"]);
    const shared = await open("history-shared.csv", ["series_id", "from_us", "to_us", "coverage_mask", "contract_mask",
      "open", "high", "low", "close", "buy", "sell", "unknown", "count", "missing_reason"]);
    const ys = await open("targets.csv", ["sample_id", "horizon_seconds", "from_us", "to_us", "observation_end_us", "last_trade_us",
      "endpoint_change_ticks", "upward_excursion_ticks", "downward_excursion_ticks", "missing_reason", "availability_basis"]);
    const annotations = await open("annotations.csv", ["annotation_id", "sample_id", "symbol", "event_us", "annotation_price_ticks",
      "kind", "expectedDirection", "confidence", "note", "viewMode", "futureSeconds", "screen", "createdUs", "updatedUs",
      "actual_judgment_us", "as_of_basis", "review_status"]);
    const splits = await open("splits.csv", ["sample_id", "fold", "status", "reason"]);
    const quality = await open("sample-quality.csv", ["sample_id", "reference_reason", "feature_missing", "x_nonnull", "history_complete_seconds"]);
    for (let si = 0; si < config.sources.length; si++) {
      const source = config.sources[si]!, augmented: Source = { ...source, asOfUs: [...source.asOfUs] };
      let labels: TurningLabel[] = [];
      if (source.annotationFile) {
        const bytes = await fs.readFile(source.annotationFile);
        annotationProofs.push({ path: source.annotationFile, sha256: createHash("sha256").update(bytes).digest("hex") });
        const doc = JSON.parse(bytes.toString("utf8")) as { labels: TurningLabel[] };
        labels = doc.labels.filter(l => l.symbol === source.symbol && source.annotationIds?.includes(l.id));
        if (labels.length !== (source.annotationIds?.length ?? 0)) throw Error("requested_annotation_missing_or_duplicate");
        for (const l of labels) {
          if (!Number.isSafeInteger(l.tsSec)) throw Error("invalid_annotation_time");
          augmented.asOfUs.push(String(l.tsSec * 1e6));
        }
      }
      const { anchors, bases } = bulkAnchors(augmented);
      if (!anchors.length) throw Error("v2_bulk_no_anchors");
      const frozen = await freezeInput(source, signal); sources.push(frozen);
      const snapshot = new Snapshot(source, path.join(own, "input-snapshots", String(si)), signal);
      let writtenUntil = -Infinity;
      const groups = new Map<number, Record<string, any>>();
      const metrics = await streamBatch(snapshot, anchors, config.calculation, async (a, r) => {
        signal.throwIfAborted();
        const version = frozen.input_version;
        const sample_id = digest({ symbol: source.symbol, contract: source.contract, as_of_us: String(a), settingsHash, input_version: version });
        const session = Number(r.session_start_us), session_group = `${source.symbol}:${source.contract}:${r.session_start_us}`;
        await samples.row({ sample_id, input_version: version, symbol: source.symbol, contract: source.contract, as_of_us: String(a),
          as_of_basis: [...bases.get(a)!].sort().join("|"), actual_judgment_us: null, availability_mode: config.calculation.mode,
          reference_price_ticks: r.reference_price_ticks, reference_price_ts: r.reference_price_ts, reference_age_us: r.reference_age_us,
          reference_reason: r.reference_reason, history_initial_price_used: r.history_initial_price_used,
          history_initial_price_ticks: r.history_initial_price_ticks, history_initial_price_ts: r.history_initial_price_ts,
          session_group, near_group: session_group, feature_start_us: r.feature_start_us, target_end_us: r.target_end_us,
          tick_size: INSTRUMENTS[source.symbol].tickSize, source_kind: source.sourceKind, history_storage: "shared_1s",
          history_ranges: JSON.stringify(historyRanges(version, source.symbol, source.contract, Number(r.feature_start_us), a)) });
        await xs.row({ sample_id, ...r.x });
        for (const row of r.history) if (Number(row.from_us) >= writtenUntil) {
          await shared.row({ series_id: seriesId(version, source.symbol, source.contract, Number(row.from_us)), ...sharedRow(row) });
          writtenUntil = Number(row.to_us); counts.sharedHistoryRows++;
        }
        for (const y of r.targets) { await ys.row({ sample_id, ...y }); counts.targetRows++; if (!y.missing_reason) counts.completeTargets++; }
        const split = assignSplits([{ sample_id, as_of_us: String(a), feature_start_us: r.feature_start_us, target_end_us: r.target_end_us }], config.splits)[0]!;
        await splits.row(split);
        await quality.row({ sample_id, reference_reason: r.reference_reason, feature_missing: JSON.stringify(r.reasons),
          x_nonnull: Object.values(r.x).filter(v => v !== null).length,
          history_complete_seconds: r.history.filter(h => h.coverage_mask && h.contract_mask).length });
        let g = groups.get(session);
        if (!g) groups.set(session, g = { symbol: source.symbol, contract: source.contract, ct_date: ctDate(session),
          session_start_us: String(session), samples: 0, reference_missing: 0, x_nonnull: Object.fromEntries(X_ALLOWLIST.map(k => [k, 0])),
          y_complete: Object.fromEntries(config.calculation.horizonsSeconds.map(h => [h, 0])), reasons: {}, reference_reasons: {}, folds: {} });
        g.samples++; g.reference_missing += +(r.reference_price_ticks === null);
        for (const k of X_ALLOWLIST) g.x_nonnull[k] += +(r.x[k] !== null);
        for (const y of r.targets) g.y_complete[y.horizon_seconds] += +!y.missing_reason;
        for (const reason of Object.values(r.reasons)) g.reasons[reason] = (g.reasons[reason] ?? 0) + 1;
        if (r.reference_reason) g.reference_reasons[r.reference_reason] = (g.reference_reasons[r.reference_reason] ?? 0) + 1;
        const fk = `${split.fold}:${split.status}:${split.reason ?? ""}`; g.folds[fk] = (g.folds[fk] ?? 0) + 1;
        for (const l of labels.filter(l => l.tsSec * 1e6 === a)) {
          await annotations.row({ ...l, annotation_id: l.id, sample_id, event_us: String(l.tsSec * 1e6),
            annotation_price_ticks: l.priceTicks, createdUs: String(l.createdUs), updatedUs: String(l.updatedUs), actual_judgment_us: null,
            as_of_basis: "legacy_event_anchor", review_status: "subjective_annotation_not_objective_target" }); counts.annotations++;
        }
        counts.samples++;
        if (counts.samples % 1440 === 0) console.error(JSON.stringify({ phase: "v22_progress", symbol: source.symbol, completedSamples: counts.samples }));
        if (counts.samples % 1000 === 0 && csvs.reduce((n, c) => n + c.size, 0) > MAX_BYTES - 1_000_000) throw Error("v2_bulk_output_size_budget");
      });
      // Actual body-backed coverage, not a raw index claim when the hourly body is missing.
      const input = await snapshot.prepare(Number([...groups.keys()][0]!), Number([...groups.keys()].at(-1)!) + 27 * 3600e6);
      const { coverageIndex } = await import("./model.ts");
      const known = coverageIndex(input.ticks);
      for (const [start, g] of groups) {
        const end = sessionStartSec(start / 1e6 + 27 * 3600) * 1e6;
        let seconds = 0; for (let t = start; t < end; t += 1e6) seconds += +known(t, t + 1e6);
        g.coverage_seconds = seconds; g.unknown_volume = metrics.unknownBySession[String(start)] ?? 0;
        g.x_nonnull_rate = Object.fromEntries(X_ALLOWLIST.map(k => [k, g.x_nonnull[k] / g.samples]));
        g.y_complete_rate = Object.fromEntries(config.calculation.horizonsSeconds.map(h => [h, g.y_complete[h] / g.samples]));
        inventories.push(g);
      }
      for (const p of snapshot.proofs) if (frozen.files.find(f => f.path === p.path)?.sha256 !== p.before) throw Error("v2_snapshot_version_mismatch");
      await snapshot.verifyOriginals(); await verifyInput(source, frozen, signal);
      io.push({ symbol: source.symbol, contract: source.contract, ...metrics });
      void history;
    }
    for (const p of annotationProofs) if (await hashFile(p.path, signal) !== p.sha256) throw Error("annotation_snapshot_changed");
    for (const c of csvs) await c.close();
    const write = (name: string, data: unknown) => fs.writeFile(path.join(own, name), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await write("quality.json", { schema: config.schema, inventory: inventories, noDistributionsUsedForSplits: true,
      limits: BATCH_LIMITS, notes: "feature missing reasons count null columns; coverage/unknown volume are per session, not summed overlapping windows" });
    await write("config.json", config);
    await write("columns.md", "# v2.2\n\n" + Object.entries(FORMULAS).map(([k, v]) => `- ${k}: ${v}`).join("\n") +
      "\n\nsamples.input_version is a content edition of ALL source coverage/trade/board files, independent of grid selection; it is included in sample_id." +
      "\nhistory_ranges is JSON: series_id/from_us/to_us, half-open and split at CT17. history-shared.csv contains only base seconds, no window-dependent carry." +
      "\nReconstruct carried fields from samples.history_initial_price_used/price_ticks, resetting on bad coverage/contract and replacing on real trades. No OHLC is fabricated." +
      "\nnear_group=session_group conservatively groups the entire CT session, independent of grid additions/removals. Metadata, masks, annotations, quality and Y are not X." +
      "\nX allowlist: features.csv except sample_id. Unknown-direction volume is included in totals/VP, not delta. event-time is not verified arrival replay.\n");
    await write("README.md", "# 研究用v2.2 固定グリッド\n\nNo training, automatic labels, trading or production changes." +
      "\nOne gzip decode per source hour; stable external sort, rolling second sufficient statistics, shared history. No raw month in RAM." +
      "\nInteger event-time anchors use batch; fractional/strict exports remain available through original v2.1. Full grid is a provisional research setting." +
      "\nSplit boundaries are fixed from calendar/session counts and coverage only, never X/Y values or distributions." +
      "\nCheck input_version before joining generations. Legacy v2.1 IDs are not interchangeable." +
      "\nZIP uses STORE; content_hash covers all payload files except manifest, excluding run metrics and commit metadata.\n");
    const files = [];
    for (const name of BULK_ENTRIES.filter(n => n !== "manifest.json")) files.push({ name, sha256: await hashFile(path.join(own, name), signal) });
    const manifest = { schema: config.schema, code, settings_hash: settingsHash, content_hash: digest(files), files,
      input_versions: sources, annotation_snapshots: annotationProofs, x_allowlist: X_ALLOWLIST, counts,
      splitStatus: config.splits ? "configured_check_splits_csv" : "unconfigured_evaluation_impossible" };
    await write("manifest.json", manifest);
    await fs.rm(path.join(own, "input-snapshots"), { recursive: true, force: true });
    signal.throwIfAborted(); await zipV2(path.join(own, "dataset-v2.zip"), own, BULK_ENTRIES, MAX_BYTES);
    signal.throwIfAborted(); await fs.rename(own, final); complete = true;
    await fs.writeFile(path.join(output, "batch-metrics.json"), JSON.stringify(io, null, 2), { mode: 0o600, flag: "wx" });
    return { directory: final, manifest, zipSha256: await hashFile(path.join(final, "dataset-v2.zip"), signal) };
  } finally {
    await Promise.allSettled(csvs.map(c => c.handle.close()));
    if (!complete) await fs.rm(own, { recursive: true, force: true });
  }
}
