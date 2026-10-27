import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";

// Independent file-counting tool; no production VP or aggregation imports.
const start = Number(process.argv[2]), end = Number(process.argv[3]), output = process.argv[4];
if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !output) throw Error("start end output required");
const levels = new Map<number, [number, number]>();
let count = 0, buy = 0, sell = 0, files = 0;
for (let h = Math.floor(start / 3600) * 3600; h < end; h += 3600) {
  const date = new Date(h * 1000).toISOString();
  const file = path.resolve("data/trades/NQ", date.slice(0, 10), date.slice(11, 13) + ".jsonl.gz");
  try { await fs.access(file); } catch { continue; }
  files++;
  const raw = createReadStream(file), inflated = raw.pipe(createGunzip());
  raw.on("error", error => inflated.destroy(error));
  const lines = createInterface({ input: inflated, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line) {
      const t = JSON.parse(line);
      if (t.tsUs < start * 1e6 || t.tsUs >= end * 1e6) continue;
      const value = levels.get(t.price) ?? [0, 0];
      value[t.side === "buy" ? 0 : 1] += t.size; levels.set(t.price, value);
      if (t.side === "buy") buy += t.size; else sell += t.size;
      count++;
    }
  } finally { lines.close(); inflated.destroy(); raw.destroy(); }
}
const result = { type: "vp", sessionStartSec: start, upToSec: end, loading: false, count, buy, sell,
  total: buy + sell, files, levels: [...levels].sort(([a], [b]) => a - b).map(([p, [b, s]]) => [p, b, s]) };
await fs.writeFile(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, count, buy, sell, total: buy + sell, prices: levels.size, files }));
