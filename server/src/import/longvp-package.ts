/** Local preparation only. Deliberately has no upload/apply implementation. */
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";
import type { DayData } from "../long-vp/day.ts";
import type { Objects } from "../store/objects.ts";
import { checkedDay, checkGuards, dayObject, fillDay, validateAssignments, validateInventory,
  type Assignment, type FillAudit, type Guard, type Inventory } from "./longvp-promotion.ts";

// Same decoded JSON ceiling as the existing LONG VP reader's 32MiB / 8 budget.
const LIMIT = 32 * 1024 * 1024 / 8;
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export interface SourceFile { file: string; sha256: string; contract: string; }
export interface PromotionPlan {
  version: 1; symbol: MarketSymbol; builtAtUs: number; inventoryFile: string;
  inventorySha256: string; sources: SourceFile[]; assignments: Assignment[];
}
interface Candidate {
  date: string; name: string; changed: boolean; expectedSha256: string | null;
  file: string | null; sha256: string | null; audits: FillAudit[];
}
interface PackageManifest {
  version: 1; kind: "offline-longvp-candidate"; planHash: string; symbol: MarketSymbol;
  inventorySha256: string; inventoryCapturedAt: string; days: Candidate[]; guards: Guard[];
  files: { file: string; sha256: string }[];
  warning: string;
}
async function bytes(file: string): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > LIMIT) throw Error("input_exceeds_existing_day_budget");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
async function verified(file: string, expected: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw Error("invalid_expected_hash");
  const b = await bytes(file);
  if (hash(b) !== expected) throw Error(`input_hash_changed:${file}`);
  return b;
}
function decode(b: Buffer): unknown {
  return JSON.parse((b[0] === 31 && b[1] === 139 ? gunzipSync(b, { maxOutputLength: LIMIT }) : b).toString("utf8"));
}
async function atomic(file: string, value: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  await fs.rename(temp, file);
}
async function directory(root: string, relative: string) {
  let dir = root;
  for (const component of relative.split("/")) {
    if (!component || component === "." || component === "..") throw Error("invalid_output_component");
    dir = path.join(dir, component);
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("output_symlink_escape");
  }
  return dir;
}
async function ownedRoot(out: string) {
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(out), marker = path.join(root, "offline-candidate-owner.json");
  const names = await fs.readdir(root);
  if (!names.length) await fs.writeFile(marker, '{"kind":"offline-longvp-candidate","version":1}', { flag: "wx", mode: 0o600 });
  const owner = JSON.parse(await fs.readFile(marker, "utf8"));
  if (owner.kind !== "offline-longvp-candidate" || owner.version !== 1) throw Error("unowned_output_directory");
  return root;
}
async function outside(root: string, file: string) {
  const real = await fs.realpath(file);
  if (real === root || real.startsWith(root + path.sep)) throw Error("input_inside_output");
}
async function lock(root: string) {
  const file = path.join(root, "prepare.lock");
  try {
    const pid = Number(await fs.readFile(file, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("invalid_lock");
    try { process.kill(pid, 0); throw Error("preparation_running"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    await fs.rename(file, file + ".stale-" + randomUUID());
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await fs.writeFile(file, String(process.pid), { flag: "wx", mode: 0o600 });
  return () => fs.unlink(file);
}
export async function preparePromotion(plan: PromotionPlan, out: string,
  options: { signal?: AbortSignal; afterStage?: () => Promise<void> | void;
    afterRename?: () => Promise<void> | void } = {}) {
  if (plan.version !== 1 || !["NQ", "GC"].includes(plan.symbol) || !Number.isSafeInteger(plan.builtAtUs)
    || !Array.isArray(plan.sources) || !Array.isArray(plan.assignments)) throw Error("invalid_promotion_plan");
  validateAssignments(plan.assignments, plan.symbol);
  const inventoryBytes = await verified(plan.inventoryFile, plan.inventorySha256);
  const inventory = validateInventory(JSON.parse(inventoryBytes.toString()) as Inventory, plan.symbol);
  const root = await ownedRoot(path.resolve(out));
  for (const file of [plan.inventoryFile, ...plan.sources.map(s => s.file), ...inventory.objects.map(o => o.file)])
    await outside(root, file);
  const unlock = await lock(root);
  const check = () => options.signal?.throwIfAborted();
  try {
    const planHash = hash(JSON.stringify(plan));
    const genParent = await directory(root, "generations"), generation = path.join(genParent, planHash);
    const byDate = new Map<string, SourceFile[]>(), identities = new Set<string>();
    // One bounded day at a time; never retain a month of parsed prices/trades.
    for (const source of plan.sources) {
      check();
      const d = checkedDay(decode(await verified(source.file, source.sha256)), plan.symbol);
      if (!d.contracts.length || d.contracts.some(c => c.contract !== source.contract)) throw Error("mixed_or_wrong_source_contract");
      const id = `${d.tradingDate}:${source.contract}`;
      if (identities.has(id)) throw Error("duplicate_source_day_contract");
      identities.add(id);
      const list = byDate.get(d.tradingDate) ?? []; list.push(source); byDate.set(d.tradingDate, list);
    }
    for (const o of inventory.objects) await verified(o.file, o.sha256);
    let existing = false;
    try { await fs.stat(generation); existing = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (existing) {
      const sealed = JSON.parse(await fs.readFile(path.join(generation, "seal.json"), "utf8"));
      const old = JSON.parse((await verified(path.join(generation, "manifest.json"), sealed.sha256)).toString()) as PackageManifest;
      if (old.planHash !== planHash || old.kind !== "offline-longvp-candidate") throw Error("candidate_manifest_mismatch");
      for (const f of old.files) {
        const file = path.resolve(root, f.file);
        if (!file.startsWith(root + path.sep)) throw Error("candidate_path_escape");
        await verified(file, f.sha256);
      }
      check();
      await atomic(path.join(root, "active.json"), { version: 1, planHash, generation, state: "offline_candidate" });
      return { state: "already_prepared", generation, manifest: old };
    }
    const stage = await directory(root, `.staging/${planHash}`);
    const backups = await directory(root, "backups");
    const files: PackageManifest["files"] = [];
    const register = (file: string, sha256: string) => files.push({ file: path.relative(root, file), sha256 });
    for (const o of inventory.objects) {
      const b = await verified(o.file, o.sha256), backup = path.join(backups, o.sha256 + ".json.gz");
      try { await fs.writeFile(backup, b, { flag: "wx", mode: 0o600 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      await verified(backup, o.sha256); register(backup, o.sha256);
    }
    const dates = new Set([...byDate.keys(), ...inventory.objects.map(o => o.name.slice(-18, -8))]);
    const manifest: PackageManifest = { version: 1, kind: "offline-longvp-candidate", planHash,
      symbol: plan.symbol, inventorySha256: plan.inventorySha256,
      inventoryCapturedAt: inventory.capturedAt, days: [], guards: [], files,
      warning: "LOCAL CANDIDATE ONLY. No upload/apply. Snapshot recheck is not atomic cloud CAS. Contract evidence requires operator review." };
    for (const date of [...dates].sort()) {
      check();
      const name = dayObject(plan.symbol, date), old = inventory.objects.find(o => o.name === name);
      let day: DayData | null = old ? checkedDay(decode(await verified(old.file, old.sha256)), plan.symbol) : null;
      if (day && day.tradingDate !== date) throw Error("snapshot_payload_date_mismatch");
      const audits: FillAudit[] = [];
      for (const source of byDate.get(date) ?? []) {
        const input = checkedDay(decode(await verified(source.file, source.sha256)), plan.symbol);
        const filled = fillDay(day, input, plan.assignments, plan.symbol, plan.builtAtUs);
        if (filled.audit.accepted.length) day = filled.day;
        audits.push(filled.audit);
      }
      const changed = audits.some(a => a.accepted.length > 0);
      if (!changed) {
        manifest.days.push({ date, name, changed, expectedSha256: old?.sha256 ?? null,
          file: null, sha256: null, audits }); continue;
      }
      const b = gzipSync(JSON.stringify(day)), target = path.join(stage, date + ".json.gz");
      await fs.writeFile(target, b, { mode: 0o600 });
      const reread = checkedDay(decode(await verified(target, hash(b))), plan.symbol);
      if (JSON.stringify(reread) !== JSON.stringify(day)) throw Error("candidate_readback_mismatch");
      const final = path.join(generation, date + ".json.gz");
      register(final, hash(b));
      manifest.days.push({ date, name, changed, expectedSha256: old?.sha256 ?? null,
        file: path.relative(root, final), sha256: hash(b), audits });
      manifest.guards.push({ name, sha256: old?.sha256 ?? null });
    }
    // Pin source/production snapshot bytes again before the local commit.
    for (const o of inventory.objects) await verified(o.file, o.sha256);
    for (const s of plan.sources) await verified(s.file, s.sha256);
    await verified(plan.inventoryFile, plan.inventorySha256);
    check();
    await atomic(path.join(stage, "manifest.json"), manifest);
    await atomic(path.join(stage, "seal.json"), { sha256: hash(await bytes(path.join(stage, "manifest.json"))) });
    await options.afterStage?.(); check();
    await fs.rename(stage, generation);
    await options.afterRename?.(); check();
    await atomic(path.join(root, "active.json"), { version: 1, planHash, generation, state: "offline_candidate" });
    return { state: manifest.guards.length ? "prepared" : "no_changes", generation, manifest };
  } finally { await unlock(); }
}
export async function recheckPromotion(manifest: PackageManifest, inventoryFile: string) {
  if (manifest.kind !== "offline-longvp-candidate" || !["NQ", "GC"].includes(manifest.symbol)
    || !Array.isArray(manifest.guards)) throw Error("invalid_candidate_manifest");
  const inventory = JSON.parse((await bytes(inventoryFile)).toString()) as Inventory;
  if (!(Date.parse(inventory.capturedAt) > Date.parse(manifest.inventoryCapturedAt))) throw Error("newer_snapshot_required");
  checkGuards(manifest.guards, inventory, manifest.symbol);
  for (const o of inventory.objects) await verified(o.file, o.sha256);
  return { state: manifest.guards.length ? "snapshot_matches" : "no_changes",
    atomicCloudWriteVerified: false, targets: manifest.guards.length, capturedAt: inventory.capturedAt };
}
/** Reader accepts ONLY list/download capabilities. Two passes detect observed races; not an atomic snapshot. */
export async function captureInventory(reader: Pick<Objects, "list" | "download">,
  symbol: MarketSymbol, out: string) {
  if (symbol !== "NQ" && symbol !== "GC") throw Error("invalid_snapshot_symbol");
  const root = path.resolve(out);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root, { mode: 0o700 }); // Never overwrite an existing directory or symlink.
  const prefix = `prod/longvp/${symbol}/days/`, names = (await reader.list(prefix)).sort();
  const inventory: Inventory = { version: 1, symbol, capturedAt: "", objects: [] };
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^\d{4}-\d\d-\d\d\.json\.gz$/.test(name.slice(prefix.length)))
      throw Error("unexpected_object_name");
    const file = path.join(root, path.basename(name));
    await reader.download(name, file);
    const b = await bytes(file);
    if (dayObject(symbol, checkedDay(decode(b), symbol).tradingDate) !== name) throw Error("snapshot_payload_date_mismatch");
    inventory.objects.push({ name, file, sha256: hash(b) });
  }
  if (JSON.stringify((await reader.list(prefix)).sort()) !== JSON.stringify(names)) throw Error("snapshot_inventory_changed");
  for (const o of inventory.objects) {
    const check = o.file + ".check";
    await reader.download(o.name, check);
    if (hash(await bytes(check)) !== o.sha256) throw Error("snapshot_object_changed");
    await fs.unlink(check); // This invocation's own comparison file only.
  }
  inventory.capturedAt = new Date().toISOString();
  validateInventory(inventory, symbol);
  const file = path.join(root, "inventory.json");
  await fs.writeFile(file, JSON.stringify(inventory, null, 2), { flag: "wx", mode: 0o600 });
  return { file, sha256: hash(await bytes(file)), objects: names.length,
    reads: { list: 2, download: names.length * 2 }, atomicSnapshot: false };
}
