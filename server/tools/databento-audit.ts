import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { scanCsv, convert } from "../src/import/databento-csv.ts";
const arg = (n: string) => process.argv.find(s => s.startsWith(`--${n}=`))?.slice(n.length + 3);
const zip = arg("zip")!, output = arg("out")!;
if (!zip || !output) throw Error("--zip and --out required");
await fs.mkdir(output, { recursive: true });
const metadata = JSON.parse(execFileSync("unzip", ["-p", zip, "metadata.json"], { encoding: "utf8" }));
const manifest = JSON.parse(execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" }));
const condition = JSON.parse(execFileSync("unzip", ["-p", zip, "condition.json"], { encoding: "utf8" }));
if (metadata.query.schema !== "trades" || !metadata.customizations.pretty_px || !metadata.customizations.pretty_ts) throw Error("unsupported_csv_encoding");
const hash = createHash("sha256"); for await (const b of createReadStream(zip)) hash.update(b);
const archiveSha256 = hash.digest("hex"), files = [];
const only = arg("member");
for (const f of manifest.files.filter((f: { filename: string }) => f.filename.endsWith(".csv.zst") && (!only || f.filename === only))) {
  const contracts: Record<string, { count: number; buy: number; sell: number; unknown: number; minUs: number; maxUs: number }> = {};
  const errors: { row: number; reason: string }[] = []; let errorCount = 0;
  const checked = await scanCsv(zip, f.filename, f.hash, async (line, row) => {
    try {
      const c = convert(line, row), t = c.trade;
      const x = contracts[c.rawContract] ??= { count: 0, buy: 0, sell: 0, unknown: 0, minUs: t.tsUs, maxUs: t.tsUs };
      x.count++; x[t.side] += t.size; x.minUs = Math.min(x.minUs, t.tsUs); x.maxUs = Math.max(x.maxUs, t.tsUs);
    } catch (e) { errorCount++; if (errors.length < 10) errors.push({ row, reason: (e as Error).message }); }
  });
  files.push({ member: f.filename, ...checked, contracts, errorCount, errors });
  await fs.writeFile(path.join(output, "audit.json"), JSON.stringify({ archiveSha256, metadata, condition, files }, null, 2));
  console.log(JSON.stringify({ member: f.filename, rows: checked.rows, contracts, errorCount }));
}
