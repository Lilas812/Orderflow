/** Read only. Never imports application startup or upstream clients. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { LongVpCloud } from "../src/import/longvp-cloud.ts";
import { sha } from "../src/import/databento-stage.ts";
const args = process.argv.slice(2);
const daysOnly = args.includes("--days-only");
const outputArgs = args.filter(a => a.startsWith("--out="));
if (outputArgs.length !== 1 || args.length !== (daysOnly ? 2 : 1)) throw Error("use_out_new_directory");
const root = path.resolve(outputArgs[0]!.slice(6));
if (!root.startsWith(path.resolve("data/longvp-maintenance") + path.sep)) throw Error("isolated_output_required");
await fs.mkdir(path.dirname(root), { recursive: true }); await fs.mkdir(root, { mode: 0o700 });
const cloud = new LongVpCloud(), names = new Set(await cloud.list("prod/longvp/"));
for (const prefix of daysOnly ? [] : ["prod/trades/NQ/", "prod/instruments/GC/trades/GC/"]) {
  for (const date of ["2026-10-25", "2026-10-26", "2026-10-27"])
    for (const n of await cloud.list(prefix + date + "/")) names.add(n);
}
for (const n of daysOnly ? [] : ["prod/coverage.json", "prod/instruments/GC/coverage.json"])
  if (await cloud.stat(n)) names.add(n);
const objects = [];
for (const name of [...names].sort()) {
  const before = await cloud.stat(name);
  if (!before) throw Error("snapshot_object_disappeared");
  const file = path.join(root, "objects", name);
  await cloud.download(name, before.generation, file);
  const after = await cloud.stat(name);
  if (after?.generation !== before.generation) throw Error("snapshot_object_changed");
  objects.push({ name, file, sha256: await sha(file), ...before });
}
await fs.writeFile(path.join(root, "inventory.json"), JSON.stringify({
  version: 1, capturedAt: new Date().toISOString(), rawStoredBytes: true, objects,
}, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ root, objects: objects.length,
  longvp: objects.filter(o => o.name.startsWith("prod/longvp/")).map(o => ({
    name: o.name, generation: o.generation, bytes: o.size, contentEncoding: o.contentEncoding })),
  raw: objects.filter(o => o.name.includes("/trades/")).length }));
