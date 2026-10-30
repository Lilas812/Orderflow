/** Offline operator entry point. Never imports the app and never starts an upstream connection. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { LongVpCloud } from "../src/import/longvp-cloud.ts";
import { applyApprovedDays, restoreApprovedDays, allowedTarget } from "../src/import/longvp-maintenance.ts";
import type { MaintenanceBackup } from "../src/import/longvp-maintenance.ts";
import { sha } from "../src/import/databento-stage.ts";
import { validateDay } from "../src/long-vp/objects.ts";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--(action|plan|backup|out|stopped-proof)=(.+)$/.exec(a);
  if (!m || args.has(m[1]!)) throw Error("invalid_operator_argument");
  args.set(m[1]!, m[2]!);
}
const action = args.get("action");
if (!["apply", "verify", "restore"].includes(action!)
  || !args.has("backup") || !args.has("out") || !args.has("stopped-proof")
  || (action !== "restore" && (!args.has("plan") || args.size !== 5))
  || (action === "restore" && args.size !== 4))
  throw Error("action_plan_backup_out_stopped_proof_required");
const out = path.resolve(args.get("out")!);
if (!out.startsWith(path.resolve("data/longvp-maintenance") + path.sep)) throw Error("isolated_output_required");
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const proofFile = args.get("stopped-proof")!;
async function requireStoppedProof() {
  const proof = JSON.parse(await fs.readFile(proofFile, "utf8"));
  // An operator/agent must acquire this from the publishing control plane, not Workspace Run.
  // This file is an auditable operational assertion, not a cryptographic proof or a runtime lock.
  const age = Date.now() - Date.parse(proof.checkedAt);
  if (proof.success !== true || proof.isDeployed !== false || !Number.isFinite(age) || age < 0 || age > 20 * 60000)
    throw Error("fresh_public_deployment_stopped_confirmation_required");
}
await requireStoppedProof();
const backupFile = args.get("backup")!, backupHash = await sha(backupFile);
const backup = JSON.parse(await fs.readFile(backupFile, "utf8")) as MaintenanceBackup;
const cloud = new LongVpCloud();
if (action === "restore") {
  // Restoration deliberately does NOT depend on purchased files, candidates, or a surviving plan.
  const restored = await restoreApprovedDays(cloud, backup, out, true);
  for (const r of backup.records) {
    const current = await cloud.stat(r.name);
    if (!r.original) { if (current) throw Error("restored_new_target_not_absent"); continue; }
    if (!current) throw Error("restored_original_missing");
    const file = path.join(out, "restore-readback.gz"); await cloud.download(r.name, current.generation, file);
    if (await sha(file) !== r.original.sha256) throw Error("restored_original_hash_mismatch");
  }
  await fs.writeFile(path.join(out, "restore-result.json"), JSON.stringify({ restored, checked: 42, backupHash }, null, 2));
  console.log(JSON.stringify({ action, checked: 42, restored: restored.length })); process.exit(0);
}
const planFile = args.get("plan")!, planHash = await sha(planFile);
const plan = JSON.parse(await fs.readFile(planFile, "utf8"));
if (plan.kind !== "approved-purchased-longvp-days" || plan.targets?.length !== 42
  || new Set(plan.targets.map((t: { name: string }) => t.name)).size !== 42
  || plan.targets.some((t: { name: string }) => !allowedTarget(t.name))) throw Error("invalid_approved_plan");
if (await sha(plan.reportFile) !== plan.reportHash) throw Error("approved_report_changed");
const approved = JSON.parse(await fs.readFile(plan.reportFile, "utf8"));
for (const t of plan.targets) {
  const r = approved.results.find((r: { symbol: string }) => r.symbol === t.symbol);
  const d = r?.days.find((d: { date: string }) => d.date === t.date);
  if (!d || d.partialPurchasePeriod || d.front.contract !== `${t.symbol}Z26` || d.front.volume !== t.volume
    || t.name !== `prod/longvp/${t.symbol}/days/${t.date}.json.gz`) throw Error("target_not_in_approved_list");
  if (await sha(t.file) !== t.sha256) throw Error("candidate_hash_changed");
  checkDay(await fs.readFile(t.file), t);
}
function checkDay(bytes: Buffer, t: { symbol: "NQ" | "GC"; date: string; volume: number }) {
  const d = validateDay(JSON.parse(gunzipSync(bytes, { maxOutputLength: 4 * 1024 * 1024 }).toString()), t.symbol);
  const vpVolume = d.vp30m.reduce((n, r) => n + r[2] + r[3] + (r[5] ?? 0), 0);
  const barVolume = d.bars1m.reduce((n, r) => n + r[5] + r[6] + (r[8] ?? 0), 0);
  if (d.tradingDate !== t.date || !d.complete || vpVolume !== t.volume || barVolume !== t.volume
    || d.contracts.some(c => ![`${t.symbol}Z6`, `${t.symbol}Z26`].includes(c.contract))) throw Error("approved_day_mismatch");
  return { volume: vpVolume, barVolume, complete: d.complete };
}
if (action === "apply") {
  await applyApprovedDays(cloud, backup, plan.targets, out, { runtimeWriterStopped: true });
}
const verified = [];
for (const t of plan.targets) {
  await requireStoppedProof();
  const m = await cloud.stat(t.name);
  if (!m) throw Error("promoted_target_missing");
  const file = path.join(out, "verify-day.gz"); await cloud.download(t.name, m.generation, file);
  if (await sha(file) !== t.sha256) throw Error("promoted_target_hash_mismatch");
  const totals = checkDay(await fs.readFile(file), t);
  if ((await cloud.stat(t.name))?.generation !== m.generation) throw Error("promoted_target_changed");
  verified.push({ symbol: t.symbol, date: t.date, name: t.name, generation: m.generation, sha256: t.sha256, ...totals });
}
if (await sha(planFile) !== planHash || await sha(backupFile) !== backupHash) throw Error("maintenance_inputs_changed");
await fs.writeFile(path.join(out, "verified.json"), JSON.stringify({
  checkedAt: new Date().toISOString(), action, planHash, backupHash, verified,
}, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ action, verified: verified.length, output: path.join(out, "verified.json") }));
