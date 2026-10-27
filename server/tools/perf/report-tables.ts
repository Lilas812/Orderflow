import * as fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve("data/perf-memory");
const summary = JSON.parse(await fs.readFile(path.join(root, "summary.json"), "utf8"));
const cases = summary.memory.filter((r: any) => r.formalCandidate);
const labels: Record<string, string> = {
  live: "1画面ライブ10分", backfill: "起動時3時間取り込み",
  replay: "保存30分・10倍リプレイ", ranges: "60分range×5",
  dual: "2画面10分＋過去取得", live30: "1画面ライブ30分",
};
const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—";
const pair = (rss: unknown, heap: unknown) => `${number(rss)} / ${number(heap)}`;
const out = [
  "### RSS / heapUsed の比較（MiB）", "",
  "開始は初回HTTP状態値。最大はそれぞれ独立した最大値で、同時刻とは限らない。終了・回復は5秒サンプル。回復はブラウザ終了後60秒。公開接続確認・最終画像確認は集計から分離。", "",
  "| 場面 | 前後 | 開始 | 最大 | 終了 | 回復後 | 状態 |",
  "| --- | --- | ---: | ---: | ---: | ---: | --- |",
];
for (const scene of ["live", "backfill", "replay", "ranges", "dual", "live30"]) {
  for (const r of cases.filter((r: any) => r.scenario === scene)) {
    const end = r.guard ? r.recoveryEnd : r.activeEnd;
    out.push(`| ${labels[scene]} | ${r.phase.endsWith("before") ? "前" : "後"} | ${pair(r.before?.rssMiB, r.before?.heapMiB)} | ${pair(r.peak?.rssMiB, r.heapPeakMiB)} | ${pair(end?.rssMiB, end?.heapMiB)} | ${r.guard ? "—（省略）" : pair(r.recoveryEnd?.rssMiB, r.recoveryEnd?.heapMiB)} | ${r.guard ? "RSSガード中断→OOM" : r.completed ? "完走" : "未完了"} |`);
  }
}
out.push("", "変更前リプレイはガード時点までのRSS最大。SIGTERM後も残った読み込みにより、別の実サーバーログではRSS **4,229,144,576 bytes = 4,033.23MiB**、その後NodeのOOM・exit134。回復60秒は実施できていない。", "",
  "### カーネルRSS上限値・CPU・接続数", "",
  "CPUは5秒区間のプロセスCPU差分。100%は1コア相当。起動・回復を含み、公開接続確認は除く。", "",
  "| 場面 | 前後 | VmHWM MiB | CPU平均 / 最大 % | 制御区間の最大接続数 | 記録 |",
  "| --- | --- | ---: | ---: | ---: | --- |");
for (const r of cases) out.push(`| ${labels[r.scenario]} | ${r.phase.endsWith("before") ? "前" : "後"} | ${number(r.peakHighWaterMiB)} | ${pair(r.meanCpuPercent, r.peakCpuPercent)} | ${r.maxConnected} | ${r.phase}/${path.basename(r.directory)} |`);
out.push("", "### 固定データ描画比較（ms、平均 / 最大）", "",
  "| 操作 | 変更前 | 最終変更後 | フレーム数 前 / 後 |", "| --- | ---: | ---: | ---: |");
for (const operation of ["price-zoom", "price-reset", "pan", "time-zoom"]) {
  const b = summary.rendering.find((r: any) => r.phase === "isolated-before" && r.operation === operation);
  const a = summary.rendering.find((r: any) => r.phase === "isolated-final" && r.operation === operation);
  out.push(`| ${operation} | ${pair(b?.metrics.totalMs.mean, b?.metrics.totalMs.max)} | ${pair(a?.metrics.totalMs.mean, a?.metrics.totalMs.max)} | ${b?.count ?? "—"} / ${a?.count ?? "—"} |`);
}
const layers: Record<string, string> = {
  heatmapMs: "ヒートマップ", tradesMs: "約定", bookMs: "現在の板", bigMs: "大口板",
  priceAxisMs: "価格軸", timeAxisMs: "時間軸", otherMs: "その他",
  aggregationMs: "内訳：板の集計", scaleMs: "内訳：色基準", colorMs: "内訳：着色", uploadMs: "内訳：画像転送",
};
out.push("", "### 層ごとの描画時間（ms、平均 / 最大）", "",
  "内訳はヒートマップの包含時間。合計しない。層ごとの最大も異なるフレームなので合算しない。", "",
  "| 層 | 価格zoom前 | 価格zoom後 | 時間zoom前 | 時間zoom後 |", "| --- | ---: | ---: | ---: | ---: |");
for (const [key, label] of Object.entries(layers)) {
  const values = ["price-zoom", "time-zoom"].flatMap(operation => ["isolated-before", "isolated-final"].map(phase => {
    const metric = summary.rendering.find((r: any) => r.phase === phase && r.operation === operation)?.metrics[key];
    return pair(metric?.mean, metric?.max);
  }));
  out.push(`| ${label} | ${values.join(" | ")} |`);
}
out.push("", "### 検証ブラウザ終了の確認", "",
  "| 場面 | 前後 | Chromium PID | 本体終了 | デバッグポート閉鎖 | ページ数 |", "| --- | --- | ---: | --- | --- | ---: |");
for (const r of cases) {
  const b = r.browserClosed;
  out.push(`| ${labels[r.scenario]} | ${r.phase.endsWith("before") ? "前" : "後"} | ${b?.pid ?? "対象なし"} | ${b ? b.exited : "ブラウザなし"} | ${b ? b.portClosed : "対象なし"} | ${b?.targetIds?.length ?? 0} |`);
}
await fs.writeFile(path.join(root, "report-tables.md"), out.join("\n") + "\n");
process.stdout.write(`Generated ${out.length} lines: data/perf-memory/report-tables.md\n`);
