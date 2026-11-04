import { auditStoredBoards } from "../src/store/board-audit.ts";
import { ReplitObjects } from "../src/store/objects.ts";

const args = process.argv.slice(2);
function arg(name: string, fallback: string) {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1] ?? "";
}
if (args.includes("--help")) {
  console.log("Read-only: node server/tools/audit-board-storage.ts --start 2026-11-04 --end 2026-11-05 --format json|markdown");
  process.exit(0);
}
const start = Date.parse(arg("--start", "2026-11-04")) / 1000;
const end = args.includes("--end") ? Date.parse(arg("--end", "")) / 1000 : Math.floor(Date.now() / 3600000) * 3600;
const format = arg("--format", "markdown");
if (!["json", "markdown"].includes(format)) throw Error("audit_invalid_format");
const result = await auditStoredBoards(new ReplitObjects(), start, end);
if (format === "json") console.log(JSON.stringify(result, null, 2));
else {
  console.log(`UTC [${result.startUtc}, ${result.endUtcExclusive})`);
  console.log("|銘柄|UTC時間|約定coverage秒|板coverage秒|板実秒|実秒率|エラー|");
  console.log("|---|---|---:|---:|---:|---:|---|");
  for (const r of result.rows) console.log(`|${r.symbol}|${r.utcHour}|${r.tickCoverage}|${r.bookCoverage}|${r.actualSeconds ?? "不明"}|${r.actualRatio === null ? "不明" : (100 * r.actualRatio).toFixed(2) + "%"}|${r.error ?? ""}|`);
  if (result.changedIndexes.length) console.log("注意：読取中にcoverage索引が変化: " + result.changedIndexes.join(","));
}
if (result.rows.some(r => r.error)) process.exitCode = 1;
