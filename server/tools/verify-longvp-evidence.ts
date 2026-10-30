/** Offline, read-only reconciliation. No application boot or cloud client. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readPinnedDay, verifyPinned, verifyExistingNqAssignments, verifyRawDay,
  type PinnedFile } from "../src/import/longvp-evidence.ts";
import type { PromotionPlan } from "../src/import/longvp-package.ts";
import type { Inventory } from "../src/import/longvp-promotion.ts";

const keys = ["plan", "manifest", "import", "import-sha256", "out"];
const args = new Map<string, string>();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(arg);
  if (!match || !keys.includes(match[1]!) || args.has(match[1]!)) throw Error("invalid_argument");
  args.set(match[1]!, match[2]!);
}
if (keys.some(k => !args.has(k))) throw Error("required_arguments_missing");
const out = path.resolve(args.get("out")!);
if (!out.startsWith(path.resolve("data/longvp-promotion-evidence") + path.sep)) throw Error("isolated_output_required");
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const importPin = { file: path.resolve(args.get("import")!), sha256: args.get("import-sha256")! };
await verifyPinned(importPin);
const active = JSON.parse(await fs.readFile(importPin.file, "utf8"));
if (active.state !== "verified_isolated" || !Array.isArray(active.outputHashes)) throw Error("verified_import_required");
const pinned = new Map<string, string>(active.outputHashes.map((f: PinnedFile) => [path.resolve(f.file), f.sha256]));
const plan: PromotionPlan = JSON.parse(await fs.readFile(args.get("plan")!, "utf8"));
if (plan.version !== 1 || plan.symbol !== "NQ") throw Error("existing_nq_evidence_only");
const manifestFile = path.resolve(args.get("manifest")!), manifestBytes = await fs.readFile(manifestFile);
const seal = JSON.parse(await fs.readFile(path.join(path.dirname(manifestFile), "seal.json"), "utf8"));
if (seal.sha256 !== hash(manifestBytes)) throw Error("candidate_seal_changed");
const manifest = JSON.parse(manifestBytes.toString());
if (manifest.kind !== "offline-longvp-candidate" || manifest.symbol !== plan.symbol
  || manifest.planHash !== hash(JSON.stringify(plan)) || manifest.inventorySha256 !== plan.inventorySha256)
  throw Error("candidate_plan_identity_mismatch");
const root = path.resolve(path.dirname(manifestFile), "../..");
await verifyPinned({ file: plan.inventoryFile, sha256: plan.inventorySha256 });
const inventory = JSON.parse(await fs.readFile(plan.inventoryFile, "utf8")) as Inventory;
const assignments = await verifyExistingNqAssignments(plan.assignments, inventory);
const results = [];
for (const d of manifest.days.filter((d: { changed: boolean }) => d.changed)) {
  const sourceFiles = [];
  for (const s of plan.sources) {
    if (pinned.get(path.resolve(s.file)) !== s.sha256) throw Error("source_not_in_verified_import");
    const day = await readPinnedDay(s, plan.symbol);
    if (day.tradingDate === d.date) sourceFiles.push({ ...s, day });
  }
  if (sourceFiles.length !== 1) throw Error("one_source_contract_per_day_required");
  const source = sourceFiles[0]!, candidatePath = path.resolve(root, d.file);
  if (!candidatePath.startsWith(root + path.sep)) throw Error("candidate_path_escape");
  const candidate = await readPinnedDay({ file: candidatePath, sha256: d.sha256 }, plan.symbol);
  const old = inventory.objects.find(o => o.name === d.name);
  if ((old?.sha256 ?? null) !== d.expectedSha256) throw Error("candidate_base_identity_mismatch");
  const base = old ? await readPinnedDay(old, plan.symbol) : null;
  const accepted: number[] = d.audits.flatMap((a: { accepted: number[] }) => a.accepted);
  const targetContracts = new Set(accepted.map(b => plan.assignments.find(w =>
    w.sourceContract === source.contract && w.fromSec <= b && b + 1800 <= w.toSec)?.targetContract));
  if (targetContracts.size !== 1 || targetContracts.has(undefined)) throw Error("ambiguous_evidence_assignment");
  const sourceRoot = path.resolve(path.dirname(source.file), "..");
  const coverageFile = path.join(sourceRoot, "coverage.json");
  const coverageHash = pinned.get(coverageFile);
  if (!coverageHash) throw Error("source_coverage_not_pinned");
  const rawFiles = [...pinned].filter(([file]) => file.startsWith(sourceRoot + `/trades/${plan.symbol}/`))
    .filter(([file]) => {
      const m = /(\d{4}-\d\d-\d\d)\/(\d\d)\.jsonl\.gz$/.exec(file);
      const sec = m ? Date.parse(`${m[1]}T${m[2]}:00:00Z`) / 1000 : NaN;
      return sec >= source.day.startSec && sec < source.day.endSec;
    }).map(([file, sha256]) => ({ file, sha256 }));
  results.push(await verifyRawDay({ symbol: plan.symbol, source: source.day, candidate, base,
    sourceContract: source.contract, targetContract: [...targetContracts][0]!,
    accepted, rawFiles, coverage: { file: coverageFile, sha256: coverageHash } }));
}
if (!results.length) throw Error("no_changed_days");
await verifyPinned(importPin);
await verifyPinned({ file: plan.inventoryFile, sha256: plan.inventorySha256 });
if (hash(await fs.readFile(manifestFile)) !== seal.sha256) throw Error("candidate_changed_during_verification");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.mkdir(out, { mode: 0o700 }); // Never overwrite a previous report.
const report = { version: 1, kind: "offline-longvp-raw-evidence", createdAt: new Date().toISOString(),
  inputs: { import: importPin, planSha256: hash(JSON.stringify(plan)), manifestSha256: seal.sha256 },
  assignments, results, productionWriteAuthorized: false,
  blockers: ["Production raw-trade snapshot and production coverage have not been reconciled.",
    "No production CAS writer or shared exclusion with AppLongVp is installed.",
    "GC and new historical dates still require contract activation evidence or explicit selection."] };
await fs.writeFile(path.join(out, "verification.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
