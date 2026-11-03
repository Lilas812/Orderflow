import * as fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import path from "node:path";
import type { TurningLabel } from "../../../lib/market/labels.ts";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";
import { sessionStartSec } from "../vp/state.ts";
import { DayData, FEATURES, OUTCOMES, calculate, clock, nextSession, precedingSession, put, type FeatureResult } from "./features.ts";
import { readDay, immutableLease, enrichProfiles, enrichBoards, enrichDivergence, type Lease } from "./reader.ts";
import { zipFiles } from "./zip.ts";

export interface LabelExport {
  symbol: MarketSymbol; fromSec: number; toSec: number; labels: TurningLabel[];
  tickRanges: [number, number][]; directory: string;
}
interface Candidate { t: number; p: number; v: number; bin: number; day: number; high: boolean; low: boolean;
  futureHigh: number | null; futureLow: number | null; contract: string; }
interface Selected { source: TurningLabel; event: TurningLabel; type: "mark" | "random" | "nearmiss"; }
export const META: Record<string, string> = {
  row_type: "mark/random/nearmiss。対照は自動選択された比較点であり人の正解ラベルではない",
  matched_mark_id: "元マークID", id: "行ID", label: "手動マークのみtop/bottom/failed、対照はnone",
  symbol: "NQ/GC", tsSec: "Unix秒（整数）", priceTicks: "銘柄固有の整数ticks、NQ0.25/GC0.10",
  confidence: "手動確信度1–3", note: "手動メモ、先頭=+-@等はCSV式実行防止のためアポストロフィ付加",
  viewMode: "手動時live/blind/hindsight。過去に本人が見た情報は保証しない。対照は空欄",
  screen: "手動時heatmap/footprint。対照は空欄", expectedDirection: "期待反転up/down",
  futureSeconds: "作成時の最新受信済み市場データ時刻/再生位置とtsSecの差秒、最低0。編集では不変。対照は空欄",
  createdUs: "手動作成Unixマイクロ秒", updatedUs: "手動更新Unixマイクロ秒",
  contract: "過去30分の原レコード限月。UNKNOWN/MIXEDは別表示し、未知の限月差を0で接続しない",
  quality: "complete/partial、およびcontract_unknown。未定義統計量とデータ欠けはmissing_reasonsで区別",
  missing_reasons: "空欄列と理由のJSON。0は実際に計算できた0、欠けの代用ではない",
};
export const COLUMNS = { ...META, ...FEATURES, ...OUTCOMES };
export function csvCell(v: unknown) {
  if (v === null || v === undefined) return "";
  let text = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function extremes(data: DayData, size: number, high: boolean) {
  const output = new Float64Array(data.frames.length + 1).fill(NaN), q: number[] = [];
  let head = 0;
  const value = (i: number) => high ? data.frames[i]!.h : data.frames[i]!.l;
  for (let i = 0; i <= data.frames.length; i++) {
    while (head < q.length && q[head]! < i - size) head++;
    if (head < q.length) output[i] = value(q[head]!);
    if (!data.frames[i]) continue;
    while (q.length > head && (high ? value(q.at(-1)!) <= value(i) : value(q.at(-1)!) >= value(i))) q.pop();
    q.push(i);
  }
  return output;
}
function quintile(v: number, cuts: number[]) { return cuts.filter(c => v > c).length; }
function hash(seed: string, t: number) {
  let x = 2166136261;
  for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  x = Math.imul(x ^ t, 0x45d9f3b); x = Math.imul(x ^ x >>> 16, 0x45d9f3b);
  return (x ^ x >>> 16) >>> 0;
}
function choose(list: Candidate[], item: Candidate, mark: TurningLabel, distinctDays: boolean) {
  if (list.some(c => c.t === item.t)) return;
  const next = [...list, item].sort((a, b) => hash(mark.id, a.t) - hash(mark.id, b.t) || a.t - b.t);
  list.length = 0;
  for (const c of next) {
    if (list.some(v => distinctDays ? v.day === c.day : Math.abs(v.t - c.t) < 900)) continue;
    list.push(c); if (list.length === 3) break;
  }
}
async function* lines(file: string) {
  const input = createReadStream(file), reader = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of reader) if (line) yield line; }
  finally { reader.close(); input.destroy(); await finished(input).catch(() => {}); }
}
async function write(stream: ReturnType<typeof createWriteStream>, text: string) {
  if (stream.errored) throw stream.errored;
  if (!stream.write(text)) {
    if (stream.errored) throw stream.errored;
    await once(stream, "drain");
  }
}

