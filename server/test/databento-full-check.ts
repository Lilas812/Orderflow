import * as fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tradeFileEntries } from "../src/store/records.ts";
import { sha, emptyStats, count } from "../src/import/databento-stage.ts";
import { DailyState } from "../../artifacts/heatmap/src/data/daily.ts";
const out = process.argv.find(a => a.startsWith("--out="))?.slice(6) ?? "data/databento-import";
const active = JSON.parse(await fs.readFile(path.join(out, "active.json"), "utf8"));
const results = [];
let sourceRows = 0, spreadRows = 0, errorRows = 0, unknownRows = 0, unknownQuantity = 0;
for (const f of active.staged) {
  sourceRows += f.rows; spreadRows += f.spreads; errorRows += f.errors;
  for (const output of f.outputs) if (output.path.startsWith("unknown/")) {
    unknownRows += output.count;
    for await (const { trade: t } of tradeFileEntries(path.join(active.stage, f.sha256, output.path))) unknownQuantity += t.size;
  }
}
for (const [contract, install] of Object.entries(active.installed) as [string, any][]) {
  const root = path.join(active.generation, contract), actual = active.rebuilt[contract];
  const expected = emptyStats(), prices = new Map<number, { buy: number; sell: number }>();
  const content = new Map<string, ReturnType<typeof createHash>>(), allowed = new Map<string, any>();
  for (const hour of install.hours) if (!hour.blocked) allowed.set(hour.hour, hour);
  let blockedRows = 0, outsideRows = 0;
  for (const f of active.staged) for (const output of f.outputs) {
    if (!output.path.startsWith(`known/${contract}/`)) continue;
    const hour = output.path.slice(`known/${contract}/`.length).replace(".jsonl.gz", ""), h = allowed.get(hour);
    for await (const { line, trade: t } of tradeFileEntries(path.join(active.stage, f.sha256, output.path))) {
      if (t.tsUs < active.fromUs || t.tsUs >= active.toUs) { outsideRows++; continue; }
      if (!h) { blockedRows++; continue; }
      count(expected, t);
      const p = prices.get(t.price) ?? { buy: 0, sell: 0 }; p[t.side] += t.size; prices.set(t.price, p);
      let hash = content.get(hour); if (!hash) { hash = createHash("sha256"); content.set(hour, hash); }
      hash.update(line + "\n");
    }
  }
  assert.deepEqual(expected, actual.totals);
  const priceFile = JSON.parse(await fs.readFile(path.join(root, "price-volumes.json"), "utf8"));
  assert.deepEqual(priceFile, [...prices].sort(([a], [b]) => a - b));
  for (const [hour, hash] of content) {
    const file = path.join(root, `trades/${contract.startsWith("NQ") ? "NQ" : "GC"}`, hour + ".jsonl.gz");
    const check = createHash("sha256");
    for await (const { line } of tradeFileEntries(file)) check.update(line + "\n");
    assert.equal(check.digest("hex"), hash.digest("hex"), `row order and multiplicity ${contract}/${hour}`);
  }
  let dailyCount = 0, dailyBuy = 0, dailySell = 0;
  for (const s of actual.sessions) {
    const state = new DailyState(contract.startsWith("NQ") ? "NQ" : "GC");
    const daily = JSON.parse(await fs.readFile(s.dailyFile, "utf8"));
    // Hub adds the instrument tag to VolumeProfile's internal snapshot on wire.
    assert.equal(state.accept({ ...daily, symbol: contract.startsWith("NQ") ? "NQ" : "GC" }), true); state.series();
    const snapshot = state.snapshot();
    assert.equal(snapshot.total, s.stats.buy + s.stats.sell); assert.equal(snapshot.cvd, s.stats.buy - s.stats.sell);
    assert(Math.abs(snapshot.vwapTicks! - s.stats.weighted / snapshot.total) < 1e-8);
    dailyCount += s.stats.count; dailyBuy += s.stats.buy; dailySell += s.stats.sell;
  }
  assert.equal(dailyCount, expected.count); assert.equal(dailyBuy, expected.buy); assert.equal(dailySell, expected.sell);
  let longBuy = 0, longSell = 0;
  for (const f of await fs.readdir(path.join(root, "longvp")).catch(e => { if (e.code === "ENOENT") return []; throw e; })) {
    const day = JSON.parse(await fs.readFile(path.join(root, "longvp", f), "utf8"));
    for (const r of day.vp30m) { longBuy += r[2]; longSell += r[3]; }
  }
  assert.equal(longBuy, expected.buy); assert.equal(longSell, expected.sell);
  results.push({ contract, adopted: expected, blockedRows, outsideRows, prices: prices.size,
    checkedHourFiles: content.size, sessions: actual.sessions.length, daily: { count: dailyCount, buy: dailyBuy, sell: dailySell },
    longvp: { buy: longBuy, sell: longSell }, result: "pass" });
}
const baseline = JSON.parse(await fs.readFile(path.join(out, "baseline/snapshot.json"), "utf8"));
for (const f of baseline.files) assert.equal(await sha(path.join("data", f.path)), f.sha256, `original unchanged: ${f.path}`);
const report = { archiveSha256: active.archiveSha256, sourceRows, spreadRows, errorRows, unknownRows, unknownQuantity,
  sourceAccountedRows: active.staged.reduce((sum: number, f: any) => sum + Object.values(f.contracts).reduce((n: number, c: any) => n + c.count, 0), 0) + spreadRows + errorRows,
  results, originalFilesUnchanged: baseline.files.length };
assert.equal(report.sourceRows, report.sourceAccountedRows);
await fs.writeFile(path.join(out, "full-check.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
