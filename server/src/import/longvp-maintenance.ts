/** Guarded maintenance transactions; never used by the receiver/runtime. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConditionalCloud, CloudVersion } from "./longvp-cloud.ts";
import { verifyPinned } from "./longvp-evidence.ts";
import { sha } from "./databento-stage.ts";
import { datesBetween } from "../long-vp/day.ts";
export interface SavedObject extends CloudVersion { name: string; file: string; sha256: string; }
export interface BackupRecord {
  name: string; original: SavedObject | null;
  backup: { name: string; generation: string; sha256: string } | null;
}
export interface MaintenanceBackup {
  version: 1; kind: "approved-longvp-backup"; run: string; prefix: string;
  capturedAt: string; records: BackupRecord[];
}
export const allowedTarget = (name: string) => {
  const m = /^prod\/longvp\/(NQ|GC)\/days\/(2026-10-\d\d)\.json\.gz$/.exec(name);
  return !!m && datesBetween("2026-10-01", "2026-10-29").includes(m[2]!);
};
function runPrefix(run: string) {
  if (!/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(run)) throw Error("invalid_maintenance_run");
  return `prod/backup/longvp/${run}/`;
}
function validateBackup(backup: MaintenanceBackup) {
  if (backup.kind !== "approved-longvp-backup" || backup.prefix !== runPrefix(backup.run)
    || backup.records.length !== 42 || new Set(backup.records.map(r => r.name)).size !== 42)
    throw Error("invalid_backup_manifest");
  for (const r of backup.records) {
    if (!allowedTarget(r.name)) throw Error("unapproved_restore_target");
    if (r.original) {
      if (r.original.name !== r.name || !r.backup || r.backup.sha256 !== r.original.sha256
        || r.backup.name !== backup.prefix + r.name.slice("prod/longvp/".length)) throw Error("invalid_original_backup");
    } else if (r.backup) throw Error("unexpected_backup_for_absent_target");
  }
}
async function verifiedDownload(cloud: ConditionalCloud, name: string, generation: string, expected: string, file: string) {
  await cloud.download(name, generation, file);
  await verifyPinned({ file, sha256: expected });
}
/** Back up every existing approved target before ANY target replacement. New targets record absence. */
export async function backupApprovedDays(cloud: ConditionalCloud, original: SavedObject[], root: string, run: string) {
  const prefix = runPrefix(run), records: BackupRecord[] = [];
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const known = new Map(original.filter(o => allowedTarget(o.name)).map(o => [o.name, o]));
  if (known.size !== original.filter(o => allowedTarget(o.name)).length) throw Error("duplicate_original_object");
  // Only our own maintenance operations share this lock. Runtime writer exclusion remains REQUIRED.
  const lockName = "prod/backup/longvp/promotion.lock", lockFile = path.join(root, randomUUID() + ".lock.json");
  await fs.writeFile(lockFile, JSON.stringify({ run, purpose: "backup-only" }), { flag: "wx", mode: 0o600 });
  const lockGen = await cloud.put(lockName, lockFile, null);
  try {
    for (const symbol of ["NQ", "GC"]) for (const date of datesBetween("2026-10-01", "2026-10-29")) {
      const name = `prod/longvp/${symbol}/days/${date}.json.gz`, old = known.get(name) ?? null;
      const current = await cloud.stat(name);
      if ((current?.generation ?? null) !== (old?.generation ?? null)) throw Error("production_changed_since_capture");
      if (!old) { records.push({ name, original: null, backup: null }); continue; }
      await verifyPinned(old);
      const backupName = prefix + name.slice("prod/longvp/".length), saved = await cloud.stat(backupName);
      let generation: string;
      if (saved) {
        if (saved.metadata.originalGeneration !== old.generation || saved.metadata.sha256 !== old.sha256)
          throw Error("backup_identity_conflict");
        generation = saved.generation;
      } else generation = await cloud.put(backupName, old.file, null,
        { run, originalName: name, originalGeneration: old.generation, sha256: old.sha256 },
        { contentType: old.contentType, contentEncoding: old.contentEncoding });
      await verifiedDownload(cloud, backupName, generation, old.sha256, path.join(root, `verify-${symbol}-${date}.gz`));
      records.push({ name, original: old, backup: { name: backupName, generation, sha256: old.sha256 } });
    }
    for (const r of records)
      if ((await cloud.stat(r.name))?.generation !== r.original?.generation) throw Error("production_changed_during_backup");
    const manifest: MaintenanceBackup = { version: 1, kind: "approved-longvp-backup", run, prefix,
      capturedAt: new Date().toISOString(), records };
    const file = path.join(root, "backup-manifest.json");
    await fs.writeFile(file, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const remoteManifest = prefix + "manifest.json", before = await cloud.stat(remoteManifest), hash = await sha(file);
    const gen = before?.generation ?? await cloud.put(remoteManifest, file, null, { run, sha256: hash });
    await verifiedDownload(cloud, remoteManifest, gen, hash, path.join(root, "manifest-readback.json"));
    return { manifest, manifestObject: remoteManifest, manifestGeneration: gen, sha256: hash,
      existingFiles: records.filter(r => r.backup).length, absentTargets: records.filter(r => !r.original).length };
  } finally {
    await cloud.remove(lockName, lockGen); await fs.rm(lockFile, { force: true });
  }
}
export interface CandidateWrite { name: string; file: string; sha256: string; }
export interface AppliedObject { name: string; generation: string; sha256: string; }
/** Caller must establish a genuine stopped/quiescent runtime, not just this maintenance lock. */
export async function applyApprovedDays(cloud: ConditionalCloud, backup: MaintenanceBackup,
  candidates: CandidateWrite[], root: string, options: { runtimeWriterStopped: boolean; afterWrite?: () => void } ) {
  if (!options.runtimeWriterStopped) throw Error("runtime_writer_exclusion_required");
  validateBackup(backup);
  if (candidates.length !== 42 || new Set(candidates.map(c => c.name)).size !== 42
    || candidates.some(c => !allowedTarget(c.name)) || backup.records.length !== 42) throw Error("exact_approved_targets_required");
  if (new Set(backup.records.map(r => r.name)).size !== 42 || backup.records.some(r => !allowedTarget(r.name)))
    throw Error("invalid_backup_target_set");
  // Complete preflight, including all originals, before the first target write.
  for (const c of candidates) await verifyPinned(c);
  for (const r of backup.records) {
    if (r.original && (!r.backup || r.backup.sha256 !== r.original.sha256)) throw Error("missing_original_backup");
    if (r.backup) await verifiedDownload(cloud, r.backup.name, r.backup.generation,
      r.backup.sha256, path.join(root, "preflight-backup.gz"));
  }
  const applied: AppliedObject[] = [];
  for (const c of candidates) {
    await verifyPinned(c);
    const original = backup.records.find(r => r.name === c.name);
    if (!original) throw Error("target_missing_from_backup");
    if (original.backup) {
      await verifiedDownload(cloud, original.backup.name, original.backup.generation,
        original.backup.sha256, path.join(root, "verified-original.gz"));
    }
    const current = await cloud.stat(c.name);
    let generation: string;
    if (current?.metadata.run === backup.run && current.metadata.sha256 === c.sha256) generation = current.generation;
    else {
      if ((current?.generation ?? null) !== (original.original?.generation ?? null)) throw Error("target_generation_changed");
      generation = await cloud.put(c.name, c.file, original.original?.generation ?? null,
        { run: backup.run, sha256: c.sha256 }, { contentType: "application/gzip" });
      options.afterWrite?.(); // Test ambiguous interruption AFTER a successful write.
    }
    await verifiedDownload(cloud, c.name, generation, c.sha256, path.join(root, "candidate-readback.gz"));
    if ((await cloud.stat(c.name))?.generation !== generation) throw Error("target_changed_during_verification");
    applied.push({ name: c.name, generation, sha256: c.sha256 });
    await fs.writeFile(path.join(root, "applied.json"), JSON.stringify({ run: backup.run, applied }, null, 2));
  }
  return applied;
}
/** Restore only generations written by this run. Never remove/overwrite somebody else's update. */
export async function restoreApprovedDays(cloud: ConditionalCloud, backup: MaintenanceBackup,
  root: string, runtimeWriterStopped: boolean) {
  if (!runtimeWriterStopped) throw Error("runtime_writer_exclusion_required");
  validateBackup(backup);
  const restored = [];
  for (const r of backup.records) {
    if (!allowedTarget(r.name)) throw Error("unapproved_restore_target");
    const current = await cloud.stat(r.name);
    if ((current?.generation ?? null) === (r.original?.generation ?? null)) continue; // Never applied.
    if (!current && !r.original) continue; // Already removed.
    if (current?.metadata.restoredFromRun === backup.run) {
      if (!r.original) throw Error("unexpected_restored_absent_target");
      await verifiedDownload(cloud, r.name, current.generation, r.original.sha256, path.join(root, "restored-check.gz"));
      continue;
    }
    if (!current || current.metadata.run !== backup.run) throw Error("restore_would_overwrite_concurrent_change");
    if (!/^[a-f0-9]{64}$/.test(current.metadata.sha256 ?? "")) throw Error("restore_candidate_hash_unavailable");
    await verifiedDownload(cloud, r.name, current.generation, current.metadata.sha256!, path.join(root, "restore-current.gz"));
    if (r.backup && r.original) {
      const file = path.join(root, "restore.gz");
      await verifiedDownload(cloud, r.backup.name, r.backup.generation, r.backup.sha256, file);
      const generation = await cloud.put(r.name, file, current.generation, { ...r.original.metadata,
        restoredFromRun: backup.run }, { contentType: r.original.contentType, contentEncoding: r.original.contentEncoding });
      await verifiedDownload(cloud, r.name, generation, r.original.sha256, path.join(root, "restored-check.gz"));
      restored.push({ name: r.name, state: "restored", generation });
    } else { await cloud.remove(r.name, current.generation); restored.push({ name: r.name, state: "removed_new_target" }); }
  }
  return restored;
}
