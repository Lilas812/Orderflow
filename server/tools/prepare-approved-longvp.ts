/** Bounded offline rebuild of the approved 21 full sessions per symbol. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { dayBounds, serializeDay, datesBetween } from "../src/long-vp/day.ts";
import { session } from "../src/long-vp/calendar.ts";
import { validateDay } from "../src/long-vp/objects.ts";
import { tradeFileEntries } from "../src/store/records.ts";
import { sha } from "../src/import/databento-stage.ts";
import { verifyPinned } from "../src/import/longvp-evidence.ts";
const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const m = /^--(report|inventory|out)=(.+)$/.exec(arg);
  if (!m || args.has(m[1]!)) throw Error("invalid_prepare_argument");
  args.set(m[1]!, m[2]!);
}
if (args.size !== 3) throw Error("report_inventory_out_required");
const out = path.resolve(args.get("out")!);
if (!out.startsWith(path.resolve("data/longvp-maintenance") + path.sep)) throw Error("isolated_output_required");
await fs.mkdir(out, { mode: 0o700 }); // No reuse/overwrite.
const reportFile = args.get("report")!, reportHash = await sha(reportFile);
const report = JSON.parse(await fs.readFile(reportFile, "utf8"));
if (report.mode !== "proposal_only" || report.results?.length !== 2) throw Error("approved_report_required");
const inventoryFile = args.get("inventory")!, inventoryHash = await sha(inventoryFile);
const inventory = JSON.parse(await fs.readFile(inventoryFile, "utf8"));
const targets = [], sources = [];
for (const symbol of ["NQ", "GC"] as const) {
  const r = report.results.find((r: { symbol: string }) => r.symbol === symbol);
  if (!r) throw Error("missing_approved_symbol");
  await verifyPinned({ file: r.audit.activeFile, sha256: r.audit.activeHash });
  const active = JSON.parse(await fs.readFile(r.audit.activeFile, "utf8"));
  const conditionFile = path.join(path.dirname(r.audit.activeFile), "original-metadata/condition.json");
  const conditionHash = await sha(conditionFile);
  const condition = JSON.parse(await fs.readFile(conditionFile, "utf8"));
  const pins = new Map<string, string>(r.audit.inputs.map((p: { file: string; sha256: string }) => [path.resolve(p.file), p.sha256]));
  const chosen = symbol === "NQ" ? "NQZ26" : "GCZ26";
  // Same expiry identity as approved; preserve TICK STREAM's one-digit identity to avoid fake rolls.
  const stored = symbol === "NQ" ? "NQZ6" : "GCZ6";
  const dates = datesBetween("2026-10-01", "2026-10-29");
  if (dates.length !== 21) throw Error("incorrect_approved_date_count");
  for (const date of dates) {
    const approved = r.days.find((d: { date: string }) => d.date === date);
    if (!approved || approved.partialPurchasePeriod || approved.front?.contract !== chosen) throw Error("unapproved_day");
    const bounds = dayBounds(date), trading = session(date), aggregate = new LongAggregate();
    if (bounds.startUs < active.fromUs || bounds.endUs > active.toUs) throw Error("partial_day_not_approved");
    const utcDates = [new Date(bounds.startUs / 1000).toISOString().slice(0, 10),
      new Date((bounds.endUs - 1) / 1000).toISOString().slice(0, 10)];
    for (const utcDate of utcDates)
      if (!condition.some((c: { date: string; condition: string }) => c.date === utcDate && c.condition === "available"))
        throw Error("unavailable_source_utc_date");
    let maintenanceQuantity = 0;
    for (const staged of active.staged) {
      if (staged.errors) throw Error("source_parse_errors");
      for (const item of staged.outputs) {
        const m = /^(known|unknown)\/([^/]+)\/(\d{4}-\d\d-\d\d)\/(\d\d)\.jsonl\.gz$/.exec(item.path);
        if (!m || m[2] !== chosen || !utcDates.includes(m[3]!)) continue;
        const file = path.resolve(active.stage, staged.sha256, item.path);
        if (pins.get(file) !== item.sha256) throw Error("source_not_bound_to_approved_report");
        await verifyPinned({ file, sha256: item.sha256 });
        for await (const { trade: t } of tradeFileEntries(file)) {
          if (t.contract !== chosen || !Number.isSafeInteger(t.size) || t.size <= 0
            || !Number.isSafeInteger(t.tsUs) || !["buy", "sell", "unknown"].includes(t.side)) throw Error("invalid_source_trade");
          if (t.tsUs < bounds.startUs || t.tsUs >= bounds.endUs) continue;
          if (t.tsUs >= trading.endUs) maintenanceQuantity += t.size;
          aggregate.add(t, stored);
        }
        await verifyPinned({ file, sha256: item.sha256 });
      }
    }
    if (maintenanceQuantity !== 0) throw Error("maintenance_volume_not_in_approved_total");
    const day = validateDay(serializeDay(date, aggregate, [{ contract: stored, sinceUs: bounds.startUs }],
      [], Date.now() * 1000), symbol);
    const quantities = day.vp30m.reduce((n, v) => [n[0]! + v[2], n[1]! + v[3], n[2]! + (v[5] ?? 0)], [0, 0, 0]);
    const volume = quantities.reduce((a, b) => a + b, 0);
    const barVolume = day.bars1m.reduce((n, v) => n + v[5] + v[6] + (v[8] ?? 0), 0);
    if (!Number.isSafeInteger(volume) || volume !== approved.front.volume || volume !== barVolume)
      throw Error("rebuilt_volume_differs_from_approved_list");
    const bytes = Buffer.from(JSON.stringify(day));
    if (bytes.length > 4 * 1024 * 1024) throw Error("day_exceeds_existing_reader_budget");
    const file = path.join(out, `${symbol}-${date}.json.gz`);
    await fs.writeFile(file, gzipSync(bytes), { flag: "wx", mode: 0o600 });
    if (JSON.stringify(validateDay(JSON.parse(gunzipSync(await fs.readFile(file)).toString()), symbol)) !== JSON.stringify(day))
      throw Error("candidate_readback_mismatch");
    const name = `prod/longvp/${symbol}/days/${date}.json.gz`;
    const old = inventory.objects.find((o: { name: string }) => o.name === name) ?? null;
    targets.push({ name, symbol, date, sourceContract: chosen, storedContract: stored, volume,
      buy: quantities[0], sell: quantities[1], unknown: quantities[2], trades: aggregate.count,
      file, sha256: await sha(file), original: old });
    console.log(JSON.stringify({ symbol, date, volume, trades: aggregate.count }));
  }
  await verifyPinned({ file: r.audit.activeFile, sha256: r.audit.activeHash });
  if (await sha(conditionFile) !== conditionHash) throw Error("source_condition_changed");
  sources.push({ symbol, activeFile: r.audit.activeFile, sha256: r.audit.activeHash, conditionFile, conditionHash });
}
if (await sha(reportFile) !== reportHash || await sha(inventoryFile) !== inventoryHash) throw Error("plan_inputs_changed");
const plan = { version: 1, kind: "approved-purchased-longvp-days", createdAt: new Date().toISOString(),
  approvedDates: ["2026-10-01", "2026-10-29"], excludedPartialDates: ["2026-09-30", "2026-10-30"],
  reportFile, reportHash, inventoryFile, inventoryHash, sources, targets,
  warning: "LONG VP ONLY. Raw production trades and coverage remain unchanged. Apply requires exclusion of the existing runtime writer." };
await fs.writeFile(path.join(out, "plan.json"), JSON.stringify(plan, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ out, targets: targets.length, originalTargets: targets.filter(t => t.original).length }));
