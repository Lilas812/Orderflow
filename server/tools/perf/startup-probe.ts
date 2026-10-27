import * as fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeColumns } from "../../src/store/binary.ts";
import { scanColumnFile } from "../../src/store/records.ts";

const mode = process.argv[2];
if (!["before", "stream"].includes(mode)) throw Error("expected_before_or_stream");
const root = path.resolve("data/columns/NQ/1s/2026-10-26");
const files = (await fs.readdir(root)).filter(name => /^\d\d\.bin(?:\.gz)?$/.test(name)).sort();
const started = performance.now(), initial = process.memoryUsage();
const steps: unknown[] = [];
let count = 0, checksum = 0;
const include = (second: number) => { count++; checksum = (checksum + second) % 4294967296; };
for (const name of files) {
  const file = path.join(root, name);
  if (mode === "before") {
    const bytes = await fs.readFile(file);
    for (const c of decodeColumns(name.endsWith("gz") ? gunzipSync(bytes) : bytes)) include(c.tsSec);
  } else await scanColumnFile(file, include);
  steps.push({ name, ...process.memoryUsage() });
}
process.stdout.write(JSON.stringify({ mode, count, checksum, elapsedMs: performance.now() - started,
  initial, end: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS, steps }, null, 2) + "\n");
