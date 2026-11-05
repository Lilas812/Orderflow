/** CT session dominance proof from existing T exports; no raw decode or API. */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/research-v2/mbo-01");
const base = path.join(root, "rebuilt/GCZ26");
const daily = new Map(), sessions = new Map(), clockCache = new Map();
const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
for (const day of fs.readdirSync(base).filter(x => /^\d{4}-\d\d-\d\d$/.test(x)).sort()) {
  const summary = JSON.parse(fs.readFileSync(path.join(base, day, "summary.json"), "utf8"));
  daily.set(day, Object.entries(summary.allOutrightTradeVolume)
    .filter(([contract]) => contract !== "GCZ6").reduce((n, [, size]) => n + size, 0));
  const source = fs.createReadStream(path.join(base, day, "mbo-trades.jsonl"));
  const reader = createInterface({ input: source, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      const t = JSON.parse(line), hour = Math.floor(t.tsUs / 3600000000);
      if (!clockCache.has(hour)) {
        const p = Object.fromEntries(formatter.formatToParts(hour * 3600000).map(x => [x.type, x.value]));
        const start = Date.UTC(+p.year, +p.month - 1, +p.day) - (+p.hour < 17 ? 86400000 : 0);
        clockCache.set(hour, { date: new Date(start).toISOString().slice(0, 10), paused: +p.hour === 16 });
      }
      const session = clockCache.get(hour);
      if (!session.paused) sessions.set(session.date, (sessions.get(session.date) ?? 0) + t.size);
    }
  } finally { reader.close(); source.destroy(); }
}
const rows = [...sessions].sort(([a], [b]) => a.localeCompare(b)).map(([date, quantity]) => {
  const next = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
  const upperBound = (daily.get(date) ?? 0) + (daily.get(next) ?? 0);
  return { startDateCT: date, gcz6Quantity: quantity, allOtherContractsUpperBound: upperBound,
    dominanceProvedWithinPurchase: quantity > upperBound,
    partial: date === "2026-09-29" || date === "2026-11-03" };
});
fs.writeFileSync(path.join(root, "contract-verification.json"), JSON.stringify({
  method: "GCZ6 CT17-to-next16 volume > sum of ALL other outrights over both intersecting UTC days",
  rationale: "A conservative upper bound, not an estimate of each competitor's CT volume.",
  timezone: "America/Chicago", fixedContract: "GCZ26", rows,
}, null, 2) + "\n");
console.log(JSON.stringify({ sessions: rows.length, fullSessions: rows.filter(x => !x.partial).length,
  fullDominanceProved: rows.filter(x => !x.partial && x.dominanceProvedWithinPurchase).length }));
