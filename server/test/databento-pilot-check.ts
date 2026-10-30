/** Independent CSV decimal conversion + actual LocalStore readback, purchased input only. */
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createZstdDecompress } from "node:zlib";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import path from "node:path";
import { LocalStore } from "../src/store/local.ts";
class ReadOnlyStore extends LocalStore { protected override async retention() {} }
const out = process.argv.find(a => a.startsWith("--out="))?.slice(6) ?? "data/databento-import";
const active = JSON.parse(await fs.readFile(path.join(out, "active.json"), "utf8"));
const expected: Record<string, { count: number; buy: number; sell: number; unknown: number; prices: Map<number, number[]> }> = {};
const child = spawn("unzip", ["-p", active.original, "glbx-mdp3-20260930.trades.csv.zst"]);
const lines = createInterface({ input: child.stdout.pipe(createZstdDecompress()), crlfDelay: Infinity });
let first = true;
for await (const line of lines) {
  if (first) { first = false; continue; }
  const c = line.split(",");
  if (!/^(NQ|GC)[FGHJKMNQUVXZ]\d$/.test(c[13]!)) continue;
  const ts = Date.parse(c[1]!.slice(0, 19) + "Z") * 1000 + Number(c[1]!.slice(20, 26).padEnd(6, "0"));
  if (ts < active.fromUs || ts >= active.toUs) continue;
  const contract = c[13]!.slice(0, 3) + "2" + c[13]!.at(-1);
  const e = expected[contract] ??= { count: 0, buy: 0, sell: 0, unknown: 0, prices: new Map() };
  const side = c[6] === "B" ? "buy" : c[6] === "A" ? "sell" : "unknown";
  e[side] += Number(c[9]); e.count++;
  if (side === "unknown") continue; // preserved separately, never allocate to buy/sell
  const [whole, fractional = ""] = c[8]!.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fractional.slice(0, 2).padEnd(2, "0"));
  const tick = c[13]!.startsWith("GC") ? 10n : 25n;
  assert.equal(cents % tick, 0n);
  const price = Number(cents / tick), p = e.prices.get(price) ?? [0, 0, 0];
  p[side === "buy" ? 0 : side === "sell" ? 1 : 2]! += Number(c[9]); e.prices.set(price, p);
}
const results = [];
for (const [contract, e] of Object.entries(expected)) {
  const root = path.join(active.generation, contract);
  const store = new ReadOnlyStore(root, Date.now, undefined, contract.startsWith("GC") ? "GC" : "NQ");
  await store.initialize();
  const actual = await store.readTrades(active.fromUs / 1e6, active.toUs / 1e6);
  const prices = new Map<number, number[]>(); let buy = 0, sell = 0;
  for (const t of actual) {
    assert.equal(t.contract, contract);
    if (t.side === "buy") buy += t.size; else sell += t.size;
    const v = prices.get(t.price) ?? [0, 0, 0]; v[t.side === "buy" ? 0 : 1]! += t.size; prices.set(t.price, v);
    const src = (t as unknown as { source: { tsEventNs: string } }).source;
    assert.equal(Number(BigInt(src.tsEventNs) / 1000n), t.tsUs);
  }
  assert.equal(buy, e.buy); assert.equal(sell, e.sell);
  assert.deepEqual([...prices].sort(([a], [b]) => a! - b!), [...e.prices].map(([p, v]) => [p, [v[0], v[1], 0]]).sort(([a], [b]) => Number(a) - Number(b)));
  const daily = JSON.parse(await fs.readFile(path.join(root, "rebuild.json"), "utf8"));
  assert.equal(daily.totals.buy, buy); assert.equal(daily.totals.sell, sell);
  results.push({ contract, input: { ...e, prices: e.prices.size }, actualRows: actual.length, buy, sell,
    cvd: buy - sell, rebuilt: daily.totals, result: "pass" });
}
await fs.writeFile(path.join(out, "pilot-check.json"), JSON.stringify({ fromUs: active.fromUs, toUs: active.toUs, results }, null, 2));
console.log(JSON.stringify(results));
