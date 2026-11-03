// Read-only cloud source. All writes are to ignored local data/dev/ only.
import { ReplitObjects, digest } from "../../src/store/objects.ts";
import * as fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve("data/dev/main-thread-snapshot");
const objects = new ReplitObjects(), names = new Set(), end = Date.now() / 1000, start = end - 48 * 3600;
for (const prefix of ["prod/", "prod/instruments/GC/"]) {
  for (const name of ["coverage.json", ...(prefix === "prod/" ? ["settings.json", "settings-longvp.json"] : [])])
    if (await objects.exists(prefix + name)) names.add(prefix + name);
}
for (const name of await objects.list("prod/longvp/")) names.add(name);
for (const [base, symbol] of [["prod/", "NQ"], ["prod/instruments/GC/", "GC"]]) {
  for (let sec = Math.floor(start / 86400) * 86400; sec <= end; sec += 86400) {
    const date = new Date(sec * 1000).toISOString().slice(0, 10);
    for (const prefix of [`${base}columns/${symbol}/1s/${date}/`, `${base}trades/${symbol}/${date}/`]) {
      for (const name of await objects.list(prefix)) {
        const hh = /\/(\d\d)\.(?:bin|jsonl)\.gz$/.exec(name)?.[1];
        if (hh === undefined) continue;
        const hour = Date.parse(`${date}T${hh}:00:00Z`) / 1000;
        if (hour + 3600 > start && hour < end) names.add(name);
      }
    }
  }
}
const manifest = { label: "read_only_production_copy", atUs: Date.now() * 1000,
  startSec: start, endSec: end, files: [] };
for (const name of [...names].sort()) {
  if (!/^prod\/[\w./-]+$/.test(name) || name.includes("..")) throw Error("unsafe_object_path");
  const file = path.join(root, name.replace(/^prod\//, "dev/"));
  await objects.download(name, file);
  manifest.files.push({ source: name, file, bytes: (await fs.stat(file)).size, sha256: await digest(file) });
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ files: manifest.files.length, bytes: manifest.files.reduce((s, f) => s + f.bytes, 0), root }));
