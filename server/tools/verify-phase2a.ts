/**
 * Read-only verification of saved Phase 2a files; starts NO WebSocket.
 * Run only after the receiver has been stopped. Writes no raw upstream payloads.
 */
import * as fs from "node:fs/promises";
import { randomInt } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalStore } from "../src/store/local.ts";
import { HistoryClient } from "../src/history/client.ts";
import { historyColumns } from "../src/history/decode.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import type { Column } from "../src/aggregate/columns.ts";

const root = fileURLToPath(new URL("../../data/", import.meta.url));
const evidence = path.join(root, "phase2a-checks");
const secret = process.env.TICKSTREAM_API_KEY;
if (!secret) throw Error("API key is not configured");
const store = new LocalStore(root);
await store.initialize();
const before = JSON.parse(await fs.readFile(path.join(evidence, "status-after-backfill.json"), "utf8"));
const after = JSON.parse(await fs.readFile(path.join(evidence, "status-after-10min.json"), "utf8"));
const L: number = before.phase2a.seamL;
if (!Number.isSafeInteger(L) || before.phase2a.backfill.state !== "complete") throw Error("backfill_not_complete");
const columnStart = L - 10800;
const saved = await store.readColumns(columnStart, L);
const times = new Set(saved.map(c => c.tsSec));
const missing: { startSec: number; endSec: number }[] = [];
for (let t = columnStart; t < L;) {
  if (times.has(t)) { t++; continue; }
  const startSec = t++;
  while (t < L && !times.has(t)) t++;
  missing.push({ startSec, endSec: t });
}
const candidates = saved.filter(c => c.source === "history").map(c => c.tsSec);
if (candidates.length < 3) throw Error("fewer_than_3_historical_seconds");
const client = new HistoryClient(secret, () => {});
async function refetch(a: number, b: number): Promise<Column[]> {
  const response = await client.get("book", a, b, new AbortController().signal);
  if (response.truncated) throw Error("verification_window_truncated");
  return historyColumns(response.rows, a, b, new Metrics(() => {}));
}
const selected = new Set<number>();
while (selected.size < 3) selected.add(candidates[randomInt(candidates.length)]);
const randomChecks = [];
for (const sec of selected) {
  const minute = Math.floor(sec / 60) * 60;
  const current = saved.find(c => c.tsSec === sec)!;
  const reconstructed = (await refetch(minute, minute + 60)).find(c => c.tsSec === sec);
  randomChecks.push({ tsSec: sec, match: reconstructed !== undefined
    && JSON.stringify(current) === JSON.stringify(reconstructed),
    stored: { source: current.source, bestBid: current.bids[0], bestAsk: current.asks[0] },
    refetched: reconstructed ? { source: reconstructed.source, bestBid: reconstructed.bids[0], bestAsk: reconstructed.asks[0] } : null });
}
// A completed two-minute interval strictly inside the ten-minute post-backfill reception.
const compareStart = Math.ceil((before.phase2a.backfill.finishedAtUs / 1_000_000 + 60) / 60) * 60;
const compareEnd = compareStart + 120;
const observedUntil = Math.floor(after.upstream.lastReceivedUs / 1_000_000);
if (compareEnd > observedUntil || compareStart < before.phase2a.backfill.finishedAtUs / 1_000_000) {
  throw Error("two_minute_interval_not_observed");
}
const live = new Map((await store.readColumns(compareStart, compareEnd)).filter(c => c.source === "live")
  .map(c => [c.tsSec, c]));
const historical = new Map<number, Column>();
for (let t = compareStart; t < compareEnd; t += 60) {
  for (const c of await refetch(t, t + 60)) historical.set(c.tsSec, c);
}
let bestMatched = 0, fullMatched = 0, comparable = 0;
const differences: unknown[] = [];
for (let sec = compareStart; sec < compareEnd; sec++) {
  const a = live.get(sec), b = historical.get(sec);
  if (!a || !b) continue;
  comparable++;
  const bestEqual = JSON.stringify([a.bids[0], a.asks[0]]) === JSON.stringify([b.bids[0], b.asks[0]]);
  const allEqual = JSON.stringify([a.bids, a.asks]) === JSON.stringify([b.bids, b.asks]);
  if (bestEqual) bestMatched++;
  if (allEqual) fullMatched++;
  const bidIndex = a.bids.findIndex((v, i) => JSON.stringify(v) !== JSON.stringify(b.bids[i]));
  const askIndex = a.asks.findIndex((v, i) => JSON.stringify(v) !== JSON.stringify(b.asks[i]));
  if (!allEqual && differences.length < 3) differences.push({
    tsSec: sec, bestEqual, live: { bestBid: a.bids[0], bestAsk: a.asks[0], bidDepth: a.bids.length, askDepth: a.asks.length },
    history: { bestBid: b.bids[0], bestAsk: b.asks[0], bidDepth: b.bids.length, askDepth: b.asks.length },
    firstDifferentBid: bidIndex < 0 ? null : { index: bidIndex, live: a.bids[bidIndex], history: b.bids[bidIndex] ?? null },
    firstDifferentAsk: askIndex < 0 ? null : { index: askIndex, live: a.asks[askIndex], history: b.asks[askIndex] ?? null },
  });
}
const result = {
  measuredAt: new Date().toISOString(),
  backfill: { startSec: columnStart, endSec: L, savedColumns: saved.length,
    missingSeconds: 10800 - times.size, missingIntervals: missing, randomChecks },
  comparison: { startSec: compareStart, endSec: compareEnd, commonSeconds: comparable, liveSeconds: live.size,
    historySeconds: historical.size, bestMatched, fullMatched, bestRate: comparable ? bestMatched / comparable : null,
    fullRate: comparable ? fullMatched / comparable : null, differences },
  verificationNetwork: client.stats,
  persistedStats: { ...store.stats }, tradesReadBack: (await store.readTrades(compareStart, compareEnd)).length,
};
await fs.writeFile(path.join(evidence, "verification.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
