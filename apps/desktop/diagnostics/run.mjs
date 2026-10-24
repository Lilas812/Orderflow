import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { LIMITS, writer, usage, sha, stats, exitCode, signalTarget } from "./contracts.mjs";
import { observeProcess, readGroup, checkOwnership, resourceSample, captureChild, bounded,
  profileReceipt, reclaimProfile, createShutdown, fault, faultRecord } from "./processMonitor.mjs";
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
/** The exact production orchestration is injectable; offline tests spawn no OS child. */
export async function stageRun(stage, definition, reference, directory, compiled, deadline, env, probe = false, deps = {}) {
  const io = deps.io ?? fs, now = deps.now ?? (() => performance.now()), clock = deps.clock ?? globalThis;
  const sleep = deps.sleep ?? delay, inspect = deps.observeProcess ?? observeProcess, group = deps.readGroup ?? readGroup;
  const began = now(), runId = deps.runId ?? randomUUID(), folder = path.join(directory, `stage${stage}`);
  const result = { stage, runId, status: "INCOMPLETE", inputSha256: definition.inputSha256,
    primaryFault: null, cleanupFaults: [], evidenceFaults: [], samples: [], lifecycle: [],
    cleanup: { remaining: null, groupVerified: false, profileRemoved: false, forcedTermination: false, stopSent: false } };
  let save, child, barriers, profile, started, known = [], residual, monitor, wall, shutdown, failed;
  let phase = "STARTING", cleanupDeadline = Infinity;
  const pendingExits = new Map();
  const failure = new Promise(resolve => { failed = resolve; });
  const event = (kind, details = {}) => {
    if (result.lifecycle.length >= 128) throw fault("LIFECYCLE_CAP");
    result.lifecycle.push({ kind, at: now(), ...details });
  };
  const persist = (name, value) => {
    try { assert(save, "WRITER_UNAVAILABLE"); return save(name, value); }
    catch (e) { result.evidenceFaults.push(faultRecord(e, `WRITE:${name}`, now())); return null; }
  };
  const primary = (e, where) => {
    if (!result.primaryFault) {
      result.primaryFault = faultRecord(e, where, now()); result.status = "FAIL";
      persist("failure.json", { runId, stage, primaryFault: result.primaryFault,
        profile: result.profile, started, child: barriers?.state });
    }
    failed();
  };
  const cleanupFault = (e, where) => {
    result.cleanupFaults.push(faultRecord(e, where, now())); result.status = "FAIL";
  };
  const stop = e => {
    primary(e, phase);
    clock.clearInterval(monitor);
    cleanupDeadline = Math.min(cleanupDeadline, now() + 10000);
    if (shutdown) void shutdown();
  };
  const remaining = max => Math.max(0, Math.min(max, cleanupDeadline - now()));
  try {
    io.mkdirSync(folder, { mode: 0o700 });
    save = (deps.writer ?? writer)(folder, directory);
    profile = io.mkdtempSync(path.join(deps.tempRoot ?? os.tmpdir(), `orderflow-a6-${stage}-`));
    result.profile = profileReceipt(profile, runId, io);
    result.budget = LIMITS;
    result.sources = ["run.mjs", "native.cjs", "verify.ts", "processMonitor.mjs"].map(file => ({
      file, sha256: sha(io.readFileSync(fileURLToPath(new URL(file, import.meta.url)))) }));
    assert(persist("initial.json", { ...result, started: null }), "INITIAL_RECEIPT_FAILED");
    assert(persist("plan.json", { stage, runId, inputSha256: definition.inputSha256, reference, budget: LIMITS,
      cadenceMs: 300, notificationMs: 250, defaultNativeSize: [1440, 960], dpr: 1,
      initialCanvas: "actual chart-area CSS width measured before inputs", stageRetries: 0 }), "PLAN_RECEIPT_FAILED");
    child = (deps.spawn ?? spawn)(deps.electron ?? require("electron"),
      [path.join(root, "apps/desktop/diagnostics/native.cjs"),
        ...(probe ? [probe === "empty" ? "--empty-layout" : "--layout-probe"] : []),
        `--stage=${stage}`, `--run-id=${runId}`, `--output=${folder}`, `--build=${compiled.renderer}`,
        `--input=${path.join(root, `.local/diagnostics/task29-a/stage${stage}-input.json`)}`,
        `--user-data-dir=${profile}`, "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
      { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    barriers = captureChild(child, now); // spawn/exit/close/error BEFORE the first await.
    result.child = barriers.state;
    shutdown = createShutdown([["REQUEST_STOP", async () => {
      phase = "STOP_REQUESTED"; event("shutdown-requested");
      if (barriers.state.exit) return;
      assert(started, "STOP_OWNER_UNKNOWN");
      const authorize = () => {
        const current = inspect(child.pid, { phase }).identity;
        assert(current.ppid === started.ppid, "SIGNAL_PARENT_MISMATCH");
        return signalTarget(started, current, !barriers.state.exit);
      };
      authorize();
      if (child.connected) {
        let sent = false;
        try {
          await bounded(new Promise((resolve, reject) => child.send({ type: "DIAGNOSTIC_STOP", runId },
            e => e ? reject(e) : resolve())), remaining(250), "CONTROL_SEND_TIMEOUT", clock);
          sent = true;
        } catch (e) { cleanupFault(e, "STOP_CONTROL_SEND"); }
        if (sent) {
          try { await bounded(barriers.exited, remaining(2000), "GRACEFUL_WAIT_TIMEOUT", clock); return; }
          catch (e) { event("graceful-wait-ended", { reason: e.reason }); }
        }
      }
      if (!barriers.state.exit) {
        authorize(); // Re-read identity without requiring VmRSS; no group signal, no SIGKILL.
        assert(child.kill("SIGTERM"), "SIGTERM_FAILED");
        result.cleanup.stopSent = true; event("owned-leader-SIGTERM", { pid: child.pid });
      }
    }]], r => result.cleanupFaults.push(r));
    child.on("error", e => stop(e));
    child.on("message", m => {
      try {
        assert(m && Object.keys(m).length === 2 && m.runId === runId &&
          ["DIAGNOSTIC_DISPOSING", "DIAGNOSTIC_SAVED"].includes(m.type), "CONTROL_MESSAGE_INVALID");
        event(m.type);
        // Disposal is not exit confirmation; keep observing identity, group and resources.
        phase = "EXIT_TRANSITION";
      } catch (e) { stop(e); }
    });
    result.stderr = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", b => {
      if (Buffer.byteLength(result.stderr) + b.length > 65536) stop(fault("STDERR_CAP"));
      else result.stderr += b.toString();
    });
    const ms = Math.min(LIMITS.wall[stage], deadline - now());
    assert(ms > 0, "TOTAL_WALL");
    wall = clock.setTimeout(() => stop(fault("WALL_TIMEOUT")), ms);
    await bounded(barriers.spawned, ms, "SPAWN_TIMEOUT", clock);
    phase = "RUNNING";
    started = inspect(child.pid, { phase }).identity;
    assert(started.ppid === (deps.parentPid ?? process.pid) &&
      started.pgid === child.pid && started.sid === child.pid, "OWN_GROUP");
    result.started = started;
    assert(persist("owned.json", { runId, profile: result.profile, started }), "OWNED_RECEIPT_FAILED");
    const sample = () => {
      if (barriers.state.exit) return;
      const g = group(child.pid, { phase, known });
      checkOwnership(started, g, known);
      // Preserve every observed identity; returning PIDs must not bypass PID-reuse checks.
      for (const p of g.processes) if (!known.some(k => k.pid === p.pid)) known.push(p);
      assert(known.length <= LIMITS.rows, "IDENTITY_HISTORY_CAP");
      const sample = resourceSample(g, LIMITS, phase, now());
      result.samples.push(sample);
      // A disposal acknowledgement is not proof of death. Missing exit RSS has
      // its own finite confirmation budget, never the remainder of the Stage.
      for (const o of g.observations.filter(o => o.resource.kind === "UNKNOWN")) {
        if (pendingExits.has(o.identity.pid)) continue;
        event("exit-transition-pending", { identity: o.identity });
        pendingExits.set(o.identity.pid, clock.setTimeout(() => stop(fault("EXIT_TRANSITION_UNCONFIRMED",
          { targetPid: o.identity.pid, identity: o.identity, reads: o.reads })), 5000));
      }
      for (const [pid, timer] of pendingExits) {
        const o = g.observations.find(o => o.identity.pid === pid);
        if (o?.liveness === "EXIT_CONFIRMED" || (!o && !g.departures.some(d => d.targetPid === pid))) {
          clock.clearTimeout(timer); pendingExits.delete(pid);
          event("exit-transition-confirmed", { pid, proof: o ? "KERNEL_EXIT_STATE" : "COMPLETE_INVENTORY_ABSENCE" });
        }
      }
      assert(result.samples.length <= 4200, "SAMPLE_CAP");
    };
    sample();
    monitor = clock.setInterval(() => { try { sample(); } catch (e) { stop(e); } }, 100);
    await Promise.race([barriers.exited, failure]);
    if (result.primaryFault) await shutdown();
  } catch (e) {
    stop(e);
    if (shutdown) await shutdown();
  } finally {
    clock.clearInterval(monitor); clock.clearTimeout(wall);
    phase = "DRAIN"; cleanupDeadline = Math.min(cleanupDeadline, now() + 10000);
    const steps = [
      ["EXIT", async () => {
        assert(barriers, "CHILD_NOT_SPAWNED");
        await bounded(barriers.exited, remaining(5000), "EXIT_TIMEOUT", clock);
      }],
      ["STDIO_CLOSE", async () => {
        assert(barriers, "CHILD_NOT_SPAWNED");
        await bounded(barriers.closed, remaining(3000), "STDIO_CLOSE_TIMEOUT", clock);
      }],
      ["GROUP_DRAIN", async () => {
        assert(started && barriers?.state.exit, "DRAIN_OWNER_OR_EXIT_UNKNOWN");
        const until = now() + remaining(5000);
        for (let i = 0; i <= 100; i++) {
          residual = group(child.pid, { phase, known });
          checkOwnership(started, residual, known, true);
          event("drain", { remaining: residual.processes.length, departures: residual.departures });
          if (!residual.processes.length && !residual.departures.length) break;
          assert(i < 100 && now() < until, "GROUP_DRAIN_TIMEOUT");
          await sleep(Math.min(50, until - now()));
        }
        // A fresh final inventory is independent of the last polling sample.
        residual = group(child.pid, { phase: "FINAL_GROUP", known });
        checkOwnership(started, residual, known, true);
        assert(residual.processes.length === 0 && !residual.departures.length, "FINAL_GROUP_NOT_EMPTY");
        result.cleanup.remaining = residual.processes.length;
        result.cleanup.groupVerified = true;
      }],
      ["PROFILE_RECLAIM", async () => {
        assert(residual && result.cleanup.groupVerified, "GROUP_UNVERIFIED");
        reclaimProfile(result.profile, runId, started, residual, barriers.state, io);
        result.cleanup.profileRemoved = true;
      }],
    ];
    for (const [name, step] of steps) try { await step(); } catch (e) { cleanupFault(e, name); }
    for (const [pid, timer] of pendingExits) {
      clock.clearTimeout(timer);
      event("exit-transition-final", { pid, confirmed: result.cleanup.groupVerified &&
        !!barriers?.state.exit && !!barriers?.state.close });
    }
    if (child && !barriers?.state.close) {
      try {
        // Releasing our IPC handle is not exit proof. Leave the Stage FAIL and
        // profile intact if the owned child ignored graceful stop / SIGTERM.
        if (child.connected) child.disconnect();
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      catch (e) { cleanupFault(e, "STREAM_RELEASE"); }
    }
  }
  try {
    const nativeFile = path.join(folder, "native-result.json");
    if (io.existsSync(nativeFile)) result.native = JSON.parse(io.readFileSync(nativeFile));
    if (!result.primaryFault && !result.cleanupFaults.length && !result.evidenceFaults.length) {
      assert(barriers.state.exit.code === 0 && !barriers.state.exit.signal &&
        barriers.state.close && !barriers.state.error && result.cleanup.profileRemoved, "NATIVE_EXIT_OR_RESOURCE");
      assert.equal(result.native?.status, "PASS", result.native?.error ?? "NATIVE_RESULT_MISSING");
      assert.equal(result.native.runId, runId, "NATIVE_RUN_ID");
      const quit = JSON.parse(io.readFileSync(path.join(folder, "quit.json")));
      assert(quit.runId === runId && quit.status === "PASS" && quit.windows === 0, "NATIVE_QUIT_RECEIPT");
      const records = [];
      for (const receipt of result.native.blocks) {
        assert(/^block-\d{3}\.json$/.test(receipt.file), "BLOCK_PATH");
        const raw = io.readFileSync(path.join(folder, receipt.file));
        assert.equal(sha(raw), receipt.sha256, "RECEIPT_SHA");
        records.push(...decode(JSON.parse(raw.toString())));
      }
      assert.equal(records.length, result.native.recordCount, "LOSSLESS_RECORD_COUNT");
      if (!probe) result.correctness = compiled.verify.verifyFrames(definition, reference, records,
        result.native.observer, result.native.expected.width, result.native.finalUi, result.native.formalInterval);
      if (!probe && stage === 2) assert(result.correctness.checks.some(c => c.quality === "GAP") &&
        result.correctness.checks.some(c => c.quality === "RESYNCING") &&
        result.correctness.checks.at(-1).quality === "VALID", "GAP_RECOVERY");
      assert(now() <= deadline && now() - began <= LIMITS.wall[stage], "VERIFICATION_WALL");
      const measured = result.samples.filter(s => s.resource.kind === "MEASURED");
      assert(measured.length, "NO_MEASURED_RSS");
      result.rss = stats(measured.map(s => s.resource.bytes));
      result.cpuClockHz = deps.clockHz ?? Number(execFileSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8" }));
      result.status = "PASS";
    }
  } catch (e) { primary(e, "VERIFICATION"); }
  if (result.primaryFault || result.cleanupFaults.length || result.evidenceFaults.length) result.status = "FAIL";
  result.wallMs = now() - began;
  if (!result.primaryFault && result.status === "FAIL")
    persist("failure.json", { runId, stage, primaryFault: null, cleanupFaults: result.cleanupFaults, evidenceFaults: result.evidenceFaults });
  event("closed", { exit: !!barriers?.state.exit, close: !!barriers?.state.close,
    emptyGroup: result.cleanup.remaining === 0, profileRemoved: result.cleanup.profileRemoved });
  persist("cleanup.json", { runId, cleanup: result.cleanup, primaryFault: result.primaryFault,
    cleanupFaults: result.cleanupFaults, child: barriers?.state });
  if (result.evidenceFaults.length) result.status = "FAIL";
  if (!persist("result.json", result)) result.status = "FAIL";
  return result;
}
export async function runStages(stages, run) {
  const rows = stages.map(stage => ({ stage, status: "NOT_RUN" }));
  for (let i = 0; i < stages.length; i++) {
    try { rows[i] = await run(stages[i]); }
    catch (e) { rows[i] = { stage: stages[i], status: "FAIL", primaryFault: faultRecord(e, "STAGE_SETUP") }; }
    if (rows[i].status !== "PASS") break;
  }
  return { status: rows.every(r => r.status === "PASS") ? "PASS" : "FAIL", stages: rows, GateB2B: "HOLD" };
}
export async function main(args) {
  assert(args.length === 1 && ["--run", "--probe", "--empty-layout"].includes(args[0]), "EXPLICIT_RUN_REQUIRED");
  const probe = args[0] !== "--run", empty = args[0] === "--empty-layout";
  const base = path.join(root, ".local/diagnostics/task30-a6");
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(base, `${empty ? "empty" : probe ? "probe" : "formal"}-`));
  const save = writer(directory), summary = { status: "FAIL",
    stages: (probe ? [0] : [0, 1, 2]).map(stage => ({ stage, status: "NOT_RUN" })), GateB2B: "HOLD" };
  try {
    const baseline = JSON.parse(fs.readFileSync(path.join(base, "baseline.json")));
    const frozenInputs = JSON.parse(fs.readFileSync(path.join(root, ".local/diagnostics/task30-a3/baseline.json"))).inputs;
    for (const row of [...baseline.evidence, ...frozenInputs])
      assert.equal(sha(fs.readFileSync(row.path)), row.sha256, row.path);
    const allowed = new Set([
      "apps/desktop/diagnostics/native.cjs",
      "apps/desktop/diagnostics/run.mjs", "apps/desktop/tests/diagnostics.test.ts",
      "apps/desktop/diagnostics/processMonitor.mjs", "apps/desktop/diagnostics/verify.ts",
      "apps/desktop/tests/processMonitor.test.ts", "apps/desktop/tests/deltaQuality.test.ts",
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
    Object.assign(summary, await runStages(probe ? [0] : [0, 1, 2], stage =>
      stageRun(stage, definitions[stage], references[stage], directory, compiled, deadline, env, empty ? "empty" : probe)));
  } catch (e) { summary.primaryFault = faultRecord(e, "PREFLIGHT"); }
  try {
    save("aggregate.json", summary);
    save("manifest.json", fs.readdirSync(directory).filter(n => fs.statSync(path.join(directory, n)).isFile()).map(file => {
      const bytes = fs.readFileSync(path.join(directory, file)); return { file, bytes: bytes.length, sha256: sha(bytes) };
    }));
    usage(directory);
  } catch (e) {
    summary.status = "FAIL"; summary.evidenceFaults = [faultRecord(e, "AGGREGATE_WRITE")];
    try { save("evidence-failure.json", summary); } catch { console.error("AGGREGATE_EVIDENCE_FAILED"); }
    return 1;
  }
  return probe ? (summary.status === "PASS" ? 0 : 1) : exitCode(summary);
}
function spawnSyncLdd(exe, env) { return execFileSync("ldd", [exe], { env, encoding: "utf8" }); }
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await main(process.argv.slice(2));
