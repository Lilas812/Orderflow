// Fill only missing INPUT copies for the requested 10/30 rebuild.
// Object operations are exists/download ONLY, never upload/delete.
import { ReplitObjects, digest } from "../../src/store/objects.ts";
import { clipRanges, coveredHours } from "../../src/store/coverage.ts";
import { dayBounds } from "../../src/long-vp/day.ts";
import * as fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(`data/dev/coverage-publish-oct30-readonly/run-${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const objects = new ReplitObjects(), bounds = dayBounds("2026-10-30");
const result = { label: "additional_read_only_production_copy", atUs: Date.now() * 1000,
  date: "2026-10-30", files: [], missing: [], unstable: [] };
for (const [symbol, prefix] of [["NQ", "prod/"], ["GC", "prod/instruments/GC/"]]) {
  const coverageFile = `data/dev/main-thread-snapshot/${prefix.replace(/^prod\//, "dev/")}coverage.json`;
  const index = JSON.parse(await fs.readFile(coverageFile, "utf8"));
  for (const hour of coveredHours(clipRanges(index.tick, bounds.startUs / 1e6, bounds.endUs / 1e6))) {
    const iso = new Date(hour * 1000).toISOString();
    const source = `${prefix}trades/${symbol}/${iso.slice(0, 10)}/${iso.slice(11, 13)}.jsonl.gz`;
    if (!await objects.exists(source)) { result.missing.push(source); continue; }
    const file = path.join(root, source), verify = file + ".verify";
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await objects.download(source, file); await objects.download(source, verify);
      const sha256 = await digest(file);
      if (sha256 !== await digest(verify)) { result.unstable.push(source); continue; }
      result.files.push({ source, file, bytes: (await fs.stat(file)).size, sha256 });
    } finally { await fs.rm(verify, { force: true }); }
    await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(result, null, 2));
  }
}
await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ root, manifest: path.join(root, "manifest.json"),
  files: result.files.length, bytes: result.files.reduce((s, f) => s + f.bytes, 0),
  missing: result.missing, unstable: result.unstable }));
