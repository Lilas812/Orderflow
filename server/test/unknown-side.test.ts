import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { VolumeProfile } from "../src/vp/state.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { improvesDay } from "../src/long-vp/app-service.ts";
import { serializeDay, mergeAggregates } from "../src/long-vp/day.ts";
import { validateDay } from "../src/long-vp/objects.ts";
import { DailyState } from "../../artifacts/heatmap/src/data/daily.ts";
import { VpState, valueArea } from "../../artifacts/heatmap/src/data/vp.ts";
import { buildSeries, parseDay } from "../../artifacts/heatmap/src/long-vp/model.ts";
import { FootprintStore } from "../../artifacts/heatmap/src/footprint/model.ts";
import { TradeAggregator } from "../../artifacts/heatmap/src/data/trade-aggregate.ts";
import { tradeGeometry } from "../../artifacts/heatmap/src/chart/trade-geometry.ts";
import { replaceHour } from "../src/import/databento-install.ts";
import { tradeFileEntries } from "../src/store/records.ts";
import { sha } from "../src/import/databento-stage.ts";
import type { Trade } from "../src/types.ts";
const sec = Date.parse("2026-10-01T14:34:55Z") / 1000;
const rows: Trade[] = [
  { seq: 1, tsUs: sec * 1e6 + 5, recvUs: sec * 1e6 + 8, price: 100, size: 2, side: "buy", contract: "GCZ26" },
  { seq: 2, tsUs: sec * 1e6 + 7, recvUs: sec * 1e6 + 9, price: 110, size: 5, side: "unknown", contract: "GCZ26" },
  { seq: 3, tsUs: sec * 1e6 + 6, recvUs: sec * 1e6 + 10, price: 90, size: 1, side: "sell", contract: "GCZ26" },
  { seq: 4, tsUs: sec * 1e6 + 7, recvUs: sec * 1e6 + 9, price: 110, size: 5, side: "unknown", contract: "GCZ26" },
];
test("N contributes total/POC/VWAP, not directional CVD; absolute retransmission and session reset", () => {
  const p = new VolumeProfile(sec); rows.forEach(t => p.add(t));
  assert.equal(p.summary().total, 13); assert.equal(p.summary().undirected, 10);
  const vp = new VpState(); vp.accept({ ...p.message() });
  assert.equal(valueArea(vp.levels.values()).poc, 110); assert.equal(valueArea(vp.levels.values()).total, 13);
  const daily = new DailyState("GC"), m = { ...p.dailyMessage(), symbol: "GC" };
  assert(daily.accept(m)); daily.series();
  assert.equal(daily.snapshot().total, 13); assert.equal(daily.snapshot().cvd, 1);
  assert.equal(daily.snapshot().vwapTicks, 1390 / 13); assert.equal(daily.snapshot().unknownQuantity, 0);
  assert(daily.accept(m)); daily.series(); assert.equal(daily.snapshot().total, 13);
  p.advance(sec + 86400); assert.equal(p.summary().total, 0); assert.equal(p.undirected, 0);
});
test("N is preserved in footprint totals/price POC and long VP/weekly VWAP; no directional allocation", () => {
  const aggregate = new LongAggregate(), footprint = new FootprintStore();
  footprint.beginRange(1, sec, sec + 5);
  footprint.appendRange(1, rows);
  footprint.commitRange(1, { coverage: [[sec, sec + 5]], gaps: [], noData: [] });
  rows.forEach(t => aggregate.add(t, "GCZ26"));
  const bar = footprint.bars(sec, sec + 5)[0]!.group.get("GCZ26")!;
  assert.equal(bar.volume, 13); assert.equal(bar.delta, 1); assert.equal(bar.undirectedTotal, 10);
  assert.equal(bar.count, 4); assert.equal(bar.poc, 110);
  const day = serializeDay("2026-10-01", aggregate, [], [[sec, sec + 5]], sec * 1e6, false, true);
  assert.equal(validateDay(day, "GC"), day); assert.equal(parseDay(day, "GC"), day);
  const series = buildSeries([day], [], "GCZ26");
  assert.equal(series.volumes.reduce((n, r) => n + r.v, 0), 13);
  assert.equal(series.vwap.at(-1)!.v, 1390 / 13);
  assert.equal(series.cvd.at(-1)!.v, 1);
  const droppingN = structuredClone(day); droppingN.vp30m.forEach(r => { if (r.length === 6) r[5] = 0; });
  assert.equal(improvesDay(day, droppingN), false);
  assert.equal(improvesDay(day, structuredClone(day)), true);
  const merged = mergeAggregates(aggregate, aggregate);
  assert.equal([...merged.volumes.values()].reduce((n, r) => n + (r.undirected ?? 0), 0), 20);
  const tape = new TradeAggregator(); tape.appendLive(rows);
  const cells = tape.cells(sec * 1e6, (sec + 5) * 1e6);
  assert.equal(cells.reduce((n, r) => n + r.buy + r.sell, 0), 3);
  assert.equal(cells.reduce((n, r) => n + (r.undirected ?? 0), 0), 10);
  const geometry = tradeGeometry(tape, { startUs: sec * 1e6, durationSec: 5,
    centerPriceTicks: 100, priceSpanTicks: 40 }, 500, 300, 1, 1);
  assert.equal(geometry.bubbles.length, 2);
  assert(!geometry.bubbles.some(b => b.price === 110));
  assert.equal(geometry.bubbles.reduce((n, b) => n + b.buy + b.sell, 0), 3);
});
test("split B/A/N streams merge by original ordinal, keep identical distinct N and time rewind, rerun/abort safe", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "unknown-import-"));
  try {
    const known = path.join(root, "known.gz"), unknown = path.join(root, "unknown.gz"), target = path.join(root, "hour.gz");
    await fs.writeFile(known, gzipSync(rows.filter(t => t.side !== "unknown").map(t => JSON.stringify(t) + "\n").join("")));
    await fs.writeFile(unknown, gzipSync(rows.filter(t => t.side === "unknown").map(t => JSON.stringify(t) + "\n").join("")));
    const run = () => replaceHour(target, [known, unknown], "GCZ26", sec * 1e6, (sec + 5) * 1e6, true);
    assert.equal((await run()).adopted.unknown, 10);
    const read = []; for await (const x of tradeFileEntries(target)) read.push(x.trade);
    assert.deepEqual(read, rows); const hash = await sha(target);
    await run(); assert.equal(await sha(target), hash);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(replaceHour(target, [known, unknown], "GCZ26", sec * 1e6, (sec + 5) * 1e6, true, abort.signal));
    assert.equal(await sha(target), hash);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
