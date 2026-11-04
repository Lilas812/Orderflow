// Read-only comparison of two explicit completed exports. Never generates/replaces datasets.
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
const args = process.argv.slice(2), arg = flag => args[args.indexOf(flag) + 1];
if (!["--first", "--second", "--out"].every(f => args.includes(f) && arg(f)))
  throw Error("usage: verify-pilot.mjs --first DATASET_DIR --second DATASET_DIR --out NEW_EVIDENCE_JSON");
async function hash(file) {
  const h = createHash("sha256"); for await (const b of createReadStream(file)) h.update(b); return h.digest("hex");
}
const dirs = [path.resolve(arg("--first")), path.resolve(arg("--second"))], manifests = [];
const expected = ["samples.csv", "features.csv", "history.csv", "annotations.csv", "targets.csv",
  "splits.csv", "quality.json", "columns.md", "README.md", "config.json"].sort();
for (const dir of dirs) {
  const m = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(m.files.map(f => f.name).sort(), expected);
  assert.equal(createHash("sha256").update(JSON.stringify(m.files)).digest("hex"), m.content_hash);
  for (const f of m.files) assert.equal(await hash(path.join(dir, f.name)), f.sha256, f.name);
  assert.ok(m.input.every(s => s.files.every(f => f.original_unchanged)));
  execFileSync("unzip", ["-t", path.join(dir, "dataset-v2.zip")]);
  manifests.push(m);
}
const [a, b] = manifests;
assert.equal(a.code.sourceHash, b.code.sourceHash, "same executed source required; commit metadata is not payload");
assert.deepEqual(a.input, b.input, "same frozen inputs required");
assert.deepEqual(a.annotation_snapshots, b.annotation_snapshots);
assert.equal(a.content_hash, b.content_hash);
const result = { datasets: dirs, sameCode: true, sameInput: true, contentHash: a.content_hash,
  sourceHash: a.code.sourceHash, recordedRevisions: manifests.map(m => m.code.revision),
  payloadHashesVerified: true, zipCrcPassed: true, zipHashCompared: false, counts: a.counts };
await fs.mkdir(path.dirname(arg("--out")), { recursive: true, mode: 0o700 });
await fs.writeFile(arg("--out"), JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(result));
