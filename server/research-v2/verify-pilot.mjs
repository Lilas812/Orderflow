// Private-output verification only. No network, receiver, browser, credentials or real-time source.
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import path from "node:path";
const base = path.resolve("data/research-v2");
const config = JSON.parse(await fs.readFile("server/research-v2/pilot.json", "utf8"));
const owned = [];
async function run(file, dir) {
  const child = spawn(process.execPath, ["--max-old-space-size=256", "server/src/research-v2/cli.ts", "--config", file, "--out", dir],
    { stdio: ["ignore", "pipe", "pipe"] });
  owned.push(child.pid);
  let text = ""; child.stdout.on("data", b => text += b); child.stderr.on("data", b => text += b);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code !== 0) throw Error(text);
  return JSON.parse(text.trim());
}
const first = JSON.parse(await fs.readFile(path.join(base, "pilot-event-01/dataset/manifest.json"), "utf8"));
const repeat = await run("server/research-v2/pilot.json", path.join(base, "pilot-event-02"));
if (first.content_hash !== repeat.contentHash) throw Error("repeat_normalized_hash_mismatch");
execFileSync("unzip", ["-t", path.join(base, "pilot-event-01/dataset/dataset-v2.zip")]);
execFileSync("unzip", ["-t", path.join(base, "pilot-event-02/dataset/dataset-v2.zip")]);
const strictFile = path.join(base, "strict-config.json");
config.calculation.mode = "arrival_verified";
for (const s of config.sources) s.annotationIds = [];
await fs.writeFile(strictFile, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
const strict = await run(strictFile, path.join(base, "pilot-strict-01"));
if (strict.arrivalVerifiedSamples !== 0 || strict.completeTargets !== 0) throw Error("legacy_data_was_promoted_to_strict");
const cancelDir = path.join(base, "pilot-cancel-01");
await fs.mkdir(cancelDir, { mode: 0o700 });
await fs.writeFile(path.join(cancelDir, "other-job-sentinel"), "do not remove", { mode: 0o600 });
const child = spawn(process.execPath, ["--max-old-space-size=256", "server/src/research-v2/cli.ts",
  "--config", "server/research-v2/pilot.json", "--out", cancelDir], { stdio: ["ignore", "pipe", "pipe"] });
owned.push(child.pid);
let logs = ""; child.stderr.on("data", b => logs += b); child.stdout.resume();
const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
let observed = false;
for (let i = 0; i < 200; i++) {
  if ((await fs.readdir(cancelDir)).some(s => s.startsWith(".v2-working-"))) { observed = true; break; }
  await new Promise(r => setTimeout(r, 10));
}
child.kill("SIGTERM");
const cancelCode = await closed;
if (!observed || cancelCode === 0) throw Error("cancellation_did_not_reach_active_job");
const remaining = await fs.readdir(cancelDir);
if (remaining.join() !== "other-job-sentinel") throw Error("cancel_cleanup_ownership_failed");
if (await fs.readFile(path.join(cancelDir, remaining[0]), "utf8") !== "do not remove") throw Error("sentinel_changed");
const states = owned.map(pid => { try { process.kill(pid, 0); return { pid, remaining: true }; }
  catch (e) { if (e.code !== "ESRCH") throw e; return { pid, remaining: false }; } });
if (states.some(s => s.remaining)) throw Error("own_cli_remaining");
const result = { repeat, strict, cancellation: { observedActiveJob: observed, pid: child.pid, code: cancelCode,
  message: logs.trim(), remainingOnlyOtherJobSentinel: true }, ownedProcesses: states };
await fs.writeFile(path.join(base, "pilot-verification.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
