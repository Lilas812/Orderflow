/** Independent streaming DBN quality audit. No network, no original writes. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanDbn } from "./mbo_dbn.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/research-v2/mbo-01");
const rows = [];
for (const file of fs.readdirSync(path.join(root, "raw")).filter(x => x.endsWith(".mbo.dbn.zst")).sort()) {
  let id;
  const histogram = {}, badExamples = [];
  let badBook = 0, aggregated = 0, badReceive = 0, snapshot = 0;
  const result = await scanDbn(path.join(root, "raw", file), m => {
    const symbol = m.mappings.find(x => x.raw === "GCZ6");
    if (!symbol || symbol.intervals.length !== 1) throw Error("ambiguous_daily_GCZ6_mapping");
    id = Number(symbol.intervals[0].symbol);
  }, r => {
    if (r[1] !== 160 || r.length !== 56) throw Error("unexpected_record_type");
    if (r.readUInt32LE(4) !== id) return;
    const flags = r[36];
    histogram[flags] = (histogram[flags] ?? 0) + 1;
    if (flags & 32) snapshot++;
    if (flags & 8) badReceive++;
    if (flags & (16 | 64)) aggregated++;
    if (flags & 4) {
      badBook++;
      if (badExamples.length < 3) badExamples.push({ flags, tsEventNs: r.readBigUInt64LE(8).toString() });
    }
  });
  rows.push({ file, selectedInstrumentId: id, histogram, badBook, aggregated,
    badReceive, snapshot, badExamples, compressedSha256: result.compressedSha256 });
}
fs.writeFileSync(path.join(root, "dbn-quality.json"), JSON.stringify({ rows }, null, 2) + "\n");
console.log(JSON.stringify({ files: rows.length, badBook: rows.reduce((n, r) => n + r.badBook, 0),
  aggregated: rows.reduce((n, r) => n + r.aggregated, 0), maxRssKiB: process.resourceUsage().maxRSS }));
