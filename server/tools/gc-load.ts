/** Isolated short matched-load probe. No vendor WS, real REST, or App Storage. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pipeline } from "../src/pipeline.ts";
import { LocalStore } from "../src/store/local.ts";
import { Receiver } from "../src/ingest/receiver.ts";
import { MarketReceiver } from "../src/ingest/markets.ts";

const both = process.argv.includes("--both"), root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-load-"));
const calls: string[] = [];
const request: typeof fetch = async url => {
  calls.push(String(new URL(String(url)).pathname));
  return new Response(JSON.stringify({ ticks: [], book: [], truncated: false }));
};
const pipelines: Pipeline[] = [];
const nq = new Pipeline("dummy-only", () => nqReceiver.nextSequence(), () => {}, () => {},
  new LocalStore(path.join(root, "nq")), "NQ", request);
pipelines.push(nq);
const gc = both ? new Pipeline("dummy-only", () => gcReceiver.nextSequence(), () => {}, () => {},
  new LocalStore(path.join(root, "gc"), Date.now, undefined, "GC"), "GC", request) : null;
if (gc) pipelines.push(gc);
const nqReceiver = new Receiver(() => {}, { book: b => nq.book(b), trade: t => nq.trade(t) });
const gcReceiver = new Receiver(() => {}, { book: b => gc?.book(b), trade: t => gc?.trade(t) }, "GC");
const input = new MarketReceiver(nqReceiver, gcReceiver);
const book = (symbol: "NQ" | "GC") => {
  const scale = symbol === "NQ" ? 4 : 10, base = symbol === "NQ" ? 80000 : 40283;
  return { type: "book", symbol, ts: 0, bids: Array.from({ length: 400 }, (_, i) => [(base - i) / scale, 50 + i % 50]),
    asks: Array.from({ length: 400 }, (_, i) => [(base + 1 + i) / scale, 60 + i % 40]) };
};
const books = [book("NQ"), ...(both ? [book("GC")] : [])];
let bookCount = 0, tradeCount = 0;
try {
  await Promise.all(pipelines.map(p => p.initialize()));
  const cpu = process.cpuUsage(), started = performance.now(), before = process.memoryUsage();
  let nextBook = 0, nextTick = 0;
  while (performance.now() - started < 3000) {
    const elapsed = performance.now() - started, sec = Math.floor(Date.now() / 1000);
    if (elapsed >= nextBook) {
      for (const b of books) { b.ts = sec; input.receive(JSON.stringify(b), Date.now() * 1000, () => {}); bookCount++; }
      nextBook += 1000 / 7;
    }
    if (elapsed >= nextTick) {
      for (const b of books) {
        input.receive(JSON.stringify({ type: "tick", symbol: b.symbol, ts: sec, price: b.bids[0][0], size: 2, side: "buy" }),
          Date.now() * 1000, () => {});
        tradeCount++;
      }
      nextTick += 10;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu), after = process.memoryUsage();
  assert.equal(nqReceiver.metrics.counts.acceptedBook, 21);
  console.log(JSON.stringify({ mode: both ? "NQ+GC" : "NQ", condition: "3s, 7 books/s + 100 ticks/s per instrument, 400 levels/side",
    elapsedMs, bookCount, tradeCount, cpuMs: (used.user + used.system) / 1000,
    cpuPercentOneCore: (used.user + used.system) / elapsedMs / 10,
    rssBefore: before.rss, rssAfter: after.rss, maxRss: process.resourceUsage().maxRSS * 1024,
    heapBefore: before.heapUsed, heapAfter: after.heapUsed, localOnly: true, dummyRestCalls: calls.length }));
} finally {
  await Promise.all(pipelines.map(p => p.stop()));
  await fs.rm(root, { recursive: true, force: true });
}
