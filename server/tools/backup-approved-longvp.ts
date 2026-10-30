/** Writes ONLY the approved backup namespace. Does not apply candidates. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LongVpCloud } from "../src/import/longvp-cloud.ts";
import { backupApprovedDays, type SavedObject } from "../src/import/longvp-maintenance.ts";
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--(inventory|out)=(.+)$/.exec(a);
  if (!m || args.has(m[1]!)) throw Error("invalid_backup_argument"); args.set(m[1]!, m[2]!);
}
if (args.size !== 2) throw Error("inventory_out_required");
const root = path.resolve(args.get("out")!);
if (!root.startsWith(path.resolve("data/longvp-maintenance") + path.sep)) throw Error("isolated_output_required");
await fs.mkdir(root, { mode: 0o700 });
const inventory = JSON.parse(await fs.readFile(args.get("inventory")!, "utf8"));
const run = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + "-" + randomUUID().slice(0, 8);
const result = await backupApprovedDays(new LongVpCloud(), inventory.objects as SavedObject[], root, run);
await fs.writeFile(path.join(root, "backup-result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ prefix: result.manifest.prefix, existingFiles: result.existingFiles,
  absentTargets: result.absentTargets, manifestObject: result.manifestObject, sha256: result.sha256 }));
