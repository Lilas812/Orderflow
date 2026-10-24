import fs from "node:fs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { resolve, dirname, basename, join, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createAnalysisHub } from "@workspace/core/analysis-hub";
import { projectDeltaTimeline } from "@workspace/core/delta-timeline";
import { createBrowserTermination, timeStats } from "../baseline13-driver.mjs";
import { installObserver } from "./observer.mjs";
import { BUDGET, LAYOUT, layoutGate, deltaDrawingGate, canonical, validate, orderedStages, marketCount, deadlineBudget } from "./contracts.ts";
import { save, checkDirectory } from "../load29/evidence.ts";
import { group, identity, resourceGate, competingBrowsers, ownershipEvidence,
  createMonitorLifecycle, cleanupOwnership } from "./process.mjs";
const REFERENCES = ".local/diagnostics/task29-b", INPUT = ".local/diagnostics/task29-a";
const sha = x => createHash("sha256").update(x).digest("hex");
const delay = ms => new Promise(r => setTimeout(r, ms));
export function parseArguments(args) {
  assert(args[0] === "--run", "RUN_ARGUMENT_REQUIRED");
  let outputDir, dryRun = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--output-dir") {
      assert(!outputDir && args[i + 1] && !args[i + 1].startsWith("--"), "OUTPUT_ARGUMENT");
      outputDir = args[++i];
    } else if (args[i] === "--dry-run") {
      assert(!dryRun, "DUPLICATE_DRY_RUN"); dryRun = true;
    } else throw Error("UNKNOWN_ARGUMENT");
  }
  assert(outputDir, "OUTPUT_DIR_REQUIRED");
  return { outputDir, dryRun };
}
function noSymlinks(path) {
  let current = resolve(path);
  for (;;) {
    assert(!fs.lstatSync(current).isSymbolicLink(), "OUTPUT_SYMLINK");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function validateOutputPath(requested, workspace = process.cwd()) {
  assert(typeof requested === "string" && requested.length > 0 && !requested.includes("\0"), "OUTPUT_PATH");
  assert(!requested.split(/[\\/]/).includes(".."), "OUTPUT_TRAVERSAL");
  const base = resolve(workspace, ".local/diagnostics"), directory = resolve(workspace, requested);
  noSymlinks(base);
  const inside = relative(base, directory);
  assert(inside && !isAbsolute(inside) && !inside.startsWith(`..${sep}`) &&
    dirname(directory) === base, "OUTPUT_OUTSIDE_DIAGNOSTICS");
  // Only a new revision of this diagnostic may be writable, never an old reference.
  assert(/^task29-b-r(?:[2-9]|[1-9][0-9]+)$/.test(basename(directory)), "PROTECTED_REFERENCE");
  assert(!fs.existsSync(directory) && !fs.lstatSync(base).isSymbolicLink(), "OUTPUT_ALREADY_EXISTS");
  assert(fs.realpathSync(base) === base && fs.statSync(base).isDirectory() &&
    fs.statSync(base).uid === process.getuid(), "OUTPUT_PARENT");
  return directory;
}
export function createOutput(requested, workspace = process.cwd()) {
  const directory = validateOutputPath(requested, workspace);
  fs.mkdirSync(directory, { mode: 0o700 }); // Exclusive claim; never adopt another run's directory.
  const owned = fs.lstatSync(directory);
  const verify = () => {
    noSymlinks(directory);
    const current = fs.lstatSync(directory);
    assert(current.ino === owned.ino && current.dev === owned.dev &&
      current.uid === owned.uid, "OUTPUT_IDENTITY_CHANGED");
    checkDirectory(directory);
  };
  verify();
  return Object.freeze({
    directory,
    write(name, data) {
      try { verify(); return save(directory, name, data); }
      catch (error) {
        // Preserve a failed trial even if its checkpoint cannot be published.
        if (data?.status === "FAIL") {
          const failure = Error(`EVIDENCE_SAVE_FAILED:${String(error)}`, { cause: error });
          failure.originalResult = data;
          throw failure;
        }
        throw error;
      }
    },
    read(name) {
      verify();
      assert(/^[a-z0-9][a-z0-9.-]*\.json$/.test(name), "OUTPUT_FILENAME");
      return JSON.parse(fs.readFileSync(join(directory, name), "utf8"));
    },
  });
}
export function recordFailure(output, error) {
  const result = { status: "FAIL", error: error.originalResult?.error ?? String(error),
    originalResult: error.originalResult, saveError: error.originalResult ? String(error) : undefined };
  if (output) {
    try { output.write("run-error.json", result); }
    catch (saveError) { result.evidenceError = String(saveError); }
  }
  return result;
}
export function verifyInput(d, stage, expected) {
  validate(d, stage);
  assert.equal(sha(JSON.stringify(d.inputs)), expected, "INPUT_SHA_MISMATCH");
  assert.equal(d.inputSha256, expected, "INPUT_SHA_MISMATCH");
}
export function decodeBlock(wire) {
  assert.equal(wire.codec, "gzip/base64");
  const b = gunzipSync(Buffer.from(wire.data, "base64"), { maxOutputLength: BUDGET.wireBytes });
  assert.equal(b.length, wire.bytes, "BLOCK_BYTES");
  assert.equal(sha(b), wire.sha256, "BLOCK_SHA");
  return JSON.parse(b.toString());
}
export function publicMatch(frame, reference) {
  assert.equal(sha(canonical(frame)), reference, "PUBLIC_FRAME_MISMATCH");
}
export function glGate(observer) {
  assert(!observer.fault && observer.totals.errors === 0 && observer.totals.loss === 0, "GL_OR_CONTEXT_FAILURE");
}
export function aggregateExitCode(result) {
  return result?.status === "PASS" && result.stages?.length === 3 &&
    result.stages.every((r, index) => r.stage === index && r.status === "PASS" &&
      !r.fault && !r.error && r.cleanup?.status !== "FAIL") ? 0 : 1;
}
export function pins(preflight = `${REFERENCES}/preflight.json`) {
  const p = JSON.parse(fs.readFileSync(preflight));
  for (const f of [...p.sources, ...p.evidence]) assert.equal(sha(fs.readFileSync(f.path)), f.sha256, f.path);
  return p;
}
export function journal(stage, output) {
  assert(output, "OUTPUT_DIR_REQUIRED");
  let rows = [], bytes = 0, count = 0;
  const blocks = [];
  return {
    append(row) {
      const n = Buffer.byteLength(JSON.stringify(row));
      assert(n <= BUDGET.wireBytes, "ROW_CAP");
      if (bytes + n > BUDGET.blockBytes && rows.length) this.flush();
      rows.push(row); bytes += n;
      assert(++count <= BUDGET.observerRows, "JOURNAL_RECORD_CAP");
    },
    flush() {
      if (!rows.length) return;
      const raw = Buffer.from(JSON.stringify(rows));
      const write = typeof output === "string" ? (name, data) => save(output, name, data) : output.write;
      const receipt = write(`stage${stage}-block-${String(blocks.length).padStart(3, "0")}.json`,
        { codec: "gzip/base64", bytes: raw.length, sha256: sha(raw), data: gzipSync(raw).toString("base64") });
      blocks.push(receipt); rows = []; bytes = 0;
    },
    checkpoint() { this.flush(); return { count, blocks: [...blocks] }; },
  };
}
async function runStage(stage, d, reference, globalDeadline, output) {
  assert.equal(competingBrowsers().length, 0, "COMPETING_PROCESS_GATE");
  const profile = fs.mkdtempSync("/tmp/orderflow-load29-");
  const profileStat = fs.lstatSync(profile);
  assert.equal(fs.realpathSync(profile), profile, "PROFILE_SYMLINK");
  assert.equal(profileStat.uid, process.getuid(), "PROFILE_OWNER");
  assert.equal(profileStat.mode & 0o777, 0o700, "PROFILE_MODE");
  const journalOut = journal(stage, output), samples = [], cpuStart = process.cpuUsage(), began = performance.now();
  let started = null, monitor = null, wall = null, fault = null, n = 0, sessionId, pending = new Map(), wire = "";
  const decoder = new StringDecoder("utf8");
  let beforeDispose, afterDispose, observer, observerAfter, result, version, browserMetrics, layout;
  const lifecycle = createMonitorLifecycle(), ownership = [], faults = [];
  let known = [], knownAt, cleanupPromise;
  const browser = spawn("/repl/tools/bin/chromium", ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-breakpad", "--disable-crash-reporter", "--no-first-run",
    "--no-default-browser-check", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--remote-debugging-pipe", `--user-data-dir=${profile}`],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const exited = () => browser.exitCode !== null || browser.signalCode !== null;
  let termination;
  const childState = () => ({ pid: browser.pid, exitCode: browser.exitCode,
    signalCode: browser.signalCode, heldLeader: !exited() && browser.pid === started?.pid });
  function noteFault(e) {
    const info = e.evidence ?? { code: "MONITOR_INSPECTION_FAILED", reason: String(e),
      at: performance.now(), targetPid: e.targetPid ?? started?.pid, expected: started,
      observed: e.snapshot ?? null, phase: lifecycle.phase, child: childState(),
      conditions: ["complete identity and RSS observations required"] };
    faults.push(info);
    if (!fault) fault = String(e);
  }
  function sampleRunning() {
    if (lifecycle.phase !== "RUNNING") return;
    const snapshot = group(browser.pid);
    const evidence = ownershipEvidence(started, snapshot, lifecycle.phase, performance.now(), childState());
    if (evidence.status !== "PASS") { const e = Error(`OWNERSHIP_UNKNOWN:${evidence.reason}`); e.evidence = evidence; throw e; }
    const sample = resourceGate(started, snapshot, identity(process.pid), BUDGET);
    known = snapshot.processes; knownAt = sample.at;
    assert(samples.length < BUDGET.observerRows, "RESOURCE_RECORD_CAP"); samples.push(sample);
  }
  function shutdown() {
    if (cleanupPromise) return cleanupPromise;
    // One final RUNNING check, then stop that monitor BEFORE Browser.close.
    // Cleanup has its own strict inspections; unknown members are never waived.
    if (lifecycle.phase === "RUNNING") {
      try { sampleRunning(); } catch (e) { noteFault(e); }
      lifecycle.beginCleanup();
      if (monitor) clearInterval(monitor);
    }
    cleanupPromise = (async () => {
      const cleanup = await termination.finish();
      return cleanup;
    })();
    return cleanupPromise;
  }
  function fail(e) {
    noteFault(e);
    if (termination) void shutdown().catch(() => {});
  }
  function call(method, params = {}, sid) {
    return new Promise((resolveCall, reject) => {
      if (pending.size >= 64 || exited()) return reject(Error("CDP_UNAVAILABLE"));
      const id = ++n, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP_TIMEOUT:${method}`)); }, 10000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }) + "\0");
    });
  }
  browser.on("error", fail);
  browser.on("exit", (code, signal) => lifecycle.events.push({
    kind: "child-exit", at: performance.now(), code, signal }));
  browser.stdio[4].on("data", data => {
    try {
      wire += decoder.write(data);
      assert(Buffer.byteLength(wire) <= BUDGET.wireBytes, "CDP_WIRE_CAP");
      let cut;
      while ((cut = wire.indexOf("\0")) >= 0) {
        const text = wire.slice(0, cut); wire = wire.slice(cut + 1); if (!text) continue;
        const m = JSON.parse(text);
        if (m.id) {
          const p = pending.get(m.id); if (!p) continue;
          pending.delete(m.id); clearTimeout(p.timer);
          if (m.error) p.reject(Error(`CDP_ERROR:${m.error.message}`)); else p.resolve(m.result);
        } else if (m.method === "Runtime.bindingCalled" && m.params.name === "__load29Send") {
          const row = JSON.parse(m.params.payload); journalOut.append(row);
          if (row.kind === "failure") fail(row.fault);
        } else if (m.method === "Fetch.requestPaused") {
          const u = new URL(m.params.request.url);
          const allowed = ["http:", "https:"].includes(u.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
          void call(allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
            { requestId: m.params.requestId, ...(!allowed ? { errorReason: "BlockedByClient" } : {}) }, m.sessionId).catch(fail);
        } else if (m.method === "Runtime.exceptionThrown") fail("PAGE_EXCEPTION");
      }
    } catch (e) { fail(e); }
  });
  try { started = identity(browser.pid); } catch (e) { fail(e); }
  termination = createBrowserTermination({
    close: async () => {
      lifecycle.events.push({ kind: "browser-close-start", at: performance.now() });
      try { const r = await call("Browser.close"); lifecycle.events.push({ kind: "browser-close-ok", at: performance.now() }); return r; }
      catch (e) { lifecycle.events.push({ kind: "browser-close-error", at: performance.now(), error: String(e) }); throw e; }
    }, exited, holdsLeader: () => !exited() && browser.pid === started?.pid,
    inspect: async () => {
      const until = performance.now() + 500;
      for (;;) {
        let snapshot;
        try { snapshot = group(browser.pid); } catch (e) { noteFault(e); throw e; }
        const verdict = cleanupOwnership(started, snapshot, known, exited());
        assert(ownership.length < BUDGET.observerRows, "OWNERSHIP_RECORD_CAP");
        ownership.push({ ...ownershipEvidence(started, snapshot, lifecycle.phase, performance.now(), childState()),
          cleanupVerdict: verdict });
        if (verdict.status === "FAIL") {
          const e = Error(`CLEANUP_OWNERSHIP_UNKNOWN:${verdict.reason}`);
          e.evidence = ownership.at(-1); noteFault(e);
        }
        if (verdict.status !== "EXITING" || performance.now() >= until) return snapshot;
        await delay(25); // Known exiting members only; never a signal authorization.
      }
    }, waitExit: async ms => {
      const end = performance.now() + ms; while (!exited() && performance.now() < end) await delay(25);
    }, signal: (pid, signal) => process.kill(pid, signal), recover: async ms => {
      const end = performance.now() + ms;
      while (performance.now() < end) { const g = group(browser.pid); if (!g.live.length && !g.zombies.length) return; await delay(50); }
    },
  }, { trialId: `load29-stage${stage}`, started });
  const page = (method, params = {}) => call(method, params, sessionId);
  const evaluate = async expression => {
    if (fault) throw Error(fault);
    const r = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error("PAGE_EVALUATION_ERROR");
    return r.result.value;
  };
  try {
    assert(started, "START_IDENTITY_UNKNOWN");
    wall = setTimeout(() => { fail(Error("WALL_TIMEOUT")); void termination.wallTimeout().catch(fail); },
      deadlineBudget(stage, performance.now(), globalDeadline));
    monitor = setInterval(() => {
      if (lifecycle.phase !== "RUNNING") return;
      try { sampleRunning(); } catch (e) { fail(e); }
    }, 100);
    version = await call("Browser.getVersion");
    assert.equal(version.product, "Chrome/152.0.7977.64", "CHROME_ENV");
    const target = await call("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true }));
    await page("Page.enable"); await page("Runtime.enable");
    await page("Performance.enable");
    await page("Emulation.setDeviceMetricsOverride", { width: LAYOUT.viewportWidth,
      height: LAYOUT.viewportHeight, deviceScaleFactor: LAYOUT.dpr, mobile: false });
    await page("Runtime.addBinding", { name: "__load29Send" });
    await page("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await page("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__load29Input=${JSON.stringify({ stage, definition: d })};(${installObserver.toString()})()`,
    });
    await page("Page.navigate", { url: "http://127.0.0.1:80/src/diagnostics/load29-browser/index.html" });
    const readyEnd = performance.now() + 15000;
    while (!await evaluate(`!!window.__load29 && !!document.querySelector('[data-testid="button-unified-start"]')`)) {
      assert(performance.now() < readyEnd, "PAGE_START_TIMEOUT"); await delay(100);
    }
    await evaluate("window.__load29.start()");
    let layoutChecked = false;
    while (true) {
      const state = await evaluate("({done:window.__load29.snapshot().done,fault:window.__load29.snapshot().fault})");
      assert(!state.fault, state.fault);
      if (!layoutChecked) {
        const observed = await evaluate("window.__load29Observer.geometry()");
        if (observed.canvases.length >= 2) { layoutGate(observed); layout = observed; layoutChecked = true; }
      }
      if (state.done) break;
      assert(performance.now() - began < BUDGET.wallMs[stage], "WALL_TIMEOUT");
      await delay(250);
    }
    // Allow the final committed React effects/rAFs, not a new data interval or extra input.
    await delay(250);
    beforeDispose = await evaluate("window.__load29.snapshot()");
    observer = await evaluate("window.__load29Observer.snapshot()");
    browserMetrics = await page("Performance.getMetrics");
    layout = await evaluate("window.__load29Observer.geometry()"); layoutGate(layout);
    glGate(observer);
    assert(beforeDispose.status.processedInputs === d.inputs.length &&
      beforeDispose.status.acceptedMarketEvents === marketCount(d.inputs), "INPUT_COMPLETION");
    assert(beforeDispose.panels.every(p => p.exists && (p.testid === "delta-panel" || Number(p.revision) === beforeDispose.revision) &&
      p.rect.width > 0 && p.rect.height > 0), "PANEL_REVISION_OR_SIZE");
    assert(observer.rows.some(r => r.kind === "delta-draw" && r.revision === beforeDispose.revision), "DELTA_DRAW_MISSING");
    assert(beforeDispose.panels.find(p => p.testid === "vp-panel").svgRects > 0, "VP_SVG_MISSING");
    assert(observer.contexts.filter(c => c.connected).every(c => !c.lost && c.error === 0), "CONTEXT_UNAVAILABLE");
    assert(observer.contexts.filter(c => c.connected).every(c => /SwiftShader.*Subzero/.test(c.renderer)), "GPU_ENV");
    for (const layer of ["heatmap", "bubble"]) {
      assert(observer.contexts.some(c => c.layer === layer && c.connected), `CANVAS_MISSING:${layer}`);
      assert(beforeDispose.panels.find(p => p.testid === `${layer}-canvas`).status === "READY", `NOT_READY:${layer}`);
    }
    afterDispose = await evaluate("window.__load29.dispose()");
    await delay(50);
    observerAfter = await evaluate("window.__load29Observer.snapshot()");
    assert.equal(afterDispose.timers, 0);
    assert.equal(afterDispose.after.subscribers, 0);
    assert.equal(afterDispose.mountedCanvases, 0);
    assert.equal(observerAfter.pending, 0);
    assert.equal(observerAfter.totals.buffers, observerAfter.totals.deletes, "BUFFER_REMAINDER");
    await evaluate("window.__load29Observer.dispose()");
    result = { status: "PASS", version, browserMetrics, beforeDispose, afterDispose, observer, observerAfter };
  } catch (error) { result = { status: "FAIL", error: String(error), beforeDispose, afterDispose, observer, observerAfter }; }
  finally {
    const cleanup = await shutdown();
    lifecycle.closed();
    if (wall) clearTimeout(wall);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("CDP_CLOSED")); } pending.clear();
    const residual = group(browser.pid);
    const profileRemoved = !residual.processes.length;
    if (profileRemoved) {
      const s = fs.lstatSync(profile);
      assert(!s.isSymbolicLink() && s.ino === profileStat.ino && s.uid === profileStat.uid &&
        fs.realpathSync(profile) === profile, "PROFILE_CHANGED");
      fs.rmSync(profile, { recursive: true });
    }
    const checkpoint = journalOut.checkpoint();
    result ??= { status: "FAIL", error: fault ?? "RUN_INCOMPLETE" };
    Object.assign(result, { stage, started, fault, faults, ownership, lifecycle: lifecycle.events,
      lastVerifiedOwnership: { at: knownAt, processes: known },
      version, browserMetrics, layout, cleanup, profileRemoved,
      remainingProfile: fs.existsSync(profile), samples, checkpoint,
      wallMs: performance.now() - began, parentCpuUs: process.cpuUsage(cpuStart),
      cpuClockHz: Number(execFileSync("/usr/bin/getconf", ["CLK_TCK"], { encoding: "utf8" })),
      cpuClockSource: "getconf CLK_TCK checked before run", inputSha256: d.inputSha256,
      frameCanonicalSchema: "frozen Node canonical BigInt/Map encoding", resources: "100ms samples, not instantaneous peak" });
    if (cleanup.status !== "PASS" || cleanup.close !== "OK" || fault || !profileRemoved || !samples.length) result.status = "FAIL";
    output.write(`stage${stage}-checkpoint.json`, result);
    output.write(`stage${stage}-cleanup.json`, { status: result.cleanup.status, cleanup: result.cleanup,
      profileRemoved: result.profileRemoved, remainingProfile: result.remainingProfile });
  }
  if (result.status === "PASS") {
    // Derived references only: original #29-A inputs/reference are never edited.
    const hub = createAnalysisHub(d.scope, () => 0), checks = [], deltaChecks = []; let consumed = 0, lastFrame;
    const deltaByRevision = new Map();
    try {
      for (const receipt of result.checkpoint.blocks) {
        const wire = output.read(receipt.file);
        for (const row of decodeBlock(wire)) {
          assert(performance.now() < globalDeadline, "OVERALL_WALL");
          if (row.kind !== "frame" && row.kind !== "probe") continue;
          assert(row.prefix >= consumed && row.prefix <= d.inputs.length, "PREFIX_ORDER");
          while (consumed < row.prefix) {
            const decision = hub.ingest(d.inputs[consumed++]);
            assert.equal(decision.disposition, "ACCEPTED", "REFERENCE_INPUT_REJECTION");
          }
          const expected = canonical(hub.readRenderFrame(d.query));
          assert.equal(row.canonical, expected, `PREFIX_FRAME_MISMATCH:${row.prefix}`);
          lastFrame = JSON.parse(row.canonical);
          if (row.kind === "frame") {
            const frame = hub.readRenderFrame(d.query);
            for (const draw of result.observer.rows.filter(x => x.kind === "delta-draw" && x.revision === row.revision)) {
              deltaChecks.push(deltaDrawingGate(draw, projectDeltaTimeline(frame.delta.items, draw.viewport, 126), row.revision));
              deltaByRevision.set(row.revision, true);
            }
            assert(deltaByRevision.has(row.revision), `DELTA_REVISION_DRAW_MISSING:${row.revision}`);
          }
          checks.push({ kind: row.kind, prefix: row.prefix, revision: row.revision, sha256: sha(row.canonical),
            quality: lastFrame.quality.channels.L2_MBP.status, readMs: row.readMs ?? row.ms, cache: row.cache });
        }
      }
      assert.equal(consumed, d.inputs.length, "FINAL_PREFIX_MISSING");
      publicMatch(lastFrame, reference.publicFrameSha256);
      if (stage === 2) {
        const conditionPrefixes = d.inputs.flatMap((i, index) => i.type === "CONDITION" ? [index + 1] : []);
        for (const prefix of conditionPrefixes) assert(checks.some(c => c.prefix === prefix && c.kind === "probe"), `QUALITY_BOUNDARY_NOT_OBSERVED:${prefix}`);
        assert(checks.some(c => c.quality === "GAP") && checks.some(c => c.quality === "RESYNCING"), "QUALITY_BOUNDARY_MISSING");
      }
      assert(deltaChecks.some(c => c.validBins > 0), "DELTA_VALID_DATA_NOT_OBSERVED");
      assert(result.observer.rows.filter(r => r.kind === "delta-draw")
        .every(r => deltaByRevision.has(r.revision)), "DELTA_UNPUBLISHED_REVISION");
      result.correctness = { status: "PASS", prefixes: checks, deltaChecks, finalPublicFrameSha256: sha(canonical(lastFrame)) };
      const reads = result.beforeDispose.readRows;
      result.performance = { frameMiss: timeStats(reads.filter(c => c.cache === "MISS").map(c => c.ms)),
        frameHit: timeStats(reads.filter(c => c.cache === "HIT").map(c => c.ms)) };
    } catch (error) { result.status = "FAIL"; result.correctness = { status: "FAIL", error: String(error), checkedPrefixes: checks, deltaChecks }; }
  }
  return result;
}
export function loadReferences() {
  const protectedPins = pins();
  const references = JSON.parse(fs.readFileSync(`${INPUT}/independent-audit.json`)).summaries;
  const definitions = [0, 1, 2].map(stage => {
    const d = JSON.parse(fs.readFileSync(`${INPUT}/stage${stage}-input.json`));
    verifyInput(d, stage, references[stage].inputSha256); return d;
  });
  return { protectedPins, references, definitions };
}
export function writeAggregate(output, result) {
  output.write("aggregate.json", result);
  output.write("report.json", { status: result.status, stages: result.stages, GateB2B: "HOLD" });
  const files = fs.readdirSync(output.directory).sort().map(file => {
    const bytes = fs.readFileSync(join(output.directory, file));
    return { file, bytes: bytes.length, sha256: sha(bytes) };
  });
  output.write("evidence-sha256.json", { files, manifestExcluded: true });
}
async function main(args) {
  const options = parseArguments(args);
  const directory = validateOutputPath(options.outputDir);
  const { protectedPins, references, definitions } = loadReferences();
  if (options.dryRun) {
    console.log(JSON.stringify({ status: "PASS", mode: "DRY_RUN", directory,
      references: { preflight: `${REFERENCES}/preflight.json`, input: INPUT },
      inputSha256: definitions.map(d => d.inputSha256), budget: BUDGET,
      browserLaunches: 0, writes: 0 }));
    return;
  }
  let output;
  try {
  output = createOutput(options.outputDir);
  output.write("preflight.json", { referencePreflight: `${REFERENCES}/preflight.json`, protectedPins,
    directory, sources: fs.readdirSync("apps/web/src/diagnostics/load29-browser").map(name => {
      const path = `apps/web/src/diagnostics/load29-browser/${name}`; return { path, sha256: sha(fs.readFileSync(path)) };
    }), inputs: definitions.map(d => d.inputSha256), budget: BUDGET });
  assert.equal(fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(), "800000 100000", "CPU_ENV");
  assert.equal(fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(), "17179869184", "MEMORY_ENV");
  const sources = fs.readdirSync("apps/web/src/diagnostics/load29-browser").map(name => {
    const path = `apps/web/src/diagnostics/load29-browser/${name}`; return { path, sha256: sha(fs.readFileSync(path)) };
  });
  output.write("run-start.json", { budget: BUDGET, sources, launchAttemptsAllowed: 3, stageRetries: 0 });
  const started = performance.now(), results = await orderedStages(async stage => {
    pins(); assert(performance.now() - started < BUDGET.totalWallMs, "OVERALL_WALL");
    output.write(`stage${stage}-input.json`, definitions[stage]);
    return runStage(stage, definitions[stage], references[stage], started + BUDGET.totalWallMs, output);
  }, async (stage, result) => { output.write(`stage${stage}-result.json`, result); });
  pins();
  const aggregate = { status: results.length === 3 && results.every(r => r.status === "PASS") ? "PASS" : "FAIL",
    stages: results.map(r => ({ stage: r.stage, status: r.status, fault: r.fault, error: r.error })),
    browserLaunches: results.length, retries: 0, wallMs: performance.now() - started,
    correctness: "all observed prefixes compared post-browser to real Node hub; counts alone never suffice",
    performance: "Browser/Node differences are not product failure thresholds", GateB2B: "HOLD" };
  writeAggregate(output, aggregate);
  process.exitCode = aggregateExitCode(aggregate);
  } catch (error) {
    const failure = recordFailure(output, error);
    console.error(JSON.stringify(failure)); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--run")
  await main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify(recordFailure(null, error))); process.exitCode = 1;
  });
