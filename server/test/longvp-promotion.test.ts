import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dayBounds, type DayData } from "../src/long-vp/day.ts";
import { fillDay, checkGuards, dayObject, type Assignment, type Inventory } from "../src/import/longvp-promotion.ts";
import { captureInventory, preparePromotion, recheckPromotion, type PromotionPlan } from "../src/import/longvp-package.ts";

const DATE = "2026-10-22", start = dayBounds(DATE).startUs / 1e6, end = dayBounds(DATE).endUs / 1e6;
const builtAt = (end + 3600) * 1e6;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function data(slots: number[], contract = "NQZ26", unknown = 0): DayData {
  let gaps: [number, number][] = [[start, end]];
  for (const n of slots) {
    const a = start + n * 1800, b = a + 1800;
    gaps = gaps.flatMap(([x, y]) => y <= a || x >= b ? [[x, y] as [number, number]]
      : [...(x < a ? [[x, a] as [number, number]] : []), ...(b < y ? [[b, y] as [number, number]] : [])]);
  }
  return { version: 1, tradingDate: DATE, startSec: start, endSec: end, builtAtUs: builtAt - 1,
    contracts: [{ contract, fromSec: start, toSec: end }],
    bars1m: slots.map(n => [start + n * 1800 + 60, 100, 100, 100, 100, 3, 2, 0, unknown]),
    vp30m: slots.map(n => [start + n * 1800, 100, 3, 2, 0, unknown]), gaps, complete: !gaps.length };
}
const window = (sourceContract = "NQZ26", targetContract = sourceContract): Assignment =>
  ({ fromSec: start, toSec: end, sourceContract, targetContract, evidence: "fixture: explicit confirmed interval, not inferred" });
const quantity = (d: DayData) => d.vp30m.reduce((n, r) => n + r[2] + r[3] + (r[5] ?? 0), 0);

