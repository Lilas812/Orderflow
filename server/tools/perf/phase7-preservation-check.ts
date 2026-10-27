import * as fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";

// Verification evidence only; never writes to the application's trade store.
const before = path.resolve("data/phase7/pre-insertion-snapshot/trades/NQ");
const after = path.resolve("data/trades/NQ");
const results: { file: string; beforeRows: number; afterRows: number; matchedInOrder: number; preserved: boolean }[] = [];
const lines = async (file: string) => gunzipSync(await fs.readFile(file)).toString().split("\n").filter(Boolean);
for (const day of await fs.readdir(before)) {
  for (const name of await fs.readdir(path.join(before, day))) {
    if (!name.endsWith(".jsonl.gz")) continue;
    const old = await lines(path.join(before, day, name));
    const current = await lines(path.join(after, day, name));
    let matched = 0;
    for (const line of current) if (matched < old.length && line === old[matched]) matched++;
    results.push({ file: `data/trades/NQ/${day}/${name}`, beforeRows: old.length,
      afterRows: current.length, matchedInOrder: matched, preserved: matched === old.length });
  }
}
await fs.writeFile("data/phase7/final/preservation-check.json", JSON.stringify({
  at: new Date().toISOString(), note: "Compares only the snapshot made after the old implementation stopped.",
  files: results, allPreserved: results.every(r => r.preserved),
}, null, 2));
assert.ok(results.every(r => r.preserved), "every pre-insertion snapshot line remains unchanged and in its original relative order");
console.log("VP_PRESERVATION_MATCH", { files: results.length, oldRows: results.reduce((n, r) => n + r.beforeRows, 0) });
