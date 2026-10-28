/** Explicit dev-only, real-file verification. No HTTP server or upstream WebSocket. */
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { ReplitObjects } from "../src/store/objects.ts";
import type { Objects } from "../src/store/objects.ts";
import { AppStore } from "../src/store/app.ts";
import { HistoryClient } from "../src/history/client.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import { readTradeRange } from "../src/vp/trade-history.ts";
import { LongRest } from "../src/long-vp/rest.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { dayBounds, serializeDay, validDate, tradingDate } from "../src/long-vp/day.ts";
import { LongObjects } from "../src/long-vp/objects.ts";

if (process.env.REPLIT_DEPLOYMENT === "1" || process.env.LONG_VP_DEV_ENABLE !== "1")
  throw Error("explicit_development_opt_in_required");
const date = process.argv[2];
if (!validDate(date ?? "") || !tradingDate(date)) throw Error("valid_trading_date_required");
const raw = new ReplitObjects();
const objects: Objects = {
  exists: name => raw.exists(name), download: (name, file) => raw.download(name, file),
  list: prefix => raw.list(prefix),
  upload: async (name, file) => {
    if (!name.startsWith("dev/")) throw Error("production_write_forbidden");
    await raw.upload(name, file);
  },
};
const log = (event: string, details?: unknown) => {
  if (/long_vp|shutdown_summary/.test(event)) console.log(JSON.stringify({ event, details }));
};
const root = path.resolve("data/phase13a-check");
await fs.mkdir(root, { recursive: true });
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());
const bounds = dayBounds(date);
if (bounds.endUs + 300e6 > Date.now() * 1000 || bounds.startUs < Date.now() * 1000 - 7 * 86400e6)
  throw Error("completed_day_within_seven_days_required");
const key = process.env.TICKSTREAM_API_KEY;
if (!key) throw Error("key_missing");
const roll = await new LongRest(key).roll(abort.signal);
if (roll.sinceUs > bounds.startUs) throw Error("day_spans_unverified_contract");
const store = new AppStore(path.join(root, "raw"), objects, "dev/", log);
const repository = new LongObjects(objects, "dev/", path.join(root, "aggregate"));
await store.initialize();
const client = new HistoryClient(key, log), metrics = new Metrics(log);
let seq = 0, peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25);
const started = performance.now();
try {
  const aggregate = new LongAggregate();
  const progress = await readTradeRange({ store, source: client, metrics, nextSeq: () => ++seq,
    start: bounds.startUs / 1e6, end: bounds.endUs / 1e6, signal: abort.signal,
    visit: t => aggregate.add(t, roll.contract) });
  const builtMs = performance.now() - started;
  const day = serializeDay(date, aggregate, [roll],
    progress.gaps.map(g => [g.startSec, g.endSec]), Date.now() * 1000);
  const size = await repository.save(day, abort.signal);
  await store.flush(); await store.publicationSettled();
  // Independent decompression/JSON parse/counting; not LongAggregate or tradeFileRows.
  const prices = new Map<number, [number, number]>();
  const minutes = new Map<number, { first: number; last: number; o: number; h: number; l: number; c: number; buy: number; sell: number }>();
  let buy = 0, sell = 0, trades = 0;
  for (let second = bounds.startUs / 1e6; second < bounds.endUs / 1e6; second += 3600) {
    const iso = new Date(second * 1000).toISOString();
    const file = path.join(root, "raw/trades/NQ", iso.slice(0, 10), iso.slice(11, 13) + ".jsonl.gz");
    try { await fs.access(file); } catch { continue; }
    const input = createReadStream(file).pipe(createGunzip()), lines = createInterface({ input });
    for await (const line of lines) {
      const t = JSON.parse(line);
      if (t.tsUs < bounds.startUs || t.tsUs >= bounds.endUs) continue;
      trades++; if (t.side === "buy") buy += t.size; else sell += t.size;
      const p = prices.get(t.price) ?? [0, 0]; p[t.side === "buy" ? 0 : 1] += t.size; prices.set(t.price, p);
      const m = Math.floor(t.tsUs / 60e6) * 60, old = minutes.get(m);
      const b = old ?? { first: t.tsUs, last: t.tsUs, o: t.price, h: t.price, l: t.price, c: t.price, buy: 0, sell: 0 };
      b.h = Math.max(b.h, t.price); b.l = Math.min(b.l, t.price);
      if (t.tsUs < b.first) { b.first = t.tsUs; b.o = t.price; }
      if (t.tsUs >= b.last) { b.last = t.tsUs; b.c = t.price; }
      if (t.side === "buy") b.buy += t.size; else b.sell += t.size;
      minutes.set(m, b);
    }
  }
  const fromVp = new Map<number, [number, number]>();
  for (const [, price, b, s] of day.vp30m) {
    const p = fromVp.get(price) ?? [0, 0]; p[0] += b; p[1] += s; fromVp.set(price, p);
  }
  assert.equal(aggregate.count, trades);
  assert.equal(day.vp30m.reduce((n, r) => n + r[2], 0), buy);
  assert.equal(day.vp30m.reduce((n, r) => n + r[3], 0), sell);
  assert.deepEqual([...fromVp].sort((a, b) => a[0] - b[0]), [...prices].sort((a, b) => a[0] - b[0]));
  assert.deepEqual(day.bars1m, [...minutes].sort((a, b) => a[0] - b[0])
    .map(([m, b]) => [m, b.o, b.h, b.l, b.c, b.buy, b.sell, 0]));
  const restarted = new LongObjects(objects, "dev/", path.join(root, "reload"));
  assert.deepEqual(await restarted.day(date), day);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const result = { tradingDate: date, complete: day.complete, gaps: day.gaps,
    trades, buy, sell, priceLevels: prices.size, minuteBars: minutes.size, vpRows: day.vp30m.length,
    ...size, buildMs: builtMs, totalMs: performance.now() - started, peakRss,
    maxRssBytes: process.resourceUsage().maxRSS * 1024, progress, network: client.stats,
    cache: repository.snapshot(), comparison: "all_equal", upstreamWebSocketsOpened: 0 };
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ event: "long_vp_real_day_verified", result }));
} finally {
  clearInterval(sampler);
  const deadline = new AbortController(); store.beginShutdown(deadline.signal);
  const timeout = setTimeout(() => deadline.abort(), 8000);
  try { await store.flush(); } finally { clearTimeout(timeout); }
  console.log(JSON.stringify({ event: "long_vp_check_stopped", upstreamWebSocketsOpened: 0 }));
}
