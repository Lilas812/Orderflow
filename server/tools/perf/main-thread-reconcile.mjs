import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tradeFileRows } from "../../src/store/records.ts";
import { dayBounds } from "../../src/long-vp/day.ts";
const manifest = JSON.parse(await fs.readFile("data/dev/main-thread-snapshot/manifest.json", "utf8"));
const file = "data/dev/main-thread-rebuild/result.json";
const report = JSON.parse(await fs.readFile(file, "utf8")), results = [];
const hash = map => createHash("sha256").update(JSON.stringify([...map].sort((a, b) => a[0] - b[0]))).digest("hex");
for (const row of report.result.filter(x => x.saved?.saved)) {
  const bounds = dayBounds(row.date), prices = new Map(), fromDay = new Map();
  let count = 0, quantity = 0, buy = 0, sell = 0, unknown = 0;
  for (const source of manifest.files.filter(x => x.source.includes(`/trades/${row.symbol}/`))) {
    for await (const t of tradeFileRows(source.file)) {
      if (t.tsUs < bounds.startUs || t.tsUs >= bounds.endUs) continue;
      count++; quantity += t.size;
      if (t.side === "buy") buy += t.size; else if (t.side === "sell") sell += t.size; else unknown += t.size;
      prices.set(t.price, (prices.get(t.price) ?? 0) + t.size);
    }
  }
  const day = JSON.parse(gunzipSync(await fs.readFile(row.file)));
  for (const r of day.vp30m) fromDay.set(r[1], (fromDay.get(r[1]) ?? 0) + r[2] + r[3] + (r[5] ?? 0));
  const sourceHash = hash(prices), dayHash = hash(fromDay);
  const match = count === row.trades && quantity === row.quantity && sourceHash === dayHash;
  results.push({ symbol: row.symbol, count, quantity, buy, sell, unknown, sourcePriceQuantityHash: sourceHash, dayPriceQuantityHash: dayHash, match });
  if (!match) process.exitCode = 1;
}
await fs.writeFile("data/dev/main-thread-rebuild/reconciliation.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
