/** Read-only, sequential, generation-pinned copies. No production HTTP or writers. */
import fs from "node:fs";
import path from "node:path";
import { ReplitObjects, digest } from "../server/src/store/objects.ts";

const dir = path.resolve("data/research-v2/gc-alignment-02");
fs.mkdirSync(dir, { recursive: true });
const manifestFile = path.join(dir, "inputs.json");
const rows = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile)) : [];
const objects = new ReplitObjects();
try {
  for (const kind of ["columns/GC/1s", "trades/GC"]) {
    const prefix = `prod/instruments/GC/${kind}/`;
    const names = (await objects.list(prefix)).filter(n => {
      const date = n.match(/2026-\d\d-\d\d/)?.[0];
      return date && date >= "2026-09-30" && date < "2026-11-04" && /\.(bin|jsonl)\.gz$/.test(n);
    }).sort();
    for (const name of names) {
      const old = rows.find(r => r.name === name);
      if (old) {
        if (await digest(path.resolve(old.file)) !== old.sha256) throw Error("existing_copy_hash_changed");
        continue;
      }
      const file = path.join(dir, "copies", name);
      const generation = await objects.downloadVersion(name, file);
      if (generation === null) throw Error("listed_object_disappeared");
      rows.push({ name, generation, file: path.relative(process.cwd(), file),
        sha256: await digest(file), bytes: fs.statSync(file).size });
      fs.writeFileSync(manifestFile, JSON.stringify(rows, null, 2) + "\n");
      console.log(JSON.stringify({ copied: rows.length, name, bytes: fs.statSync(file).size }));
    }
  }
  console.log(JSON.stringify({ complete: true, files: rows.length, bytes: rows.reduce((n,r)=>n+r.bytes,0) }));
} catch {
  console.error("read_only_copy_failed; no SDK error details printed");
  process.exitCode = 1;
}
