import * as fs from "node:fs/promises";
import path from "node:path";
import { tradeFileEntries } from "../src/store/records.ts";
import { fields } from "../src/import/databento-csv.ts";
const active = JSON.parse(await fs.readFile("data/databento-import/active.json", "utf8"));
const source: Record<string, { rows: number; buy: number; sell: number; unknown: number }> = {};
const excluded = { rows: 0, buy: 0, sell: 0, unknown: 0, invalid: 0 };
for (const item of active.staged) {
  for (const [contract, value] of Object.entries(item.contracts) as [string, any][]) {
    const s = source[contract] ??= { rows: 0, buy: 0, sell: 0, unknown: 0 };
    s.rows += value.count; s.buy += value.buy; s.sell += value.sell; s.unknown += value.unknown;
  }
  for (const output of item.outputs) if (output.path === "excluded.jsonl.gz") {
    for await (const { line } of tradeFileEntries(path.join(active.stage, item.sha256, output.path))) {
      const row = JSON.parse(line);
      excluded.rows++;
      const c = fields(row.raw), n = Number(c[9]);
      if (row.reason !== "calendar_spread" || !Number.isSafeInteger(n) || !["B", "A", "N"].includes(c[6]!)) { excluded.invalid++; continue; }
      excluded[c[6] === "B" ? "buy" : c[6] === "A" ? "sell" : "unknown"] += n;
    }
  }
}
const result = { source, excluded, adopted: Object.fromEntries(Object.entries(active.rebuilt).map(([c, r]: [string, any]) => [c, r.totals])) };
await fs.writeFile("data/databento-import/inventory.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