export async function exportLabels(job: LabelExport, input: Lease) {
  const { lease, versions } = immutableLease(input);
  const marks = job.labels.filter(l => l.symbol === job.symbol && l.tsSec >= job.fromSec && l.tsSec < job.toSec);
  const candidateFile = path.join(job.directory, "candidates.jsonl");
  const candidates = createWriteStream(candidateFile, { flags: "wx", mode: 0o600 });
  // Observe errors even while not awaiting backpressure.
  candidates.on("error", () => {});
  const vols: number[][] = Array.from({ length: 48 }, () => []);
  const markInfo = new Map<string, { rv: number | null; threshold: number | null; bin: number; day: number; contract: string }>();
  let candidateCount = 0;
  const start = sessionStartSec(job.fromSec), end = job.toSec;
  try {
    for (let day = start; marks.length && day < end; day = nextSession(day)) {
      const data = await readDay(day, lease);
      for (const label of marks.filter(l => sessionStartSec(l.tsSec) === day)) {
        const r = data.range(label.tsSec - 900, label.tsSec + 900);
        markInfo.set(label.id, { rv: data.identity(label.tsSec - 1800, label.tsSec) === "MIXED"
          ? null : data.rv(label.tsSec - 1800, label.tsSec),
        threshold: r && data.complete(label.tsSec - 900, label.tsSec + 900)
          && data.identity(label.tsSec - 900, label.tsSec + 900) !== "MIXED"
          ? Math.max(1, Math.ceil((r.high - r.low) / 2)) : null,
        bin: Math.floor(clock(label.tsSec).minute / 30), day, contract: data.identity(label.tsSec - 1800, label.tsSec) });
      }
      if (!marks.length) continue;
      const pastH = extremes(data, 1800, true), pastL = extremes(data, 1800, false);
      const afterH = extremes(data, 900, true), afterL = extremes(data, 900, false);
      let buffer = "", hour = -1, hourMinute = 0;
      for (let t = Math.max(day, job.fromSec); t < Math.min(nextSession(day), end); t++) {
        const f = data.frame(t), rv = data.rv(t - 1800, t);
        if (!f || rv === null || data.identity(t - 1800, t) === "MIXED") continue;
        const h = Math.floor(t / 3600);
        if (h !== hour) { hour = h; hourMinute = clock(h * 3600).minute; }
        const bin = Math.floor((hourMinute + Math.floor((t % 3600) / 60)) / 30);
        const i = t - data.start;
        const futureKnown = data.complete(t, t + 900) && data.identity(t - 1800, t + 900) !== "MIXED";
        const c: Candidate = { t, p: f.o, v: rv, bin, day, high: f.h > pastH[i]!, low: f.l < pastL[i]!,
          futureHigh: futureKnown && Number.isFinite(afterH[i + 900]) ? afterH[i + 900]! : null,
          futureLow: futureKnown && Number.isFinite(afterL[i + 900]) ? afterL[i + 900]! : null,
          contract: data.identity(t - 1800, t) };
        // Near-miss baseline is the updated high/low, not the first price of that second.
        buffer += JSON.stringify({ ...c, hp: f.h, lp: f.l }) + "\n";
        vols[bin]!.push(rv); candidateCount++;
        if (buffer.length >= 65536) { await write(candidates, buffer); buffer = ""; }
      }
      if (buffer) await write(candidates, buffer);
    }
    candidates.end(); await finished(candidates);
  } catch (e) { candidates.destroy(); await finished(candidates).catch(() => {}); throw e; }
  const cuts = vols.map(values => {
    values.sort((a, b) => a - b);
    return [.2, .4, .6, .8].map(p => values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? NaN);
  });
  const random = new Map(marks.map(l => [l.id, [] as Candidate[]]));
  const near = new Map(marks.map(l => [l.id, [] as Candidate[]]));
  for await (const line of lines(candidateFile)) {
    const c = JSON.parse(line) as Candidate & { hp: number; lp: number };
    for (const mark of marks) {
      const m = markInfo.get(mark.id)!;
      if (m.rv !== null && c.day !== m.day && m.bin === c.bin
        && quintile(m.rv, cuts[m.bin]!) === quintile(c.v, cuts[c.bin]!))
        choose(random.get(mark.id)!, c, mark, true);
      if (c.day !== m.day || m.threshold === null || c.futureHigh === null || c.futureLow === null
        || Math.abs(c.t - mark.tsSec) < 900) continue;
      const top = mark.expectedDirection === "down";
      if (top && c.high && c.hp - c.futureLow < m.threshold)
        choose(near.get(mark.id)!, { ...c, p: c.hp }, mark, false);
      if (!top && c.low && c.futureHigh - c.lp < m.threshold)
        choose(near.get(mark.id)!, { ...c, p: c.lp }, mark, false);
    }
  }
  const selected: Selected[] = marks.map(mark => ({ source: mark, event: mark, type: "mark" }));
  const controls: Record<string, unknown> = {};
  for (const mark of marks) {
    for (const [type, rows] of [["random", random.get(mark.id)!], ["nearmiss", near.get(mark.id)!]] as const)
      for (const c of rows) selected.push({ source: mark, type,
        event: { ...mark, id: `${mark.id}:${type}:${c.t}`, tsSec: c.t, priceTicks: c.p } });
    controls[mark.id] = { random: random.get(mark.id)!.length, nearmiss: near.get(mark.id)!.length,
      randomReason: random.get(mark.id)!.length < 3 ? "insufficient_other_sessions_same_bin_quintile" : null,
      nearmissReason: near.get(mark.id)!.length < 3 ? "insufficient_complete_nonoverlapping_candidates" : null,
      ...markInfo.get(mark.id) };
  }
  const csv = createWriteStream(path.join(job.directory, "events.csv"), { flags: "wx", mode: 0o600 });
  csv.on("error", () => {});
  const missing: Record<string, number> = {};
  const counts = { mark: marks.length, random: selected.filter(x => x.type === "random").length,
    nearmiss: selected.filter(x => x.type === "nearmiss").length };
  try {
    await write(csv, Object.keys(COLUMNS).join(",") + "\r\n");
    for (const day of [...new Set(selected.map(x => sessionStartSec(x.event.tsSec)))].sort((a, b) => a - b)) {
      const rows = selected.filter(x => sessionStartSec(x.event.tsSec) === day), labels = rows.map(x => x.event);
      const data = await readDay(day, lease);
      const results = new Map(labels.map(l => [l.id, calculate(l, data)]));
      // Skip regular weekends and *confirmed empty* sessions, never jump over an unknown trading day.
      for (let previousDay = precedingSession(day);
        job.tickRanges.some(([a, b]) => a < nextSession(previousDay) && b > previousDay);
        previousDay = precedingSession(previousDay)) {
        const previous = await readDay(previousDay, lease);
        const r = previous.range(previousDay, nextSession(previousDay));
        if (!r && previous.complete(previousDay, nextSession(previousDay))) continue;
        for (const l of labels) {
          const identity = data.identity(l.tsSec - 1800, l.tsSec);
          for (const side of ["high", "low"] as const)
            put(results.get(l.id)!, `distance_previous_${side}`, r && identity !== "UNKNOWN" && identity !== "MIXED"
              && previous.complete(previousDay, nextSession(previousDay))
              && previous.identity(previousDay, nextSession(previousDay)) === identity ? l.priceTicks - r[side] : null,
            "previous_session_coverage_or_contract_unknown");
        }
        break;
      }
      await enrichProfiles(labels, data, results, lease);
      await enrichBoards(labels, data, results, lease);
      for (const l of labels) await enrichDivergence(l, data, results.get(l.id)!, lease);
      for (const row of rows) {
        const l = row.event, out = results.get(l.id)!, manual = row.type === "mark";
        const contract = data.identity(l.tsSec - 1800, l.tsSec);
        const reasons = { ...out.reasons };
        if (!manual) for (const k of ["confidence", "note", "viewMode", "screen", "futureSeconds", "createdUs", "updatedUs"])
          reasons[k] = "not_manually_observed";
        const values = { ...l, ...out.values, row_type: row.type, matched_mark_id: row.source.id,
          label: manual ? l.kind : "none", contract,
          quality: `${data.complete(data.session, l.tsSec) && contract !== "MIXED" ? "complete" : "partial"}${contract === "UNKNOWN" ? "|contract_unknown" : ""}`,
          confidence: manual ? l.confidence : null, note: manual ? l.note : null,
          viewMode: manual ? l.viewMode : null, screen: manual ? l.screen : null,
          futureSeconds: manual ? l.futureSeconds : null, createdUs: manual ? l.createdUs : null, updatedUs: manual ? l.updatedUs : null,
          missing_reasons: JSON.stringify(reasons) };
        for (const k of Object.keys(out.reasons)) missing[k] = (missing[k] ?? 0) + 1;
        await write(csv, Object.keys(COLUMNS).map(k => csvCell(values[k as keyof typeof values])).join(",") + "\r\n");
      }
    }
    csv.end(); await finished(csv);
  } catch (e) { csv.destroy(); await finished(csv).catch(() => {}); throw e; }
  const tally = (field: "kind" | "viewMode" | "symbol") => marks.reduce<Record<string, number>>((out, l) =>
    ({ ...out, [l[field]]: (out[l[field]] ?? 0) + 1 }), {});
  const summary = { version: 1, symbol: job.symbol, period: { fromSec: job.fromSec, toSec: job.toSec, halfOpen: true },
    counts, byKind: tally("kind"), byViewMode: tally("viewMode"), bySymbol: tally("symbol"), missing,
    candidateCount, controls, volatilityQuintileCuts: cuts.map(c => c.map(v => Number.isFinite(v) ? v : null)),
    selection: "FNV1a-derived deterministic score from mark ID and candidate second; within requested UTC range; distinct sessions for random; nonoverlapping 15m near-misses",
    inputs: [...versions].sort((a, b) => a[0] - b[0]).map(([hour, hashes]) => ({ hour, ...hashes })),
    rawMarketDataIncluded: false };
  await fs.writeFile(path.join(job.directory, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(job.directory, "columns.md"),
    "# 転換点研究用の派生特徴\n\n全特徴はtsSec未満のみ。結果・対照選択の未来参照は別扱い。CT17セッション、DST対応。Nは総数量・VPへ含め方向計算から除外。UNKNOWNを既知限月へ接続しない。\n\n"
    + "CSVは同一列、欠けは空欄＋missing_reasons。既知の0は0。対照のlabel=noneは反転しないという正解を保証しない。反応回数だけで売買優位性を示すものではない。\n\n"
    + "ボラ5分位は書出期間内の全適格秒の最近傍順位20/40/60/80%。同値は下の分位。ニアミス反転幅は元マーク前後15分全値幅の半分、切上げ最低1tick。秒内の順序が不明になる候補は反転判定から保守的に除外する。\n\n"
    + "CVDダイバージェンスのイベント順序ソートは300秒ずつ・最大10万レコード。超過時はその列だけ空欄（event_order_sort_budget）。親プロセスではソートしない。\n\n"
    + Object.entries(COLUMNS).map(([k, v]) => `- **${k}**: ${v}`).join("\n"), { mode: 0o600 });
  const zip = path.join(job.directory, "features.zip");
  await zipFiles(zip, ["events.csv", "columns.md", "summary.json"].map(name => ({ name, file: path.join(job.directory, name) })));
  return { zip, summary };
}
