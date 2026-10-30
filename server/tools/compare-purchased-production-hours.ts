/** Read-only hourly comparison of purchased NQ and the captured prod/trades tape. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { tradeFileEntries } from "../src/store/records.ts";
import { session, parts } from "../src/long-vp/calendar.ts";
import { verifyPinned } from "../src/import/longvp-evidence.ts";
import { sha } from "../src/import/databento-stage.ts";
const argv = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const m = /^--(inventory|report|out)=(.+)$/.exec(arg);
  if (!m || argv.has(m[1]!)) throw Error("invalid_hourly_argument");
  argv.set(m[1]!, m[2]!);
}
if (argv.size !== 3) throw Error("inventory_report_out_required");
const out = path.resolve(argv.get("out")!);
if (!out.startsWith(path.resolve("data/longvp-maintenance") + path.sep)) throw Error("isolated_output_required");
await fs.mkdir(out, { mode: 0o700 });
const inventoryFile = argv.get("inventory")!, inventoryHash = await sha(inventoryFile);
const inventory = JSON.parse(await fs.readFile(inventoryFile, "utf8"));
const reportFile = argv.get("report")!, reportHash = await sha(reportFile);
const report = JSON.parse(await fs.readFile(reportFile, "utf8"));
const r = report.results.find((r: { symbol: string }) => r.symbol === "NQ");
await verifyPinned({ file: r.audit.activeFile, sha256: r.audit.activeHash });
const active = JSON.parse(await fs.readFile(r.audit.activeFile, "utf8"));
const pins = new Map<string, string>(r.audit.inputs.map((p: { file: string; sha256: string }) => [path.resolve(p.file), p.sha256]));
type Stats = { count: number; quantity: number; buy: number; sell: number; unknown: number };
const empty = (): Stats => ({ count: 0, quantity: 0, buy: 0, sell: 0, unknown: 0 });
const gapEvidence: { date: string; fromSec: number; toSec: number; purchased: Stats; production: Stats }[] = [];
for (const o of inventory.objects.filter((o: { name: string }) =>
  /^prod\/longvp\/NQ\/days\/2026-10-(26|27)\.json\.gz$/.test(o.name))) {
  await verifyPinned(o);
  const d = JSON.parse(gunzipSync(await fs.readFile(o.file), { maxOutputLength: 4 * 1024 * 1024 }).toString());
  for (const [fromSec, toSec] of d.gaps)
    gapEvidence.push({ date: d.tradingDate, fromSec, toSec, purchased: empty(), production: empty() });
}
const hours = new Map<number, { date: string; purchased: Stats; production: Stats; longvp: number; object: string | null }>();
for (const date of ["2026-10-26", "2026-10-27"]) {
  const bounds = session(date);
  for (let us = bounds.startUs; us < bounds.endUs; us += 3600e6)
    hours.set(us / 1e6, { date, purchased: empty(), production: empty(), longvp: 0, object: null });
}
function add(s: Stats, t: { size: number; side: "buy" | "sell" | "unknown" }) {
  if (!Number.isSafeInteger(t.size) || t.size <= 0 || !["buy", "sell", "unknown"].includes(t.side)) throw Error("invalid_hourly_trade");
  s.count++; s.quantity += t.size; s[t.side] += t.size;
  if (!Number.isSafeInteger(s.quantity)) throw Error("unsafe_hourly_volume");
}
for (const staged of active.staged) for (const item of staged.outputs) {
  const m = /^(known|unknown)\/NQZ26\/(2026-10-(25|26|27))\/(\d\d)\.jsonl\.gz$/.exec(item.path);
  if (!m || !hours.has(Date.parse(`${m[2]}T${m[4]}:00:00Z`) / 1000)) continue;
  const file = path.resolve(active.stage, staged.sha256, item.path);
  if (pins.get(file) !== item.sha256) throw Error("purchased_file_not_in_approved_report");
  await verifyPinned({ file, sha256: item.sha256 });
  for await (const { trade: t } of tradeFileEntries(file)) {
    if (t.contract !== "NQZ26" || !Number.isSafeInteger(t.tsUs)) throw Error("invalid_purchased_identity");
    const h = hours.get(Math.floor(t.tsUs / 3600e6) * 3600);
    if (h) add(h.purchased, t);
    for (const g of gapEvidence) if (t.tsUs >= g.fromSec * 1e6 && t.tsUs < g.toSec * 1e6) add(g.purchased, t);
  }
  await verifyPinned({ file, sha256: item.sha256 });
}
for (const o of inventory.objects) {
  const raw = o.name.startsWith("prod/trades/NQ/"), vp = /^prod\/longvp\/NQ\/days\/2026-10-(26|27)\.json\.gz$/.test(o.name);
  if (!raw && !vp) continue;
  if (o.contentEncoding) throw Error("explicit_content_encoding_handling_required");
  await verifyPinned(o);
  if (raw) {
    const m = /(\d{4}-\d\d-\d\d)\/(\d\d)\.jsonl\.gz$/.exec(o.name);
    const namedHour = m ? Date.parse(`${m[1]}T${m[2]}:00:00Z`) / 1000 : NaN;
    if (hours.has(namedHour)) hours.get(namedHour)!.object = o.name;
    for await (const { trade: t } of tradeFileEntries(o.file)) {
      if (!Number.isSafeInteger(t.tsUs)) throw Error("invalid_production_timestamp");
      const h = hours.get(Math.floor(t.tsUs / 3600e6) * 3600);
      if (h) add(h.production, t);
      for (const g of gapEvidence) if (t.tsUs >= g.fromSec * 1e6 && t.tsUs < g.toSec * 1e6) add(g.production, t);
    }
  } else {
    const d = JSON.parse(gunzipSync(await fs.readFile(o.file), { maxOutputLength: 4 * 1024 * 1024 }).toString());
    for (const row of d.vp30m) {
      const h = hours.get(Math.floor(row[0] / 3600) * 3600);
      if (h) h.longvp += row[2] + row[3] + (row[5] ?? 0);
    }
  }
  await verifyPinned(o);
}
const rows = [...hours].map(([sec, h]) => ({ ...h, utc: new Date(sec * 1000).toISOString(),
  // ET is one hour ahead of CT for these dates.
  ctHour: (parts(sec * 1e6).hour + 23) % 24,
  missingCount: h.purchased.count - h.production.count, missingQuantity: h.purchased.quantity - h.production.quantity,
  missingPercent: h.purchased.quantity ? (h.purchased.quantity - h.production.quantity) / h.purchased.quantity * 100 : null,
  rawMinusLongvp: h.production.quantity - h.longvp }));
const totals = ["2026-10-26", "2026-10-27"].map(date => {
  const selected = rows.filter(r => r.date === date);
  const total = (f: (r: typeof rows[number]) => number) => selected.reduce((n, r) => n + f(r), 0);
  return { date, purchasedCount: total(r => r.purchased.count), productionCount: total(r => r.production.count),
    purchasedQuantity: total(r => r.purchased.quantity), productionQuantity: total(r => r.production.quantity),
    longvpQuantity: total(r => r.longvp), missingCount: total(r => r.missingCount), missingQuantity: total(r => r.missingQuantity),
    rawMinusLongvp: total(r => r.rawMinusLongvp),
    missingInsideDeclaredGaps: gapEvidence.filter(g => g.date === date).reduce((n, g) =>
      n + g.purchased.quantity - g.production.quantity, 0) };
});
for (const t of totals) if (t.purchasedQuantity !== r.days.find((d: { date: string }) => d.date === t.date).front.volume)
  throw Error("hourly_purchase_total_does_not_match_approved_list");
if (await sha(inventoryFile) !== inventoryHash || await sha(reportFile) !== reportHash) throw Error("hourly_inputs_changed");
await verifyPinned({ file: r.audit.activeFile, sha256: r.audit.activeHash });
const result = { version: 1, createdAt: new Date().toISOString(), inventoryFile, inventoryHash, reportFile, reportHash,
  note: "Signed differences, not an assertion that the two vendors publish identical trade boundaries. Production NQ includes all saved rows; purchased uses approved NQZ26. No prod file changed.",
  totals: totals.map(t => ({ ...t, missingOutsideDeclaredGaps: t.missingQuantity - t.missingInsideDeclaredGaps })),
  gapEvidence: gapEvidence.map(g => ({ ...g, fromUtc: new Date(g.fromSec * 1000).toISOString(),
    toUtc: new Date(g.toSec * 1000).toISOString(), difference: g.purchased.quantity - g.production.quantity })), rows };
await fs.writeFile(path.join(out, "hourly.json"), JSON.stringify(result, null, 2), { flag: "wx" });
await fs.writeFile(path.join(out, "hourly.csv"), "\uFEFFdate,utc,ct_hour,purchased_count,production_count,count_difference,purchased_quantity,production_quantity,quantity_difference,missing_percent,longvp_quantity,raw_minus_longvp,production_object\r\n"
  + rows.map(r => [r.date, r.utc, r.ctHour, r.purchased.count, r.production.count, r.missingCount, r.purchased.quantity,
    r.production.quantity, r.missingQuantity, r.missingPercent?.toFixed(4), r.longvp, r.rawMinusLongvp, r.object ?? ""].join(",")).join("\r\n") + "\r\n", { flag: "wx" });
console.log(JSON.stringify({ totals, rows: rows.length, out }, null, 2));
