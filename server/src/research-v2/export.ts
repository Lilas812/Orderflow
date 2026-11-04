import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { csvCell } from "../labels/export.ts";
import { INSTRUMENTS } from "../../../lib/market/instruments.ts";
import type { TurningLabel } from "../../../lib/market/labels.ts";
import { SampleBuilder, digest, X_ALLOWLIST, FORMULAS } from "./engine.ts";
import { integerUs, type Config } from "./model.ts";
import { Snapshot, hashFile } from "./snapshot.ts";
import { assignSplits } from "./splits.ts";
import { zipV2, ENTRIES } from "./zip.ts";
import { sessionStartSec } from "../vp/state.ts";

export function validateConfig(config: Config) {
  const c = config.calculation;
  if (config.schema !== "orderflow.research.v2.1" || !["event_time_research", "arrival_verified"].includes(c.mode)
    || !Number.isInteger(c.lookbackSeconds) || c.lookbackSeconds < 1 || c.lookbackSeconds > 86400
    || !c.horizonsSeconds.length || c.horizonsSeconds.some(n => !Number.isInteger(n) || n < 1 || n > 86400)
    || new Set(c.horizonsSeconds).size !== c.horizonsSeconds.length
    || !Number.isInteger(c.maxDivergenceEvents) || c.maxDivergenceEvents < 1 || c.maxDivergenceEvents > 100_000) throw Error("invalid_v2_config");
  const identities = new Set<string>();
  for (const s of config.sources) {
    const identity = `${s.symbol}:${s.contract}`;
    if (identities.has(identity)) throw Error("multiple_source_versions_select_one_per_symbol_contract");
    identities.add(identity);
    if (!["NQ", "GC"].includes(s.symbol) || !INSTRUMENTS[s.symbol].contract.test(s.contract)) throw Error("invalid_symbol_contract");
    s.asOfUs.forEach(integerUs);
    if (s.grid) {
      const [a, b, step] = [s.grid.fromUs, s.grid.toUs, s.grid.stepUs].map(integerUs) as [number, number, number];
      if (a >= b || step < 1 || Math.ceil((b - a) / step) > 10_000) throw Error("invalid_or_oversized_explicit_grid");
    }
  }
  if (config.splits) for (const f of config.splits) if (!["train", "validation", "test"].includes(f.fold)
    || integerUs(f.fromUs) >= integerUs(f.toUs)) throw Error("invalid_fold_interval");
}
class Csv {
  file: fs.FileHandle; keys: string[];
  constructor(file: fs.FileHandle, keys: string[]) { this.file = file; this.keys = keys; }
  async row(row: Record<string, unknown>) { await this.file.writeFile(this.keys.map(k => csvCell(row[k])).join(",") + "\r\n"); }
  static async open(file: string, keys: string[]) {
    const handle = await fs.open(file, "wx", 0o600), csv = new Csv(handle, keys);
    await handle.writeFile(keys.join(",") + "\r\n"); return csv;
  }
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
export async function exportV2(config: Config, output: string, code: { revision: string; sourceHash: string }, signal: AbortSignal) {
  validateConfig(config); signal.throwIfAborted();
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const final = path.join(output, "dataset");
  try { await fs.access(final); throw Error("output_exists_choose_new_directory"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const owned = await fs.mkdtemp(path.join(output, ".v2-working-"));
  await fs.chmod(owned, 0o700);
  const csvs: Csv[] = [], snapshots: Snapshot[] = [], samples: Record<string, unknown>[] = [];
  const sampleResults: { sample_id: string; as_of_us: string; feature_start_us: string; target_end_us: string }[] = [];
  const dedup = new Map<string, Record<string, unknown>>();
  const quality: Record<string, unknown>[] = [], annotationHashes: { file: string; sha256: string }[] = [];
  let annotations = 0, targetComplete = 0, historyRows = 0, arrivalVerifiedSamples = 0;
  const settingsHash = digest({ schema: config.schema, calculation: config.calculation, formulas: FORMULAS });
  const open = async (name: string, keys: string[]) => { const c = await Csv.open(path.join(owned, name), keys); csvs.push(c); return c; };
  let complete = false;
  try {
    const xs = await open("features.csv", ["sample_id", ...X_ALLOWLIST]);
    const hs = await open("history.csv", ["sample_id", "from_us", "to_us", "coverage_mask", "contract_mask",
      "open", "high", "low", "close", "buy", "sell", "unknown", "count", "carried_close", "carried"]);
    const ys = await open("targets.csv", ["sample_id", "horizon_seconds", "from_us", "to_us", "observation_end_us", "last_trade_us",
      "endpoint_change_ticks", "upward_excursion_ticks", "downward_excursion_ticks", "missing_reason", "availability_basis"]);
    const an = await open("annotations.csv", ["annotation_id", "sample_id", "symbol", "event_us", "annotation_price_ticks",
      "kind", "expectedDirection", "confidence", "note", "viewMode", "futureSeconds", "screen", "createdUs", "updatedUs",
      "actual_judgment_us", "as_of_basis", "review_status"]);
    for (let si = 0; si < config.sources.length; si++) {
      const s = config.sources[si]!;
      const snapshot = new Snapshot(s, path.join(owned, "input-snapshots", String(si)), signal);
      snapshots.push(snapshot);
      let labels: TurningLabel[] = [];
      if (s.annotationFile) {
        const bytes = await fs.readFile(s.annotationFile);
        const doc = JSON.parse(bytes.toString("utf8")) as { labels: TurningLabel[] };
        annotationHashes.push({ file: s.annotationFile, sha256: createHash("sha256").update(bytes).digest("hex") });
        labels = doc.labels.filter(l => l.symbol === s.symbol && s.annotationIds?.includes(l.id));
        if (labels.length !== (s.annotationIds?.length ?? 0)) throw Error("requested_annotation_missing_or_duplicate");
        for (const l of labels) if (!Number.isSafeInteger(l.tsSec) || !Number.isSafeInteger(l.priceTicks)
          || !Number.isSafeInteger(l.createdUs) || !Number.isSafeInteger(l.updatedUs)
          || !["top", "bottom", "failed"].includes(l.kind)) throw Error("invalid_annotation_snapshot");
      }
      const anchors = new Map<number, Set<string>>();
      const add = (t: number, basis: string) => {
        if (t < config.calculation.lookbackSeconds * 1e6 || !Number.isSafeInteger(t + Math.max(...config.calculation.horizonsSeconds) * 1e6))
          throw Error("anchor_out_of_safe_range");
        let b = anchors.get(t); if (!b) anchors.set(t, b = new Set()); b.add(basis);
        if (anchors.size > 10_000) throw Error("pilot_sample_budget_exceeded");
      };
      s.asOfUs.forEach(t => add(integerUs(t), "explicit_research_anchor"));
      if (s.grid) for (let t = integerUs(s.grid.fromUs); t < integerUs(s.grid.toUs); t += integerUs(s.grid.stepUs)) add(t, "configured_grid");
      labels.forEach(l => add(integerUs(l.tsSec * 1e6), "legacy_event_anchor"));
      for (const [asOfUs, bases] of [...anchors].sort((a, b) => a[0] - b[0])) {
        signal.throwIfAborted();
        const sample_id = digest({ symbol: s.symbol, contract: s.contract, as_of_us: String(asOfUs), settingsHash });
        let sample = dedup.get(sample_id);
        if (!sample) {
          const from = Math.min(sessionStartSec(asOfUs / 1e6) * 1e6, asOfUs - config.calculation.lookbackSeconds * 1e6);
          const input = await snapshot.prepare(from, asOfUs + Math.max(...config.calculation.horizonsSeconds) * 1e6);
          const builder = new SampleBuilder({ symbol: s.symbol, contract: s.contract, asOfUs }, config.calculation, input);
          await snapshot.feed(builder); const r = builder.finish();
          sample = { sample_id, symbol: s.symbol, contract: s.contract, as_of_us: String(asOfUs),
            as_of_basis: [...bases].sort().join("|"), actual_judgment_us: null, availability_mode: config.calculation.mode,
            reference_price_ticks: r.reference_price_ticks, reference_price_ts: r.reference_price_ts, reference_age_us: r.reference_age_us,
            reference_reason: r.reference_reason, session_group: `${s.symbol}:${s.contract}:${r.session_start_us}`,
            near_group: "", feature_start_us: r.feature_start_us, target_end_us: r.target_end_us,
            tick_size: INSTRUMENTS[s.symbol].tickSize, source_kind: s.sourceKind };
          dedup.set(sample_id, sample); samples.push(sample);
          sampleResults.push({ sample_id, as_of_us: String(asOfUs), feature_start_us: r.feature_start_us, target_end_us: r.target_end_us });
          await xs.row({ sample_id, ...r.x });
          for (const row of r.history) { signal.throwIfAborted(); await hs.row({ sample_id, ...row }); historyRows++; }
          for (const row of r.targets) { await ys.row({ sample_id, ...row }); if (!row.missing_reason) targetComplete++; }
          const full = r.history.every(h => h.coverage_mask && h.contract_mask) && r.reference_price_ticks !== null;
          if (full && config.calculation.mode === "arrival_verified") arrivalVerifiedSamples++;
          quality.push({ sample_id, source_kind: s.sourceKind, reference_reason: r.reference_reason, feature_missing: r.reasons,
            x_nonnull: Object.values(r.x).filter(v => v !== null).length,
            history_complete_seconds: r.history.filter(h => h.coverage_mask && h.contract_mask).length,
            market_audit: r.audit, availability_evidence: "legacy recvUs is not used as arrival/finalization proof" });
        }
        for (const l of labels.filter(l => l.tsSec * 1e6 === asOfUs)) {
          await an.row({ ...l, annotation_id: l.id, sample_id, event_us: String(l.tsSec * 1e6),
            annotation_price_ticks: l.priceTicks, createdUs: String(l.createdUs), updatedUs: String(l.updatedUs),
            actual_judgment_us: null, as_of_basis: "legacy_event_anchor", review_status: "subjective_annotation_not_objective_target" });
          annotations++;
        }
      }
    }
    // Connected overlapping observation intervals, within the same symbol/contract/session.
    const groups = new Map<string, { end: number; id: string }>();
    for (const s of [...samples].sort((a, b) => Number(a.as_of_us) - Number(b.as_of_us))) {
      const key = String(s.session_group), old = groups.get(key), start = Number(s.feature_start_us), end = Number(s.target_end_us);
      const g = old && start < old.end ? old : { end, id: digest([key, s.as_of_us]) };
      g.end = Math.max(g.end, end); groups.set(key, g); s.near_group = g.id;
    }
    const sc = await open("samples.csv", ["sample_id", "symbol", "contract", "as_of_us", "as_of_basis", "actual_judgment_us",
      "availability_mode", "reference_price_ticks", "reference_price_ts", "reference_age_us", "reference_reason",
      "session_group", "near_group", "feature_start_us", "target_end_us", "tick_size", "source_kind"]);
    for (const s of samples) await sc.row(s);
    const splitRows = assignSplits(sampleResults, config.splits);
    const sp = await open("splits.csv", ["sample_id", "fold", "status", "reason"]);
    for (const s of splitRows) await sp.row(s);
    for (const c of csvs) await c.file.close();
    for (const snap of snapshots) await snap.verifyOriginals();
    for (const a of annotationHashes) if (await hashFile(a.file, signal) !== a.sha256) throw Error("annotation_snapshot_changed");
    await fs.writeFile(path.join(owned, "quality.json"), json({ schema: config.schema, samples: quality,
      omittedFeatures: { previous_session_distances: "outside minimal v2 pilot; no inferred previous-day completion",
        count_z_max_sweep_pull: "not adopted by this minimal exporter; v1 remains unchanged" } }), { mode: 0o600 });
    await fs.writeFile(path.join(owned, "config.json"), json(config), { mode: 0o600 });
    await fs.writeFile(path.join(owned, "columns.md"), "# v2.1\n\n"
      + "X allowlistはfeatures.csvのsample_id以外の列のみ。sample_idは結合キーであり学習入力でない。\n\n"
      + Object.entries(FORMULAS).map(([k, v]) => `- ${k}: ${v}`).join("\n")
      + "\n\nhistory: from/to_usはas_ofから逆算した1秒半開区間、全行as_of未満。OHLCはその区間の実約定だけ。"
      + "known-emptyはOHLC=null、数量/件数=0。欠損・限月混在は数量もnull。carried_closeだけ別列で既知無約定秒を持越す。"
      + "coverage_maskは選択した可用性モードでのcoverage、contract_maskはその秒の実約定の限月整合（無約定は1、限月の新証明ではない）。\n"
      + "targets: [as_of,as_of+H)の最終実価格-reference、上向き最大幅、下向き最大幅。既知無約定のみ前値保持。"
      + "annotationsのcreatedUs/futureSecondsは当時の判断時刻や先読みなしを証明しない。\n", { mode: 0o600 });
    await fs.writeFile(path.join(owned, "README.md"), "# 比較検証用データセットv2.1\n\n"
      + "探索用pilot。モデル学習・正例/負例生成・画像・ライブ再現を実施していない。\n"
      + "samples/reference、features(X)、history、annotations、targets(Y)、splitsを分離。未マークはunknownであり負例ではない。\n"
      + "event_time_researchはイベント時刻の過去切断だけ。arrival_verifiedは明示的なローカル到着・集計確定・coverage確定の根拠が必要。"
      + "既存ファイルのrecvUsやColumn.tsSecから捏造しない。strictの実市場特徴が全欠損でも可用性保証を主張しない。\n"
      + "入力ファイルは固定した時間スナップショットからストリーム読取。1セッションずつ、過去1秒系列・価格別VP・最大10万イベントのCVD順序検証だけ保持。"
      + "本CSVのallowlist以外を一括学習に入れない。Y、注釈、quality、metadataをXへ結合しない。\n"
      + "split未設定なら評価不能。全期間分位・補完・標準化・対照マッチ・最適モデル選定を実施していない。\n"
      + "content_hashはmanifest以外の同梱10ファイルの名前とSHA-256から計算。manifestはその入力hash/config/code版を別途固定し、自己参照を避ける。"
      + "生成時刻・CPU/RSS・一時パスは非同梱run-metrics.jsonに分離。ZIP自体にも時刻を埋め込まない。\n", { mode: 0o600 });
    const files = await Promise.all(ENTRIES.filter(n => n !== "manifest.json").map(async name => ({ name, sha256: await hashFile(path.join(owned, name), signal) })));
    const manifest = { schema: config.schema, code, settings_hash: settingsHash,
      content_hash: digest(files), files, input: snapshots.map(s => ({ symbol: s.source.symbol, contract: s.source.contract,
        source_kind: s.source.sourceKind, files: s.proofs.map(p => ({ path: p.path, sha256: p.before, original_unchanged: p.after === p.before })) })),
      annotation_snapshots: annotationHashes, x_allowlist: X_ALLOWLIST, id_encoding: "CSV decimal strings / SHA256 IDs, safe-integer microseconds",
      counts: { samples: samples.length, annotations, historyRows, targetRows: samples.length * config.calculation.horizonsSeconds.length,
        completeTargets: targetComplete, arrivalVerifiedSamples }, splitStatus: config.splits?.length ? "configured_check_splits_csv" : "unconfigured_evaluation_impossible",
      note: "Availability unverified is not realtime replay. No training, profit claim or raw tape/board export." };
    await fs.writeFile(path.join(owned, "manifest.json"), json(manifest), { mode: 0o600 });
    await fs.rm(path.join(owned, "input-snapshots"), { recursive: true, force: true });
    signal.throwIfAborted(); await zipV2(path.join(owned, "dataset-v2.zip"), owned);
    signal.throwIfAborted(); await fs.rename(owned, final); complete = true;
    return { directory: final, manifest, zipSha256: await hashFile(path.join(final, "dataset-v2.zip")) };
  } finally {
    await Promise.allSettled(csvs.map(c => c.file.close()));
    if (!complete) await fs.rm(owned, { recursive: true, force: true });
  }
}
