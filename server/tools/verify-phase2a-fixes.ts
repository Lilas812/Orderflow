/** Run after stopping the receiver. No WebSocket; old out-of-range examples stay in a separate verification store. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { LocalStore } from "../src/store/local.ts";
import { HistoryClient } from "../src/history/client.ts";
import { historyTrades } from "../src/history/decode.ts";
import { Metrics } from "../src/ingest/metrics.ts";

const root = fileURLToPath(new URL("../../data/", import.meta.url));
const evidence = path.join(root, "phase2a-fix-checks");
const status = JSON.parse(await fs.readFile(path.join(evidence, "status-final.json"), "utf8"));
if (status.phase2a.backfill.state !== "complete") throw Error("backfill_not_complete");
const end = status.phase2a.seamL, start = end - 10800;
const store = new LocalStore(root);
await store.initialize();
const columns = await store.readColumns(start, end);
const seconds = new Set(columns.map(c => c.tsSec));
const missingIntervals = [];
for (let sec = start; sec < end;) {
  if (seconds.has(sec)) { sec++; continue; }
  const a = sec++;
  while (sec < end && !seconds.has(sec)) sec++;
  missingIntervals.push({ startSec: a, endSec: sec });
}
const historicalTrades = await store.readTrades(start, end);
const lastMinute = columns.filter(c => c.tsSec >= end - 60);
const counts = status.phase2a.historyCounts;
const currentExamples = counts.tradeTimestampRollback
  ? status.phase2a.historyExamples.tradeTimestampRollback ?? [] : [];
const currentExampleChecks = [];
for (const example of currentExamples) {
  const matching = historicalTrades.filter(t => t.tsUs === example.tsUs);
  currentExampleChecks.push({ tsUs: example.tsUs, savedCount: matching.length, saved: matching.length > 0 });
}
const previousStatus = JSON.parse(await fs.readFile(path.join(root, "phase2a-checks/status-after-backfill.json"), "utf8"));
const oldExamples = previousStatus.phase2a.historyExamples.timestampRollback;
const occurrences = new Map<number, number>();
for (const item of oldExamples) occurrences.set(item.tsUs, (occurrences.get(item.tsUs) ?? 0) + 1);
const key = process.env.TICKSTREAM_API_KEY;
if (!key) throw Error("API key is not configured");
const client = new HistoryClient(key, () => {});
const separate = new LocalStore(path.join(evidence, "old-example-store"));
await separate.initialize();
const oldChecks = [];
let seq = 0;
for (const [tsUs, oldLoggedOccurrences] of occurrences) {
  const sec = Math.floor(tsUs / 1e6);
  const response = await client.get("tick", sec, sec + 1, new AbortController().signal);
  if (response.truncated) throw Error("verification_truncated");
  const decoded = historyTrades(response.rows, sec, sec + 1, new Metrics(() => {}), () => ++seq);
  const refetched = decoded.filter(t => t.tsUs === tsUs);
  const inCurrentRange = sec >= start && sec < end;
  if (!inCurrentRange) await separate.addTrades(decoded);
  const saved = inCurrentRange
    ? historicalTrades.filter(t => t.tsUs === tsUs)
    : (await separate.readTrades(sec, sec + 1)).filter(t => t.tsUs === tsUs);
  const signature = (rows: typeof saved) => rows.map(t => [t.tsUs, t.price, t.size, t.side]);
  oldChecks.push({ tsUs, oldLoggedOccurrences, scope: inCurrentRange ? "main" : "verification_only",
    refetchedCount: refetched.length, savedCount: saved.length,
    match: refetched.length >= oldLoggedOccurrences
      && JSON.stringify(signature(refetched)) === JSON.stringify(signature(saved)) });
}
await separate.flush();
const cleanup = JSON.parse(await fs.readFile(path.join(evidence, "cleanup.json"), "utf8"));
let protectedUnchanged = true;
for (const file of cleanup.protectedFiles) {
  const bytes = await fs.readFile(path.join(root, "..", file.path));
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) protectedUnchanged = false;
}
const result = {
  verifiedAt: new Date().toISOString(), startSec: start, endSec: end,
  columns: columns.length, missingSeconds: 10800 - seconds.size, missingIntervals,
  previousMissingSeconds: 68, differenceFromPrevious: 10800 - seconds.size - 68,
  seamPrevious60: { columns: lastMinute.length, missingSeconds: 60 - lastMinute.length },
  historicalTradesReadBack: historicalTrades.length, acceptedHistoricalTrades: counts.acceptedTrade,
  allAcceptedHistoricalTradesPersisted: historicalTrades.length === counts.acceptedTrade,
  historicalTradeRollbacks: counts.tradeTimestampRollback,
  rejectedHistoricalTrades: counts.rejectedTrade,
  currentExampleChecks, oldChecks, previousUnidentifiedRollbackEvents: 2,
  repeatedGroups: Object.fromEntries(Object.entries(counts).filter(([k]) => k.startsWith("historyRepeated"))),
  rejectedBook: counts.rejectedBook, invalidGroups: counts.historyInvalidGroups ?? 0,
  emptyRetries: status.phase2a.backfill.emptyRetries,
  historyGaps: status.phase2a.backfill.gaps, noData: status.phase2a.backfill.noData,
  network: status.phase2a.historyNetwork, verificationNetwork: client.stats,
  storageAfterStop: { ...store.stats }, protectedUnchanged,
};
await fs.writeFile(path.join(evidence, "verification.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
