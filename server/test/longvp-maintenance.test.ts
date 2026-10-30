import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ConditionalCloud, CloudVersion } from "../src/import/longvp-cloud.ts";
import { backupApprovedDays, applyApprovedDays, restoreApprovedDays, allowedTarget } from "../src/import/longvp-maintenance.ts";
import { sha } from "../src/import/databento-stage.ts";
import { datesBetween } from "../src/long-vp/day.ts";
class FakeCloud implements ConditionalCloud {
  files = new Map<string, { bytes: Buffer; version: CloudVersion }>();
  seq = 0; writes: string[] = [];
  async stat(n: string) { return this.files.get(n)?.version ?? null; }
  async list(prefix: string) { return [...this.files.keys()].filter(n => n.startsWith(prefix)); }
  async download(n: string, gen: string, f: string) {
    const o = this.files.get(n);
    if (!o || o.version.generation !== gen) throw Error("generation_unavailable");
    await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, o.bytes);
  }
  async put(n: string, f: string, expected: string | null, metadata: Record<string, string> = {}) {
    if ((this.files.get(n)?.version.generation ?? null) !== expected) throw Error("precondition_failed");
    const bytes = await fs.readFile(f), generation = String(++this.seq);
    this.files.set(n, { bytes, version: { generation, size: bytes.length, metadata } }); this.writes.push(n);
    return generation;
  }
  async remove(n: string, gen: string) {
    if (this.files.get(n)?.version.generation !== gen) throw Error("precondition_failed");
    this.files.delete(n);
  }
}
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-cas-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cloud = new FakeCloud(), oldFile = path.join(root, "original.gz");
  await fs.writeFile(oldFile, "EXACT ORIGINAL BYTES");
  const name = "prod/longvp/NQ/days/2026-10-26.json.gz";
  const generation = await cloud.put(name, oldFile, null);
  const original = { name, file: oldFile, sha256: await sha(oldFile), ...(await cloud.stat(name))! };
  const candidates = [];
  for (const symbol of ["NQ", "GC"]) for (const date of datesBetween("2026-10-01", "2026-10-29")) {
    const file = path.join(root, `${symbol}-${date}.gz`); await fs.writeFile(file, `candidate ${symbol} ${date}`);
    candidates.push({ name: `prod/longvp/${symbol}/days/${date}.json.gz`, file, sha256: await sha(file) });
  }
  const run = "20261030T170000Z-abcdef12";
  return { root, cloud, original, name, generation, candidates, run };
}
test("backs up exact bytes and absence before writes, applies 42 only, rerun does not add generations, restores", async t => {
  const f = await fixture(t), result = await backupApprovedDays(f.cloud, [f.original], f.root, f.run);
  assert.equal(result.existingFiles, 1); assert.equal(result.absentTargets, 41);
  assert.equal(f.cloud.files.get(result.manifest.records.find(r => r.name === f.name)!.backup!.name)!.bytes.toString(), "EXACT ORIGINAL BYTES");
  await assert.rejects(applyApprovedDays(f.cloud, result.manifest, f.candidates, f.root, { runtimeWriterStopped: false }), /exclusion/);
  const applied = await applyApprovedDays(f.cloud, result.manifest, f.candidates, f.root, { runtimeWriterStopped: true });
  const seq = f.cloud.seq;
  assert.equal(applied.length, 42);
  assert.deepEqual(await applyApprovedDays(f.cloud, result.manifest, f.candidates, f.root, { runtimeWriterStopped: true }), applied);
  assert.equal(f.cloud.seq, seq);
  await restoreApprovedDays(f.cloud, result.manifest, f.root, true);
  assert.equal(f.cloud.files.get(f.name)!.bytes.toString(), "EXACT ORIGINAL BYTES");
  assert.equal((await f.cloud.list("prod/longvp/")).length, 1);
  assert.deepEqual(await restoreApprovedDays(f.cloud, result.manifest, f.root, true), []);
});
test("ambiguous interruption after successful CAS is recovered without doubling or reuploading first object", async t => {
  const f = await fixture(t), result = await backupApprovedDays(f.cloud, [f.original], f.root, f.run);
  await assert.rejects(applyApprovedDays(f.cloud, result.manifest, f.candidates, f.root, {
    runtimeWriterStopped: true, afterWrite: () => { throw Error("simulated_disconnect_after_write"); },
  }), /simulated_disconnect/);
  const first = (await f.cloud.stat(f.candidates[0]!.name))!.generation;
  await applyApprovedDays(f.cloud, result.manifest, f.candidates, f.root, { runtimeWriterStopped: true });
  assert.equal((await f.cloud.stat(f.candidates[0]!.name))!.generation, first);
});
test("original change and newly appeared target fail backup; no target overwritten; lock released", async t => {
  const f = await fixture(t);
  await f.cloud.put(f.name, f.original.file, f.generation);
  await assert.rejects(backupApprovedDays(f.cloud, [f.original], f.root, f.run), /changed_since_capture/);
  assert.equal(await f.cloud.stat("prod/backup/longvp/promotion.lock"), null);
});
test("corrupted backup prevents any apply; later independent writes prevent rollback", async t => {
  const f = await fixture(t), result = await backupApprovedDays(f.cloud, [f.original], f.root, f.run);
  const rec = result.manifest.records.find(r => r.name === f.name)!, saved = f.cloud.files.get(rec.backup!.name)!;
  const bytes = saved.bytes; saved.bytes = Buffer.from("CORRUPT");
  await assert.rejects(applyApprovedDays(f.cloud, result.manifest, f.candidates, f.root, { runtimeWriterStopped: true }), /hash_changed/);
  assert.equal((await f.cloud.stat(f.name))!.generation, f.generation);
  saved.bytes = bytes;
  await applyApprovedDays(f.cloud, result.manifest, f.candidates, f.root, { runtimeWriterStopped: true });
  const later = await f.cloud.stat(f.name);
  await f.cloud.put(f.name, f.original.file, later!.generation);
  await assert.rejects(restoreApprovedDays(f.cloud, result.manifest, f.root, true), /concurrent_change/);
});
test("scope excludes partial days and all raw-trade objects", () => {
  assert.equal(allowedTarget("prod/longvp/NQ/days/2026-10-30.json.gz"), false);
  assert.equal(allowedTarget("prod/longvp/NQ/days/2026-09-30.json.gz"), false);
  assert.equal(allowedTarget("prod/trades/NQ/2026-10-26/00.jsonl.gz"), false);
  assert.equal(allowedTarget("prod/longvp/GC/days/2026-10-29.json.gz"), true);
});
