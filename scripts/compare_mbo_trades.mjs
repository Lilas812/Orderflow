/** Compare MBO T records with immutable purchased CSV stages, hour by hour. */
import fs from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(workspace, "data/research-v2/mbo-01");
const rebuilt = path.join(root, "rebuilt/GCZ26");
const stageRoot = path.join(workspace, "data/databento-gc-import/verified-v1");
const stages = [];
for (const kind of ["known", "unknown"]) for (const name of fs.globSync(`*/*/${kind}/GCZ26/*/*.jsonl.gz`, { cwd: stageRoot })) {
  stages.push(path.join(stageRoot, name));
}
const byHour = new Map();
for (const file of stages) {
  const date = path.basename(path.dirname(file)), hh = path.basename(file).slice(0, 2);
  const key = date + "T" + hh;
  if (!byHour.has(key)) byHour.set(key, []);
  byHour.get(key).push(file);
}
const sourceHashes = [], rows = [];
async function* lines(file, observeHash = false) {
  const source = fs.createReadStream(file), hash = createHash("sha256");
  source.on("data", b => hash.update(b));
  const input = file.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  source.on("error", e => input.destroy(e));
  let failure;
  const reader = createInterface({ input, crlfDelay: Infinity });
  input.on("error", e => { failure = e; reader.close(); });
  try {
    for await (const line of reader) if (line) yield JSON.parse(line);
    if (failure) throw failure;
    if (observeHash) sourceHashes.push({ path: path.relative(workspace, file), sha256: hash.digest("hex") });
  } finally { reader.close(); source.destroy(); if (input !== source) input.destroy(); }
}
const stats = () => ({ count: 0, size: 0, buy: 0, sell: 0, unknown: 0, cells: new Map() });
function add(s, trade) {
  const second = Math.floor(trade.tsUs / 1000000), key = second + ":" + trade.price;
  const cell = s.cells.get(key) ?? { count: 0, size: 0 };
  cell.count++; cell.size += trade.size; s.cells.set(key, cell);
  s.count++; s.size += trade.size;
  const side = trade.side === "B" || trade.side === "buy" ? "buy"
    : trade.side === "A" || trade.side === "sell" ? "sell" : "unknown";
  s[side] += trade.size;
}
for (const day of fs.readdirSync(rebuilt).filter(x => /^\d{4}-\d\d-\d\d$/.test(x)).sort()) {
  // The previously purchased trades end at 2026-10-30T00:00:00Z.
  if (day >= "2026-10-30") continue;
  const file = path.join(rebuilt, day, "mbo-trades.jsonl");
  if (!fs.existsSync(file)) throw Error("rebuild_not_complete_" + day);
  const iter = lines(file)[Symbol.asyncIterator]();
  let pending = await iter.next();
  try {
    for (let hour = 0; hour < 24; hour++) {
      const hh = String(hour).padStart(2, "0"), hourKey = day + "T" + hh;
      const start = Date.parse(hourKey + ":00:00Z") / 1000, end = start + 3600;
      const mbo = stats(), csv = stats();
      while (!pending.done && pending.value.tsUs / 1000000 < end) {
        if (pending.value.tsUs / 1000000 < start) throw Error("mbo_trade_hour_rollback");
        add(mbo, pending.value); pending = await iter.next();
      }
      const sources = byHour.get(hourKey) ?? [];
      if (!sources.length && !mbo.count) continue;
      for (const source of sources) for await (const trade of lines(source, true)) {
        if (trade.contract !== "GCZ26" || trade.source?.rawSymbol !== "GCZ6") throw Error("stage_contract_mismatch");
        if (trade.tsUs / 1000000 < start || trade.tsUs / 1000000 >= end) throw Error("stage_hour_mismatch");
        add(csv, trade);
      }
      let mismatchCells = 0;
      const examples = [];
      for (const key of new Set([...mbo.cells.keys(), ...csv.cells.keys()])) {
        const a = mbo.cells.get(key) ?? { count: 0, size: 0 }, b = csv.cells.get(key) ?? { count: 0, size: 0 };
        if (a.count !== b.count || a.size !== b.size) {
          mismatchCells++;
          if (examples.length < 3) examples.push({ secondPrice: key, mbo: a, csv: b });
        }
      }
      const { cells: a, ...mboCounts } = mbo, { cells: b, ...csvCounts } = csv;
      rows.push({ utcHour: hourKey + ":00:00Z", stageFiles: sources.length,
        mbo: mboCounts, csv: csvCounts, mismatchCells, examples,
        matched: mismatchCells === 0 && ["count", "size", "buy", "sell", "unknown"].every(k => mbo[k] === csv[k]) });
    }
  } finally { await iter.return(); }
  console.log(JSON.stringify({ day, hoursCompared: rows.filter(r => r.utcHour.startsWith(day)).length }));
}
const result = { contract: "GCZ26", comparison: "per_UTC_second_and_price_trade_count_and_size",
  direction: "buy/sell/unknown volumes additionally checked; no deduplication",
  sourceHashes, rows, mismatchHours: rows.filter(r => !r.matched).length,
  noPriorPurchasedTradesFrom: "2026-10-30T00:00:00Z", maxRssKiB: process.resourceUsage().maxRSS };
fs.writeFileSync(path.join(root, "trade-comparison.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ hours: rows.length, mismatchHours: result.mismatchHours, maxRssKiB: result.maxRssKiB }));
