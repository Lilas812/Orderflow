/** Create a local report only, then exit. No production write adapter or app startup. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { sha } from "../src/import/databento-stage.ts";
import { purchasedVolumes, selectFrontMonths } from "../src/import/databento-front-month.ts";
import { readPinnedDay } from "../src/import/longvp-evidence.ts";
import { validateInventory, type Inventory } from "../src/import/longvp-promotion.ts";

const allowed = ["nq-import", "gc-import", "nq-inventory", "gc-inventory", "out"], args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.+)$/.exec(arg);
  if (!m || !allowed.includes(m[1]!) || args.has(m[1]!)) throw Error("unsupported_or_duplicate_option");
  args.set(m[1]!, m[2]!);
}
if (allowed.some(k => !args.has(k))) throw Error("missing_report_argument");
const out = path.resolve(args.get("out")!);
if (!out.startsWith(path.resolve("data/longvp-front-month-reports") + path.sep)) throw Error("isolated_report_output_required");
try { await fs.lstat(out); throw Error("report_already_exists"); }
catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
const results = [];
for (const symbol of ["NQ", "GC"] as const) {
  const prefix = symbol.toLowerCase(), inventoryFile = args.get(`${prefix}-inventory`)!;
  const inventoryHash = await sha(inventoryFile);
  const inventory = validateInventory(JSON.parse(await fs.readFile(inventoryFile, "utf8")) as Inventory, symbol);
  const existing = new Map<string, string[]>();
  for (const object of inventory.objects) {
    const day = await readPinnedDay(object, symbol);
    if (!object.name.endsWith(`/${day.tradingDate}.json.gz`)) throw Error("snapshot_date_mismatch");
    existing.set(day.tradingDate, [...new Set(day.contracts.map(c => c.contract))]);
  }
  const raw = await purchasedVolumes(args.get(`${prefix}-import`)!, symbol);
  if (await sha(inventoryFile) !== inventoryHash) throw Error("inventory_changed_during_read");
  const days = selectFrontMonths(raw.daily, raw.fromUs, raw.toUs, existing);
  if (days.reduce((n, d) => n + d.totalVolume, 0) !== raw.audit.quantity
    - raw.audit.excludedMaintenanceVolume - raw.audit.outsideRequestedVolume)
    throw Error("reported_day_volume_does_not_reconcile_to_purchased_total");
  results.push({ symbol, inventoryFile, inventoryHash, capturedAt: inventory.capturedAt,
    fromUtc: new Date(raw.fromUs / 1000).toISOString(), toUtc: new Date(raw.toUs / 1000).toISOString(),
    audit: raw.audit, days });
}
const note = "一覧のみ。本番未反映。CT17:00〜翌16:00（半開区間）、日付は終了側のCT日付。B/A/N全量、スプレッド除外。前日より古い限月へは戻さない。次点は選択した期近以外の最多限月。全量の同数時は前日の期近を優先し、それ以外は満期の早い順。購入期間端の部分日は参考値。既存との比較は取得時点の日次ファイル内の全限月を正規化して行い、現行保存のCT16〜17時を今回の出来高選定に含めない。保存形式や取引日境界は変更していない。";
const lines = ["# 購入出来高による期近候補一覧", "", note, ""];
const csv = ["symbol,trading_date,front_contract,front_volume,second_contract,second_volume,daily_leader,daily_leader_volume,monotonic_held,partial_purchase_period,existing_contracts,existing_status,from_utc,to_utc"];
const fmt = (n: number | undefined) => n === undefined ? "—" : n.toLocaleString("en-US");
for (const result of results) {
  lines.push(`## ${result.symbol}`, "", `既存ファイル照合時点: ${result.capturedAt}`, "",
    "| 取引日（終了日） | 期近候補 | 出来高（枚） | 次点 | 出来高（枚） | 既存との比較 | 注記 |",
    "|---|---|---:|---|---:|---|---|");
  for (const d of result.days) {
    const status = d.existingStatus === "mismatch" ? `★不一致 (${d.existingContracts.join("/")})`
      : d.existingStatus === "match" ? `一致 (${d.existingContracts.join("/")})`
        : d.existingStatus === "not_present" ? "既存なし" : d.existingStatus;
    const flags = [d.partialPurchasePeriod ? "購入期間の部分日" : "", d.monotonicHeld ? "後戻り禁止を適用" : "",
      !d.totalVolume ? "購入約定なし" : ""].filter(Boolean).join("・");
    lines.push(`| ${d.date} | ${d.front?.contract ?? "未選択"} | ${fmt(d.front?.volume)} | ${d.runnerUp?.contract ?? "—"} | ${fmt(d.runnerUp?.volume)} | ${status} | ${flags} |`);
    csv.push([result.symbol, d.date, d.front?.contract ?? "", d.front?.volume ?? "", d.runnerUp?.contract ?? "",
      d.runnerUp?.volume ?? "", d.dailyLeader?.contract ?? "", d.dailyLeader?.volume ?? "", d.monotonicHeld,
      d.partialPurchasePeriod, d.existingContracts.join("/"), d.existingStatus, d.fromUtc, d.toUtc].join(","));
  }
  lines.push("", `検証: 原約定 ${fmt(result.audit.rows)}行、${fmt(result.audit.quantity)}枚。除外スプレッド ${fmt(result.audit.excludedSpreadRows)}行。CT16〜17時除外 ${fmt(result.audit.excludedMaintenanceRows)}行・${fmt(result.audit.excludedMaintenanceVolume)}枚。`,
    `原約定ファイル ${result.audit.files}個のSHA-256・展開行順hash・限月別buy/sell/unknown全量が既存取込記録と一致。`, "");
}
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.mkdir(out, { mode: 0o700 });
await fs.writeFile(path.join(out, "report.json"), JSON.stringify({ version: 1, mode: "proposal_only", note, results }, null, 2), { flag: "wx" });
await fs.writeFile(path.join(out, "report.md"), lines.join("\n"), { flag: "wx" });
await fs.writeFile(path.join(out, "report.csv"), "\uFEFF" + csv.join("\r\n") + "\r\n", { flag: "wx" });
console.log(JSON.stringify({ out, results: results.map(r => ({ symbol: r.symbol, days: r.days.length,
  mismatches: r.days.filter(d => d.existingStatus === "mismatch").map(d => d.date),
  partialDays: r.days.filter(d => d.partialPurchasePeriod).map(d => d.date), audit: { ...r.audit, inputs: undefined } })) }, null, 2));
