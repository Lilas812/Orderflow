import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Coverage } from "./local.ts";
import { compactTickGaps, durableHours } from "./coverage.ts";
import { uploadVerified } from "./objects.ts";
import type { Objects } from "./objects.ts";

export interface CompactionStatus {
  state: "pending" | "already_applied" | "applied" | "backup_failed" | "index_update_failed";
  backups: string[];
  before?: { local: number; cloud: number };
  after?: { local: number; cloud: number };
}
/** Originals are retained byte-for-byte and verified BEFORE either replacement.
 * Only coverage is changed; no market-data object or file is touched. */
export async function compactStartupCoverage(options: {
  objects: Objects; prefix: string; symbol: string; root: string; now: number;
  cloud: Coverage; working: Coverage; cloudFile?: string; workingFile?: string;
}): Promise<{ cloud: Coverage; working: Coverage; status: CompactionStatus }> {
  const o = options, backups: string[] = [];
  const localNeeded = o.working.tickGapCompactionVersion !== 1;
  const cloudNeeded = o.cloud.tickGapCompactionVersion !== 1;
  if (!localNeeded && !cloudNeeded)
    return { cloud: o.cloud, working: o.working, status: { state: "already_applied", backups } };
  const before = { local: o.working.tick.length, cloud: o.cloud.tick.length };
  const base = `${o.prefix.split("/")[0]}/backup/coverage/${new Date(o.now).toISOString().replaceAll(":", "-")}-${randomUUID()}/${o.symbol}/`;
  let stage: "backup_failed" | "index_update_failed" = "backup_failed";
  const staged = path.join(o.root, `.coverage-compaction-${randomUUID()}`);
  try {
    for (const [kind, file] of [["cloud", o.cloudFile], ["local", o.workingFile]] as const) {
      if (!file) continue;
      const name = base + kind + "/coverage.json";
      await uploadVerified(o.objects, name, file);
      backups.push(name);
    }
    const cloud = cloudNeeded ? await compactTickGaps(o.cloud, (await durableHours(o.cloud)).tick) : o.cloud;
    const working = localNeeded ? await compactTickGaps(o.working) : o.working;
    stage = "index_update_failed";
    if (cloudNeeded && o.cloudFile) {
      await fs.writeFile(staged, JSON.stringify(cloud), { mode: 0o600 });
      await uploadVerified(o.objects, o.prefix + "coverage.json", staged);
    }
    return { cloud, working, status: { state: "applied", backups, before,
      after: { local: working.tick.length, cloud: cloud.tick.length } } };
  } catch {
    return { cloud: o.cloud, working: o.working, status: { state: stage, backups, before } };
  } finally { await fs.rm(staged, { force: true }); }
}
