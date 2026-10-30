/** Full adopted tape -> actual FootprintStore, one hour at a time (no monthly RAM tape). */
import * as fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { FootprintStore } from "../../artifacts/heatmap/src/footprint/model.ts";
import { tradeFileEntries } from "../src/store/records.ts";
import { validateDay } from "../src/long-vp/objects.ts";
const out = process.argv.find(a => a.startsWith("--out="))?.slice(6) ?? "data/databento-gc-import";
const active = JSON.parse(await fs.readFile(path.join(out, "active.json"), "utf8"));
const results = [];
for (const [contract, entry] of Object.entries(active.installed) as [string, any][]) {
  const symbol = contract.startsWith("GC") ? "GC" : "NQ";
  let count = 0, volume = 0, buy = 0, sell = 0, undirected = 0, bars = 0;
  const prices = new Map<number, { buy: number; sell: number; unknown?: number }>();
  for (const h of entry.hours) {
    if (h.blocked) continue;
    const from = Math.floor(h.fromUs / 1e6), to = Math.ceil(h.toUs / 1e6);
    const store = new FootprintStore(); store.beginRange(1, from, to);
    let batch = [];
    for await (const { trade: t } of tradeFileEntries(path.join(entry.root, `trades/${symbol}`, h.hour + ".jsonl.gz"))) {
      if (t.contract !== contract || t.tsUs < h.fromUs || t.tsUs >= h.toUs) continue;
      batch.push(t);
      if (batch.length === 256) { store.appendRange(1, batch); batch = []; }
    }
    if (batch.length) store.appendRange(1, batch);
    store.commitRange(1, { coverage: [[from, to]], gaps: [], noData: [] });
    for (const { group } of store.bars(from, to)) for (const b of group.values()) {
      count += b.count; volume += b.volume; buy += b.buyTotal; sell += b.sellTotal;
      undirected += b.undirectedTotal ?? 0; bars++;
      assert.equal(b.delta, b.buyTotal - b.sellTotal);
      assert.equal(b.volume, b.buyTotal + b.sellTotal + (b.undirectedTotal ?? 0));
      b.prices.forEach((p, i) => {
        const v = prices.get(p) ?? { buy: 0, sell: 0 } as { buy: number; sell: number; unknown?: number };
        v.buy += b.buy[i]!; v.sell += b.sell[i]!;
        const n = b.undirected?.[i] ?? 0; if (n) v.unknown = (v.unknown ?? 0) + n;
        prices.set(p, v);
      });
    }
  }
  const expected = active.rebuilt[contract].totals;
  assert.equal(count, expected.count); assert.equal(buy, expected.buy); assert.equal(sell, expected.sell);
  assert.equal(undirected, expected.unknown); assert.equal(volume, expected.buy + expected.sell + expected.unknown);
  assert.deepEqual([...prices].sort(([a], [b]) => a - b),
    JSON.parse(await fs.readFile(path.join(entry.root, "price-volumes.json"), "utf8")));
  for (const file of await fs.readdir(path.join(entry.root, "longvp")).catch(e => {
    if (e.code === "ENOENT") return []; throw e;
  })) validateDay(JSON.parse(await fs.readFile(path.join(entry.root, "longvp", file), "utf8")), symbol);
  results.push({ contract, count, volume, buy, sell, undirected, bars, prices: prices.size, result: "pass" });
}
await fs.writeFile(path.join(out, "footprint-full-check.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
