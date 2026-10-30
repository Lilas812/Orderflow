/** Offline only. Never imports index.ts, SDK clients or an upstream connection. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha, atomic, stageFile, type StagedFile } from "../src/import/databento-stage.ts";
import { snapshot, install } from "../src/import/databento-install.ts";
import { rebuild } from "../src/import/databento-rebuild.ts";
import { timestamp } from "../src/import/databento-csv.ts";

const arg = (n: string) => process.argv.find(s => s.startsWith(`--${n}=`))?.slice(n.length + 3);
const zip = path.resolve(arg("zip") ?? ""), out = path.resolve(arg("out") ?? ""), base = path.resolve(arg("base") ?? "data");
if (!arg("zip") || !arg("out") || !out.startsWith(path.resolve("data") + "/") || out === base
  || base.startsWith(out + "/")) throw Error("--zip and --out=data/<isolated-directory> required");
await fs.mkdir(out, { recursive: true });
const lock = path.join(out, "import.lock");
try {
  const pid = Number(await fs.readFile(lock, "utf8"));
  try { process.kill(pid, 0); throw Error("import_already_running"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  await fs.rename(lock, lock + ".stale-" + randomUUID());
} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
await fs.writeFile(lock, String(process.pid), { flag: "wx" });
const control = new AbortController();
process.once("SIGTERM", () => control.abort()); process.once("SIGINT", () => control.abort());
try {
  const archiveSha256 = await sha(zip);
  const raw = execFileSync("unzip", ["-p", zip, "metadata.json"], { encoding: "utf8" });
  const metadata = JSON.parse(raw);
  const manifest = JSON.parse(execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" }));
  const condition = JSON.parse(execFileSync("unzip", ["-p", zip, "condition.json"], { encoding: "utf8" })) as { date: string; condition: string }[];
  if (metadata.query.schema !== "trades" || metadata.query.dataset !== "GLBX.MDP3"
    || !metadata.customizations.pretty_px || !metadata.customizations.pretty_ts) throw Error("unsupported_metadata");
  // JSON.parse would round nanoseconds: derive interval from the ORIGINAL decimal tokens.
  const queryStart = Number(BigInt(/"start":\s*(\d+)/.exec(raw)![1]!) / 1000n);
  const queryEnd = Number(BigInt(/"end":\s*(\d+)/.exec(raw)![1]!) / 1000n);
  const fromUs = arg("from") ? timestamp(arg("from")!).us : queryStart;
  const toUs = arg("to") ? timestamp(arg("to")!).us : queryEnd;
  if (![fromUs, toUs].every(Number.isSafeInteger) || fromUs < queryStart || toUs > queryEnd || fromUs >= toUs) throw Error("invalid_interval");
  const activeFile = path.join(out, "active.json");
  let old: Record<string, any> | null = null;
  try { old = JSON.parse(await fs.readFile(activeFile, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (old?.archiveSha256 === archiveSha256 && old.fromUs === fromUs && old.toUs === toUs) {
    for (const f of old.outputHashes) if (await sha(f.file) !== f.sha256) throw Error("committed_output_changed");
    console.log(JSON.stringify({ state: "already_imported", archiveSha256, fromUs, toUs, generation: old.generation }));
  } else {
    const original = path.join(out, "original-metadata");
    await fs.mkdir(original, { recursive: true });
    for (const name of ["metadata.json", "condition.json", "manifest.json"]) {
      const bytes = execFileSync("unzip", ["-p", zip, name]);
      const m = manifest.files.find((f: { filename: string }) => f.filename === name);
      await fs.writeFile(path.join(original, name), bytes);
      if (m && "sha256:" + await sha(path.join(original, name)) !== m.hash) throw Error("metadata_hash_mismatch");
    }
    const baseline = path.join(out, "baseline");
    try { await fs.access(path.join(baseline, "snapshot.json")); }
    catch { await snapshot(base, baseline); }
    const stage = path.join(out, "verified-v1", archiveSha256), staged: StagedFile[] = [];
    const members = manifest.files.filter((f: { filename: string }) => f.filename.endsWith(".csv.zst"))
      .sort((a: { filename: string }, b: { filename: string }) => a.filename.localeCompare(b.filename));
    let ordinal = 0;
    for (const member of members) {
      const date = /(\d{8})\.trades/.exec(member.filename)![1]!;
      const start = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00Z`) * 1000;
      // Adjacent capture day may contain a few out-of-order event timestamps.
      ordinal++;
      if (start + 86400e6 < fromUs || start > toUs) continue;
      const item = await stageFile(zip, stage, member.filename, member.hash, ordinal, control.signal);
      staged.push(item);
      console.log(JSON.stringify({ state: "verified_source", member: item.member, rows: item.rows,
        contracts: Object.keys(item.contracts), errors: item.errors, spreads: item.spreads }));
      if (Number(arg("interrupt-after") ?? 0) === staged.length) throw Error("injected_interruption_after_verified_file");
    }
    const generation = arg("resume-generation") ? path.resolve(arg("resume-generation")!)
      : path.join(out, "generations", randomUUID());
    if (!generation.startsWith(path.join(out, "generations") + path.sep)) throw Error("resume_must_be_isolated_generation");
    const installed = await install(staged, stage, generation, baseline, fromUs, toUs,
      new Set(condition.filter(c => c.condition === "available").map(c => c.date)), control.signal, !!arg("resume-generation"));
    const rebuilt: Record<string, unknown> = {}, outputHashes: { file: string; sha256: string }[] = [];
    for (const contract of Object.keys(installed)) {
      const root = path.join(generation, contract);
      const hours = (installed[contract] as { hours: { blocked?: string | null; unknownSide?: boolean; fromUs: number; toUs: number }[] }).hours;
      const certified = hours.filter(h => !h.blocked && !h.unknownSide && Number.isFinite(h.fromUs))
        .map(h => [h.fromUs / 1e6, h.toUs / 1e6] as [number, number]);
      rebuilt[contract] = await rebuild(root, contract, control.signal, certified);
      for (const name of await fs.readdir(root, { recursive: true })) if (/\.(?:gz|json|bin)$/.test(name)) {
        const file = path.join(root, name); if ((await fs.stat(file)).isFile()) outputHashes.push({ file, sha256: await sha(file) });
      }
    }
    const record = { version: 1, archiveSha256, original: zip, fromUs, toUs, generation, stage,
      staged, installed, rebuilt, outputHashes, state: "verified_isolated", committedAt: new Date().toISOString(),
      note: "Unclassified sides and spreads remain in verified source quarantine; original stores untouched." };
    await atomic(path.join(generation, "import.json"), record);
    control.signal.throwIfAborted();
    if (arg("fail-before-commit") === "1") throw Error("injected_before_active_pointer");
    await atomic(activeFile, record);
    console.log(JSON.stringify({ state: record.state, archiveSha256, fromUs, toUs, generation, contracts: Object.keys(installed) }));
  }
} finally { await fs.rm(lock, { force: true }); }