test("fills only disjoint certified bins; old rows/order, unknown volume and inputs unchanged", () => {
  const base = data([1]), source = data([0, 1, 2], "NQZ26", 7);
  const before = JSON.stringify([base, source]);
  const { day, audit } = fillDay(base, source, [window()], "NQ", builtAt);
  assert.deepEqual(audit.accepted, [start, start + 3600]);
  assert.equal(audit.unknown, 14); assert.equal(audit.weightedTicks, "2400");
  assert.equal(quantity(day), quantity(base) + 24);
  assert.deepEqual(day.bars1m.filter(r => r[0] === base.bars1m[0]![0]), base.bars1m);
  assert.deepEqual(day.vp30m.filter(r => r[0] === base.vp30m[0]![0]), base.vp30m);
  assert.equal(JSON.stringify([base, source]), before);
  assert.equal(day.complete, false);
  assert.equal(day.builtAtUs, builtAt);
});
test("repeating fill does not add twice or reset builtAt", () => {
  const source = data([0, 1]), first = fillDay(null, source, [window()], "NQ", builtAt);
  const twice = fillDay(first.day, source, [window()], "NQ", builtAt + 1);
  assert.equal(twice.audit.accepted.length, 0); assert.deepEqual(twice.day, first.day);
});
test("a production row inside a claimed gap is still protected", () => {
  const base = data([0]); base.gaps = [[start, end]];
  const result = fillDay(base, data([0]), [window()], "NQ", builtAt);
  assert.equal(result.audit.accepted.length, 0); assert.deepEqual(result.day, base);
});
test("partial source bin, partial production gap and unassigned boundaries stay unknown", () => {
  const source = data([0]); source.gaps.unshift([start, start + 1]);
  assert.equal(fillDay(null, source, [window()], "NQ", builtAt).audit.accepted.length, 0);
  const base = data([]); base.gaps = [[start + 1, end]];
  assert.equal(fillDay(base, data([0]), [window()], "NQ", builtAt).audit.accepted.length, 0);
  const narrow = { ...window(), fromSec: start + 1 };
  assert.equal(fillDay(null, data([0]), [narrow], "NQ", builtAt).audit.accepted.length, 0);
});
test("no contract selection makes no assumptions; missing rows do not certify zero", () => {
  assert.equal(fillDay(null, data([0]), [], "NQ", builtAt).audit.accepted.length, 0);
  const source = data([0]); source.bars1m = []; source.vp30m = [];
  const result = fillDay(null, source, [window()], "NQ", builtAt);
  assert.deepEqual(result.day.gaps, [[start, end]]);
});
test("NQ one-digit alias requires explicit mapping and preserves old contract indices", () => {
  const base = data([0], "NQZ6");
  const result = fillDay(base, data([1]), [window("NQZ26", "NQZ6")], "NQ", builtAt);
  assert.equal(result.audit.accepted.length, 1); assert.deepEqual(result.day.contracts, base.contracts);
  assert.deepEqual(result.day.bars1m[0], base.bars1m[0]);
  assert.equal(fillDay(base, data([1]), [window()], "NQ", builtAt).audit.accepted.length, 0);
});
test("GC unknown direction is volume, not fabricated buy/sell; exact cells and rows retained", () => {
  const source = data([0], "GCZ26", 11);
  source.bars1m.push(source.bars1m[0]!.slice() as DayData["bars1m"][number]);
  source.vp30m.push(source.vp30m[0]!.slice() as DayData["vp30m"][number]);
  const result = fillDay(null, source, [window("GCZ26")], "GC", builtAt);
  assert.equal(quantity(result.day), 32); assert.equal(result.audit.buy, 6);
  assert.equal(result.audit.sell, 4); assert.equal(result.audit.unknown, 22);
  assert.deepEqual(result.day.vp30m, source.vp30m);
  assert.equal(result.audit.weightedTicks, "3200");
});
test("overlapping assignments, missing evidence, cross-symbol and invalid bounds fail closed", () => {
  assert.throws(() => fillDay(null, data([0]), [window(), window()], "NQ", builtAt), /assignment/);
  assert.throws(() => fillDay(null, data([0]), [{ ...window(), evidence: "" }], "NQ", builtAt), /assignment/);
  assert.throws(() => fillDay(null, data([0]), [window("GCZ26")], "NQ", builtAt));
  const bad = data([0]); bad.endSec--;
  assert.throws(() => fillDay(null, bad, [window()], "NQ", builtAt));
});
test("quantity mismatch and out-of-order aggregates are not silently accepted", () => {
  const bad = data([0]); bad.bars1m[0]![5]++;
  assert.throws(() => fillDay(null, bad, [window()], "NQ", builtAt), /quantity_mismatch/);
  const reversed = data([0, 1]); reversed.bars1m.reverse();
  assert.throws(() => fillDay(null, reversed, [window()], "NQ", builtAt), /unordered/);
});
test("last half-open bin included, prior/next day never combined", () => {
  const d = data([47]), w = { ...window(), fromSec: end - 1800 };
  assert.deepEqual(fillDay(null, d, [w], "NQ", builtAt).audit.accepted, [end - 1800]);
  assert.equal(fillDay(null, d, [{ ...w, toSec: end - 1 }], "NQ", builtAt).audit.accepted.length, 0);
  const next = data([0]); next.tradingDate = "2026-10-23";
  assert.throws(() => fillDay(next, d, [w], "NQ", builtAt));
});
test("unclosed or future bins cannot be adopted even with an explicit assignment", () => {
  const result = fillDay(null, data([0, 1]), [window()], "NQ", (start + 1800) * 1e6);
  assert.deepEqual(result.audit.accepted, [start]);
  assert.equal(result.day.vp30m.length, 1);
  assert.ok(result.audit.skipped.not_closed_at_snapshot);
});
async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longvp-promotion-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const base = path.join(dir, "base.json.gz"), source = path.join(dir, "source.json");
  const b = gzipSync(JSON.stringify(data([0]))), s = JSON.stringify(data([0, 1], "NQZ26", 7));
  await fs.writeFile(base, b); await fs.writeFile(source, s);
  const inventory: Inventory = { version: 1, symbol: "NQ", capturedAt: new Date(builtAt / 1000).toISOString(),
    objects: [{ name: dayObject("NQ", DATE), file: base, sha256: sha(b) }] };
  const inventoryFile = path.join(dir, "inventory.json"), inv = JSON.stringify(inventory);
  await fs.writeFile(inventoryFile, inv);
  const plan: PromotionPlan = { version: 1, symbol: "NQ", builtAtUs: builtAt, inventoryFile,
    inventorySha256: sha(inv), sources: [{ file: source, sha256: sha(s), contract: "NQZ26" }], assignments: [window()] };
  return { dir, base, source, inventory, plan, out: path.join(dir, "out") };
}
test("package preserves originals/backup bytes, verifies candidate, unchanged repeat adds nothing", async t => {
  const f = await fixture(t), before = await fs.readFile(f.base);
  const r = await preparePromotion(f.plan, f.out);
  assert.equal(r.state, "prepared"); assert.equal(r.manifest.days.filter(d => d.changed).length, 1);
  assert.deepEqual(await fs.readFile(f.base), before);
  const backup = await fs.readFile(path.join(f.out, "backups", sha(before) + ".json.gz"));
  assert.deepEqual(backup, before);
  const candidate = JSON.parse(gunzipSync(await fs.readFile(path.join(f.out, r.manifest.days[0]!.file!))).toString());
  assert.equal(quantity(candidate), 17);
  const active = await fs.readFile(path.join(f.out, "active.json"));
  const again = await preparePromotion(f.plan, f.out);
  assert.equal(again.state, "already_prepared"); assert.deepEqual(again.manifest, r.manifest);
  assert.deepEqual(await fs.readFile(path.join(f.out, "active.json")), active);
  assert.deepEqual(await fs.readFile(f.base), before);
  await assert.rejects(recheckPromotion(r.manifest, f.plan.inventoryFile), /newer_snapshot_required/);
  const fresh = { ...f.inventory, capturedAt: new Date(Date.parse(f.inventory.capturedAt) + 1000).toISOString() };
  const freshFile = path.join(f.dir, "fresh.json"); await fs.writeFile(freshFile, JSON.stringify(fresh));
  assert.deepEqual(await recheckPromotion(r.manifest, freshFile),
    { state: "snapshot_matches", atomicCloudWriteVerified: false, targets: 1, capturedAt: fresh.capturedAt });
});
test("failure before local commit, cancellation, retry and lock release", async t => {
  const f = await fixture(t);
  await assert.rejects(preparePromotion(f.plan, f.out, { afterStage: () => { throw Error("injected"); } }), /injected/);
  await assert.rejects(fs.stat(path.join(f.out, "active.json")), /ENOENT/);
  await assert.rejects(fs.stat(path.join(f.out, "prepare.lock")), /ENOENT/);
  const signal = AbortSignal.abort();
  await assert.rejects(preparePromotion(f.plan, f.out, { signal }));
  const r = await preparePromotion(f.plan, f.out);
  assert.equal(r.state, "prepared");
});
test("crash after generation rename recovers active pointer without rebuilding or doubling", async t => {
  const f = await fixture(t);
  await assert.rejects(preparePromotion(f.plan, f.out, { afterRename: () => { throw Error("injected"); } }), /injected/);
  await assert.rejects(fs.stat(path.join(f.out, "active.json")), /ENOENT/);
  const r = await preparePromotion(f.plan, f.out);
  assert.equal(r.state, "already_prepared");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.out, "active.json"), "utf8")).generation, r.generation);
});
test("changed source, corrupted candidate and missing candidate fail rather than resetting", async t => {
  const f = await fixture(t), r = await preparePromotion(f.plan, f.out);
  const file = path.join(f.out, r.manifest.days[0]!.file!);
  const saved = await fs.readFile(file);
  await fs.writeFile(file, "corrupt");
  await assert.rejects(preparePromotion(f.plan, f.out), /input_hash_changed/);
  await fs.writeFile(file, saved);
  await fs.unlink(file);
  await assert.rejects(preparePromotion(f.plan, f.out), /ENOENT/);
  await fs.writeFile(f.source, "{}");
  await assert.rejects(preparePromotion(f.plan, f.out), /input_hash_changed/);
});
test("duplicate input identity and mixed contract source cannot add twice", async t => {
  const f = await fixture(t);
  await assert.rejects(preparePromotion({ ...f.plan, sources: [...f.plan.sources, ...f.plan.sources] }, f.out), /duplicate/);
  const d = data([0]); d.contracts.push({ contract: "NQH27", fromSec: start, toSec: end });
  const b = JSON.stringify(d); await fs.writeFile(f.source, b);
  await assert.rejects(preparePromotion({ ...f.plan, sources: [{ file: f.source, sha256: sha(b), contract: "NQZ26" }] }, f.out), /mixed_or_wrong/);
});
test("fresh snapshot guards detect overwrite, deletion, new conflicting day, wrong symbol", async t => {
  const f = await fixture(t), r = await preparePromotion(f.plan, f.out);
  const g = r.manifest.guards;
  assert.throws(() => checkGuards(g, { ...f.inventory, objects: [] }, "NQ"), /changed/);
  const altered = structuredClone(f.inventory); altered.objects[0]!.sha256 = "a".repeat(64);
  assert.throws(() => checkGuards(g, altered, "NQ"), /changed/);
  assert.throws(() => checkGuards([{ name: dayObject("NQ", DATE), sha256: null }], f.inventory, "NQ"), /changed/);
  assert.throws(() => checkGuards(g, { ...f.inventory, symbol: "GC" }, "NQ"), /inventory/);
});
test("a live preparation lock is not stolen; output may not contain input files", async t => {
  const f = await fixture(t);
  await preparePromotion(f.plan, f.out);
  await fs.writeFile(path.join(f.out, "prepare.lock"), String(process.pid));
  await assert.rejects(preparePromotion(f.plan, f.out), /preparation_running/);
  assert.equal(await fs.readFile(path.join(f.out, "prepare.lock"), "utf8"), String(process.pid));
  await fs.unlink(path.join(f.out, "prepare.lock"));
  const inside = path.join(f.out, "inside.json");
  await fs.copyFile(f.source, inside);
  await assert.rejects(preparePromotion({ ...f.plan, sources: [{ ...f.plan.sources[0]!, file: inside }] }, f.out), /input_inside_output/);
});
test("oversized compressed expansion is rejected; CLI has no apply/upload mode", async t => {
  const f = await fixture(t), b = gzipSync(Buffer.alloc(5 * 1024 * 1024, 32));
  await fs.writeFile(f.source, b);
  await assert.rejects(preparePromotion({ ...f.plan, sources: [{ ...f.plan.sources[0]!, sha256: sha(b) }] }, f.out));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../tools/prepare-longvp-promotion.ts", import.meta.url)), "--apply=prod"]);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /unsupported_or_duplicate_option/);
});
test("snapshot uses only list/download, verifies two reads and will not reuse a directory", async t => {
  const f = await fixture(t), calls: string[] = [];
  const reader = {
    list: async (prefix: string) => { calls.push("list:" + prefix); return [dayObject("NQ", DATE)]; },
    download: async (name: string, file: string) => { calls.push("download:" + name); await fs.copyFile(f.base, file); },
  };
  const result = await captureInventory(reader, "NQ", path.join(f.dir, "snapshot"));
  assert.deepEqual(result.reads, { list: 2, download: 2 }); assert.equal(calls.length, 4);
  const snapshot = JSON.parse(await fs.readFile(result.file, "utf8"));
  assert.equal(snapshot.objects[0].sha256, f.inventory.objects[0]!.sha256);
  await assert.rejects(captureInventory(reader, "NQ", path.join(f.dir, "snapshot")), /EEXIST/);
});
test("snapshot list mutation and concurrent object mutation do not publish an inventory", async t => {
  const f = await fixture(t); let lists = 0;
  const reader = {
    list: async () => ++lists === 1 ? [dayObject("NQ", DATE)] : [],
    download: async (_: string, file: string) => fs.copyFile(f.base, file),
  };
  const dir = path.join(f.dir, "racing-snapshot");
  await assert.rejects(captureInventory(reader, "NQ", dir), /snapshot_inventory_changed/);
  await assert.rejects(fs.stat(path.join(dir, "inventory.json")), /ENOENT/);
  let downloads = 0;
  const mutating = { list: async () => [dayObject("NQ", DATE)], download: async (_: string, file: string) =>
    fs.writeFile(file, gzipSync(JSON.stringify(data(++downloads === 1 ? [0] : [1])))) };
  await assert.rejects(captureInventory(mutating, "NQ", path.join(f.dir, "changed-snapshot")), /snapshot_object_changed/);
});
test("parallel preparation is excluded while the first is actually in progress", { timeout: 5000 }, async t => {
  const f = await fixture(t); let enter!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = preparePromotion(f.plan, f.out, { afterStage: async () => { enter(); await gate; } });
  await started;
  try { await assert.rejects(preparePromotion(f.plan, f.out), /preparation_running/); }
  finally { release(); }
  assert.equal((await running).state, "prepared");
});
test("a newly selected day is guarded by expected absence, not treated as an overwrite", async t => {
  const f = await fixture(t), inventory = { ...f.inventory, objects: [] };
  const b = JSON.stringify(inventory); await fs.writeFile(f.plan.inventoryFile, b);
  const r = await preparePromotion({ ...f.plan, inventorySha256: sha(b) }, f.out);
  assert.equal(r.manifest.guards[0]!.sha256, null);
  const candidate = JSON.parse(gunzipSync(await fs.readFile(path.join(f.out, r.manifest.days[0]!.file!))).toString());
  assert.equal(quantity(candidate), 24);
  checkGuards(r.manifest.guards, inventory, "NQ");
  assert.throws(() => checkGuards(r.manifest.guards, f.inventory, "NQ"), /changed/);
});
