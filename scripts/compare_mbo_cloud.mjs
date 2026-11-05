/** Read-only App Storage comparison; never instantiates a production store/writer. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReplitObjects, digest } from "../server/src/store/objects.ts";
import { columnFileRange } from "../server/src/store/records.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/research-v2/mbo-01");
const copy = path.join(root, "cloud-copy");
fs.mkdirSync(copy, { recursive: true });
const objects = new ReplitObjects();
const provenanceFile = path.join(copy, "objects.json");
const provenance = fs.existsSync(provenanceFile) ? JSON.parse(fs.readFileSync(provenanceFile, "utf8")) : [];
const rows = [];
const nList = [1, 5, 10, 50];
const next = iterator => iterator.next().then(x => x.done ? null : x.value);
for (let hh = 13; hh < 24; hh++) {
  const hour = String(hh).padStart(2, "0"), day = "2026-11-03";
  const name = `prod/instruments/GC/columns/GC/1s/${day}/${hour}.bin.gz`;
  const file = path.join(copy, `${day}-${hour}.bin.gz`);
  let saved = provenance.find(x => x.name === name);
  if (!saved) {
    try {
      const generation = await objects.downloadVersion(name, file);
      saved = { name, generation, file: path.relative(root, file), present: generation !== null };
      if (generation !== null) Object.assign(saved, { sha256: await digest(file), bytes: fs.statSync(file).size });
      provenance.push(saved);
      fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2) + "\n");
    } catch {
      // Do not print SDK exceptions, which can contain signed URLs or auth details.
      rows.push({ utcHour: `${day}T${hour}:00:00Z`, error: "cloud_read_failed" }); continue;
    }
  }
  const row = { utcHour: `${day}T${hour}:00:00Z`, filePresent: saved.present,
    appSeconds: 0, mboSeconds: 0, overlapSeconds: 0, bestBidMatches: 0, bestAskMatches: 0,
    bothMatches: 0, sharedBidLevels: 0, sharedAskLevels: 0, unionLevels: 0,
    sharedLevels: 0, bestBidAbsoluteTickDifference: 0, bestAskAbsoluteTickDifference: 0,
    bboPairs: 0, examples: [], quantity: Object.fromEntries(nList.map(n => [n, {
      pairs: 0, absoluteDifference: 0, appQuantity: 0, mboQuantity: 0,
      rankPairs: 0, rankAbsoluteDifference: 0,
    }])) };
  const mboFile = path.join(root, "rebuilt/GCZ26", day, `${hour}.bin.gz`);
  if (!saved.present) { rows.push(row); continue; }
  if (await digest(file) !== saved.sha256) throw Error("cloud_copy_hash_changed");
  if (!fs.existsSync(mboFile)) { rows.push({ ...row, error: "mbo_hour_missing" }); continue; }
  const start = Date.parse(`${day}T${hour}:00:00Z`) / 1000, end = start + 3600;
  const appIterator = columnFileRange(file, start, end), mboIterator = columnFileRange(mboFile, start, end);
  let a = await next(appIterator), b = await next(mboIterator);
  try {
    while (a || b) {
      if (a && (!b || a.tsSec < b.tsSec)) { row.appSeconds++; a = await next(appIterator); continue; }
      if (b && (!a || b.tsSec < a.tsSec)) { row.mboSeconds++; b = await next(mboIterator); continue; }
      row.appSeconds++; row.mboSeconds++; row.overlapSeconds++;
      const bid = a.bids[0]?.price === b.bids[0]?.price && a.bids.length && b.bids.length;
      const ask = a.asks[0]?.price === b.asks[0]?.price && a.asks.length && b.asks.length;
      if (bid) row.bestBidMatches++; if (ask) row.bestAskMatches++; if (bid && ask) row.bothMatches++;
      if (a.bids.length && b.bids.length && a.asks.length && b.asks.length) {
        row.bboPairs++;
        row.bestBidAbsoluteTickDifference += Math.abs(a.bids[0].price - b.bids[0].price);
        row.bestAskAbsoluteTickDifference += Math.abs(a.asks[0].price - b.asks[0].price);
        if (row.examples.length < 2) row.examples.push({ tsSec: a.tsSec,
          appBid: a.bids[0].price, appAsk: a.asks[0].price, mboBid: b.bids[0].price, mboAsk: b.asks[0].price });
      }
      for (const side of ["bids", "asks"]) {
        const other = new Map(b[side].map(x => [x.price, x.size]));
        const common = a[side].filter(x => other.has(x.price)).length;
        row[side === "bids" ? "sharedBidLevels" : "sharedAskLevels"] += common;
        row.sharedLevels += common;
        row.unionLevels += new Set([...a[side].map(x => x.price), ...other.keys()]).size;
        for (const n of nList) {
          const metric = row.quantity[n];
          for (let i = 0; i < Math.min(n, a[side].length); i++) {
            const original = a[side][i], size = other.get(original.price) ?? 0;
            metric.pairs++; metric.absoluteDifference += Math.abs(original.size - size);
            metric.appQuantity += original.size; metric.mboQuantity += size;
            if (b[side][i]) {
              metric.rankPairs++; metric.rankAbsoluteDifference += Math.abs(original.size - b[side][i].size);
            }
          }
        }
      }
      a = await next(appIterator); b = await next(mboIterator);
    }
  } finally { await appIterator.return(); await mboIterator.return(); }
  for (const metric of Object.values(row.quantity)) {
    metric.priceAlignedMAE = metric.pairs ? metric.absoluteDifference / metric.pairs : null;
    metric.rankAlignedMAE = metric.rankPairs ? metric.rankAbsoluteDifference / metric.rankPairs : null;
  }
  row.bestBidMatchRate = row.overlapSeconds ? row.bestBidMatches / row.overlapSeconds : null;
  row.bestAskMatchRate = row.overlapSeconds ? row.bestAskMatches / row.overlapSeconds : null;
  row.bothMatchRate = row.overlapSeconds ? row.bothMatches / row.overlapSeconds : null;
  row.sharedOf800 = row.overlapSeconds ? row.sharedLevels / (800 * row.overlapSeconds) : null;
  row.positiveLevelJaccard = row.unionLevels ? row.sharedLevels / row.unionLevels : null;
  row.bestBidMAETicks = row.bboPairs ? row.bestBidAbsoluteTickDifference / row.bboPairs : null;
  row.bestAskMAETicks = row.bboPairs ? row.bestAskAbsoluteTickDifference / row.bboPairs : null;
  rows.push(row);
  console.log(JSON.stringify({ hour: row.utcHour, overlapping: row.overlapSeconds,
    bothBboMatch: row.bothMatchRate, maeTop1: row.quantity[1].priceAlignedMAE }));
}
fs.writeFileSync(path.join(root, "cloud-comparison.json"), JSON.stringify({
  symbol: "GC", contract: "GCZ26", startUtc: "2026-11-03T13:00:00Z",
  endUtcExclusive: "2026-11-04T00:00:00Z", productionOperations: "read_only_versioned_download",
  caveat: "Product board files do not identify contract; calendar/price similarity cannot prove its identity.",
  quantityDefinition: "Price-aligned to application's first N positive levels per side; rank-aligned also recorded.",
  overlapDefinition: "shared positive levels / 800; positive-level Jaccard recorded separately",
  maxRssKiB: process.resourceUsage().maxRSS, rows,
}, null, 2) + "\n");
