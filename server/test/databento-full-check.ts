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
  const expected = emptyStats(), prices = new Map<number, { buy: number; sell: number; unknown?: number }>();
  const content = new Map<string, ReturnType<typeof createHash>>(), allowed = new Map<string, any>();
  for (const hour of install.hours) if (!hour.blocked) allowed.set(hour.hour, hour);
  let blockedRows = 0, outsideRows = 0;
  for (const f of active.staged) for (const output of f.outputs) {
    const kind = output.path.startsWith(`known/${contract}/`) ? "known"
      : active.sidePolicy === "all-outright-v2" && output.path.startsWith(`unknown/${contract}/`) ? "unknown" : null;
    if (!kind) continue;
    const hour = output.path.slice(`${kind}/${contract}/`.length).replace(".jsonl.gz", ""), h = allowed.get(hour);
    for await (const { line, trade: t } of tradeFileEntries(path.join(active.stage, f.sha256, output.path))) {
      if (t.tsUs < active.fromUs || t.tsUs >= active.toUs) { outsideRows++; continue; }
      if (!h) { blockedRows++; continue; }
      count(expected, t);
      const p = prices.get(t.price) ?? { buy: 0, sell: 0 } as { buy: number; sell: number; unknown?: number };
      if (t.side === "unknown") p.unknown = (p.unknown ?? 0) + t.size; else p[t.side] += t.size;
      prices.set(t.price, p);
      const key = `${hour}/${f.sha256}/${kind}`;
      let hash = content.get(key); if (!hash) { hash = createHash("sha256"); content.set(key, hash); }
      hash.update(line + "\n");
    }
  }
  assert.deepEqual(expected, actual.totals);
  const priceFile = JSON.parse(await fs.readFile(path.join(root, "price-volumes.json"), "utf8"));
  assert.deepEqual(priceFile, [...prices].sort(([a], [b]) => a - b));
  const checked = new Map<string, ReturnType<typeof createHash>>();
  const checkedHours = new Set([...content.keys()].map(k => k.slice(0, 13)));
  for (const hour of checkedHours) {
    const file = path.join(root, `trades/${contract.startsWith("NQ") ? "NQ" : "GC"}`, hour + ".jsonl.gz");
    let previous = -1;
    for await (const { line, trade: t } of tradeFileEntries(file)) {
      if (t.contract !== contract || t.tsUs < active.fromUs || t.tsUs >= active.toUs) continue;
      assert(t.seq > previous, `original CSV order ${contract}/${hour}`); previous = t.seq;
      const raw = JSON.parse(line), key = `${hour}/${raw.source.inputSha256}/${t.side === "unknown" ? "unknown" : "known"}`;
      assert(content.has(key), `unexpected input group ${key}`);
      let hash = checked.get(key); if (!hash) { hash = createHash("sha256"); checked.set(key, hash); }
      hash.update(line + "\n");
    }
  }
  for (const [key, hash] of content) assert.equal(checked.get(key)?.digest("hex"), hash.digest("hex"), `row content/order/multiplicity ${contract}/${key}`);
  let dailyCount = 0, dailyBuy = 0, dailySell = 0;
  for (const s of actual.sessions) {
    const state = new DailyState(contract.startsWith("NQ") ? "NQ" : "GC");
    const daily = JSON.parse(await fs.readFile(s.dailyFile, "utf8"));
    // Hub adds the instrument tag to VolumeProfile's internal snapshot on wire.
    assert.equal(state.accept({ ...daily, symbol: contract.startsWith("NQ") ? "NQ" : "GC" }), true); state.series();
    const snapshot = state.snapshot();
    assert.equal(snapshot.total, s.stats.buy + s.stats.sell + s.stats.unknown); assert.equal(snapshot.cvd, s.stats.buy - s.stats.sell);
    assert(Math.abs(snapshot.vwapTicks! - s.stats.weighted / snapshot.total) < 1e-8);
    dailyCount += s.stats.count; dailyBuy += s.stats.buy; dailySell += s.stats.sell;
  }
  assert.equal(dailyCount, expected.count); assert.equal(dailyBuy, expected.buy); assert.equal(dailySell, expected.sell);
  let longBuy = 0, longSell = 0, longUnknown = 0;
  for (const f of await fs.readdir(path.join(root, "longvp")).catch(e => { if (e.code === "ENOENT") return []; throw e; })) {
    const day = JSON.parse(await fs.readFile(path.join(root, "longvp", f), "utf8"));
    for (const r of day.vp30m) { longBuy += r[2]; longSell += r[3]; longUnknown += r[5] ?? 0; }
  }
  assert.equal(longBuy, expected.buy); assert.equal(longSell, expected.sell); assert.equal(longUnknown, expected.unknown);
  results.push({ contract, adopted: expected, blockedRows, outsideRows, prices: prices.size,
    checkedHourFiles: checkedHours.size, sessions: actual.sessions.length, daily: { count: dailyCount, buy: dailyBuy, sell: dailySell, unknown: expected.unknown },
    longvp: { buy: longBuy, sell: longSell, unknown: longUnknown }, result: "pass" });
}
const baseline = JSON.parse(await fs.readFile(path.join(out, "baseline/snapshot.json"), "utf8"));
for (const f of baseline.files) assert.equal(await sha(path.join("data", f.path)), f.sha256, `original unchanged: ${f.path}`);
const report = { archiveSha256: active.archiveSha256, sourceRows, spreadRows, errorRows, unknownRows, unknownQuantity,
  sourceAccountedRows: active.staged.reduce((sum: number, f: any) => sum + Object.values(f.contracts).reduce((n: number, c: any) => n + c.count, 0), 0) + spreadRows + errorRows,
  results, originalFilesUnchanged: baseline.files.length };
assert.equal(report.sourceRows, report.sourceAccountedRows);
await fs.writeFile(path.join(out, "full-check.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
