import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { LIMITS, writer, usage, sha, stats, exitCode, signalTarget } from "./contracts.mjs";
import { group, identity, ownershipEvidence, cleanupOwnership } from "../../web/src/diagnostics/load29-browser/process.mjs";
const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const require = createRequire(import.meta.url);
const delay = ms => new Promise(r => setTimeout(r, ms));
export function environment(libraryPath) {
  const env = {};
  for (const key of ["PATH", "HOME", "LANG", "XAUTHORITY", "XDG_RUNTIME_DIR", "NIX_LD", "NIX_LD_LIBRARY_PATH"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, DISPLAY: ":0", LD_LIBRARY_PATH: libraryPath };
}
export async function compile(directory) {
  const renderer = path.join(directory, "build"), verifier = path.join(directory, "verifier");
  await build({ configFile: false, root: path.join(root, "apps/desktop/diagnostics"), base: "./",
    plugins: [react()], resolve: { dedupe: ["react", "react-dom"],
      alias: { "react-dom/client": path.join(root, "apps/desktop/node_modules/react-dom/profiling.js") } },
    build: { outDir: renderer, emptyOutDir: false, minify: false } });
  await build({ configFile: false, ssr: { noExternal: ["@workspace/core"] },
    build: { ssr: path.join(root, "apps/desktop/diagnostics/verify.ts"), outDir: verifier,
      emptyOutDir: false, rollupOptions: { output: { entryFileNames: "verify.mjs" } } } });
  return { renderer, verify: await import(pathToFileURL(path.join(verifier, "verify.mjs"))) };
}
function decode(wire) {
  assert.equal(wire.codec, "gzip/base64");
  const bytes = gunzipSync(Buffer.from(wire.data, "base64"), { maxOutputLength: LIMITS.file });
  assert.equal(bytes.length, wire.bytes); assert.equal(sha(bytes), wire.sha256);
  return JSON.parse(bytes.toString());
}
export async function stageRun(stage, definition, reference, directory, compiled, deadline, env, probe = false) {
  const folder = path.join(directory, `stage${stage}`);
  fs.mkdirSync(folder, { mode: 0o700 }); const save = writer(folder, directory);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `orderflow-a2-${stage}-`));
  const profileStat = fs.lstatSync(profile), began = performance.now();
  save("plan.json", { stage, inputSha256: definition.inputSha256, reference,
    budget: LIMITS, cadenceMs: 300, notificationMs: 250, defaultNativeSize: [1440, 960],
    dpr: 1, initialCanvas: "actual chart-area CSS width measured before inputs", stageRetries: 0 });
  const child = spawn(require("electron"), [path.join(root, "apps/desktop/diagnostics/native.cjs"),
    ...(probe ? [probe === "empty" ? "--empty-layout" : "--layout-probe"] : []),
    `--stage=${stage}`, `--output=${folder}`, `--build=${compiled.renderer}`,
    `--input=${path.join(root, `.local/diagnostics/task29-a/stage${stage}-input.json`)}`,
    `--user-data-dir=${profile}`, "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let started, fault, monitor, wall, exitTimer, exit, stderr = "", known = [], stopSent = false;
  const samples = [], lifecycle = [];
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const stop = error => {
    fault ??= String(error);
    clearInterval(monitor);
    // Only the held leader, with an independently re-read complete identity.
    // Never signal an unknown process/group. No SIGKILL path.
    if (started && !exited() && !stopSent) {
      try {
        const current = identity(child.pid);
        signalTarget(started, current, !exited());
        stopSent = true; child.kill("SIGTERM"); lifecycle.push({ kind: "owned-leader-SIGTERM", at: performance.now() });
      } catch (e) { lifecycle.push({ kind: "signal-refused", reason: String(e) }); }
    }
  };
  for (const stream of [child.stdout, child.stderr]) stream.on("data", b => {
    if (Buffer.byteLength(stderr) + b.length > 65536) stop("STDERR_CAP");
    else {
      stderr += b.toString();
      if (stderr.includes("\nA2_CLEANUP\n")) {
        clearInterval(monitor);
        if (!lifecycle.some(x => x.kind === "graceful-cleanup")) lifecycle.push({ kind: "graceful-cleanup", at: performance.now() });
      }
    }
  });
  try {
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    started = identity(child.pid);
    assert(started.ppid === process.pid && started.pgid === child.pid && started.sid === child.pid, "OWN_GROUP");
    const sample = () => {
      if (exited()) return;
      const g = group(child.pid), evidence = ownershipEvidence(started, g, "RUNNING", performance.now());
      assert.equal(evidence.status, "PASS", `OWNERSHIP:${evidence.reason}`);
      known = g.processes;
      const live = g.processes.filter(p => !["Z", "X"].includes(p.state));
      const rss = live.reduce((n, p) => n + p.rss, 0);
      assert(live.length <= LIMITS.processes && live.every(p => Number.isFinite(p.rss)) && rss <= LIMITS.rss, "RESOURCE_CAP");
      samples.push({ at: performance.now(), rss, processes: live.length,
        cpu: live.map(p => ({ pid: p.pid, startTicks: p.startTicks, ticks: p.userTicks + p.systemTicks })) });
      assert(samples.length <= 4200, "SAMPLE_CAP");
    };
    sample();
    monitor = setInterval(() => { try { sample(); } catch (e) { stop(e); } }, 100);
    const ms = Math.min(LIMITS.wall[stage], deadline - performance.now());
    assert(ms > 0, "TOTAL_WALL");
    wall = setTimeout(() => stop("WALL_TIMEOUT"), ms);
    exit = await Promise.race([
      new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal }))),
      new Promise(resolve => { exitTimer = setTimeout(() => {
        stop("EXIT_TIMEOUT"); resolve({ code: null, signal: null });
      }, ms + 10000); }),
    ]);
  } catch (e) { stop(e); exit = { code: child.exitCode, signal: child.signalCode }; }
  finally { clearInterval(monitor); clearTimeout(wall); clearTimeout(exitTimer); }
  for (let i = 0; i < 100 && group(child.pid).processes.length; i++) await delay(50);
  const residual = group(child.pid);
  const verdict = started ? cleanupOwnership(started, residual, known, exited()) : { status: "FAIL" };
  let profileRemoved = false;
  if (!residual.processes.length && exited()) {
    const s = fs.lstatSync(profile);
    assert(s.ino === profileStat.ino && s.dev === profileStat.dev && s.uid === process.getuid() &&
      !s.isSymbolicLink() && fs.realpathSync(profile) === profile, "PROFILE_IDENTITY");
    fs.rmSync(profile, { recursive: true }); profileRemoved = true;
  }
  let result = { stage, status: "FAIL", fault, exit, started, cleanup: { remaining: residual.processes.length,
    verdict, profileRemoved, forcedTermination: false, stopSent }, samples, lifecycle,
    wallMs: performance.now() - began, stderr, cpuClockHz: Number(execFileSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8" })) };
  if (fs.existsSync(path.join(folder, "native-result.json"))) result.native = JSON.parse(fs.readFileSync(path.join(folder, "native-result.json")));
  try {
    assert(!fault && exit.code === 0 && !exit.signal && profileRemoved && samples.length, "NATIVE_EXIT_OR_RESOURCE");
    assert.equal(result.native.status, "PASS", result.native.error);
    const records = [];
    for (const receipt of result.native.blocks) {
      const raw = fs.readFileSync(path.join(folder, receipt.file));
      assert.equal(sha(raw), receipt.sha256, "RECEIPT_SHA");
      records.push(...decode(JSON.parse(raw.toString())));
    }
    assert.equal(records.length, result.native.recordCount, "LOSSLESS_RECORD_COUNT");
    if (!probe) result.correctness = compiled.verify.verifyFrames(definition, reference, records,
      result.native.observer, result.native.expected.width, result.native.finalUi, result.native.formalInterval);
    if (!probe && stage === 2) assert(result.correctness.checks.some(c => c.quality === "GAP") &&
      result.correctness.checks.some(c => c.quality === "RESYNCING") &&
      result.correctness.checks.at(-1).quality === "VALID", "GAP_RECOVERY");
    assert(performance.now() <= deadline && performance.now() - began <= LIMITS.wall[stage], "VERIFICATION_WALL");
    result.rss = stats(samples.map(s => s.rss));
    result.status = "PASS";
  } catch (e) { result.status = "FAIL"; result.error = String(e); }
  save("result.json", result);
  if (!exited()) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
  return result;
}
export async function main(args) {
  assert(args.length === 1 && ["--run", "--probe", "--empty-layout"].includes(args[0]), "EXPLICIT_RUN_REQUIRED");
  const probe = args[0] !== "--run", empty = args[0] === "--empty-layout";
  const directory = path.join(root, `.local/diagnostics/task30-a4/${empty ? "empty-layout" : probe ? "layout-probe" : "formal"}`);
  fs.mkdirSync(directory, { mode: 0o700 }); // Exclusive, never adopts a previous trial.
  const save = writer(directory), summary = { status: "FAIL", stages: [], GateB2B: "HOLD" };
  try {
    const baseline = JSON.parse(fs.readFileSync(path.join(root, ".local/diagnostics/task30-a4/baseline.json")));
    const frozenInputs = JSON.parse(fs.readFileSync(path.join(root, ".local/diagnostics/task30-a3/baseline.json"))).inputs;
    for (const row of [...baseline.evidence, ...frozenInputs])
      assert.equal(sha(fs.readFileSync(row.path)), row.sha256, row.path);
    const allowed = new Set([
      "apps/desktop/diagnostics/index.html", "apps/desktop/diagnostics/native.cjs",
      "apps/desktop/diagnostics/run.mjs", "apps/desktop/tests/diagnostics.test.ts",
      "apps/web/src/diagnostics/load29-browser/entry.tsx",
      "apps/desktop/diagnostics/layout.mjs",
      "apps/web/src/diagnostics/load29-browser/emptyLayout.ts",
      "apps/web/src/diagnostics/load29-browser/publicationPump.ts",
      "apps/web/src/diagnostics/load29-browser/observer.mjs",
      "apps/web/src/diagnostics/load29-browser/observer.test.ts",
      "apps/desktop/diagnostics/verify.ts", "apps/desktop/diagnostics/bootstrap.mjs",
      "apps/desktop/tests/publication.test.ts",
    ]);
    for (const row of baseline.tracked) if (!allowed.has(row.path))
      assert.equal(sha(fs.readFileSync(row.path)), row.sha256, `PROTECTED_SOURCE:${row.path}`);
    const sources = [...allowed, ...fs.readdirSync(path.join(root, "apps/desktop/diagnostics")).map(n =>
      `apps/desktop/diagnostics/${n}`), "apps/desktop/tests/diagnostics.test.ts"]
      .map(p => ({ path: p, sha256: sha(fs.readFileSync(p)) }));
    const compiled = await compile(directory);
    const references = JSON.parse(fs.readFileSync(".local/diagnostics/task29-a/independent-audit.json")).summaries;
    const definitions = [0, 1, 2].map(stage => {
      const d = JSON.parse(fs.readFileSync(`.local/diagnostics/task29-a/stage${stage}-input.json`));
      compiled.verify.inputGate(d, stage, references[stage]); return d;
    });
    const inventory = JSON.parse(fs.readFileSync(".local/diagnostics/task30-a1/native-libraries.json"));
    for (const p of inventory.selected) assert(fs.existsSync(p.path), "NATIVE_LIBRARY_CHANGED");
    assert.equal(require("electron"), inventory.exe, "ELECTRON_BINARY");
    const env = environment(inventory.ldLibraryPath);
    const ldd = spawnSyncLdd(inventory.exe, env); assert(!ldd.includes("not found"), "NATIVE_LIBRARIES");
    const alive = fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)).flatMap(n => {
      try { return /electron|chrom(e|ium)/i.test(fs.readFileSync(`/proc/${n}/comm`, "utf8")) ? [Number(n)] : []; }
      catch { return []; }
    });
    assert.equal(alive.length, 0, "COMPETING_BROWSER");
    save("preflight.json", { status: "PASS", inputSha: definitions.map(d => d.inputSha256), versions: {
      electron: "45.0.0", chromium: "156.0.8078.48" }, budget: LIMITS, libraries: "PASS",
      existingEvidence: baseline.evidence.length, sources, competing: alive, software: "SwiftShader", stageRetries: 0,
      environment: { logicalParallelism: os.availableParallelism(),
        cpuMax: fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
        memoryMax: fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim() } });
    const began = performance.now(), deadline = began + LIMITS.total;
    for (const stage of probe ? [0] : [0, 1, 2]) {
      const result = await stageRun(stage, definitions[stage], references[stage], directory, compiled, deadline, env, empty ? "empty" : probe);
      summary.stages.push({ stage, status: result.status, error: result.error ?? result.fault,
        cleanup: result.cleanup, wallMs: result.wallMs, performance: result.native?.performance,
        correctness: result.correctness, rss: result.rss });
      console.log(`Stage ${stage}: ${result.status} ${result.error ?? ""}`);
      if (result.status !== "PASS") break;
    }
    summary.status = summary.stages.length === (probe ? 1 : 3) && summary.stages.every(s => s.status === "PASS") ? "PASS" : "FAIL";
  } catch (e) { summary.error = String(e); }
  save("aggregate.json", summary);
  save("manifest.json", fs.readdirSync(directory).filter(n => fs.statSync(path.join(directory, n)).isFile()).map(file => {
    const bytes = fs.readFileSync(path.join(directory, file)); return { file, bytes: bytes.length, sha256: sha(bytes) };
  }));
  usage(directory); return probe ? (summary.status === "PASS" ? 0 : 1) : exitCode(summary);
}
function spawnSyncLdd(exe, env) { return execFileSync("ldd", [exe], { env, encoding: "utf8" }); }
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await main(process.argv.slice(2));
