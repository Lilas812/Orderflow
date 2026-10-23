// Existing Chromium + native CDP pipe only. No dependencies, external URLs or application timers.
// Offline codec capacity: node .../baseline13-driver.mjs [new output.json] capacity
// Legacy browser preflight entry remains separate; never invoked by capacity/tests.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile, lstat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

/** Independent v3 decoder. The wire contract is canonical, minified JSON.
 * Parse/stringify identity rejects duplicate keys (including escaped aliases),
 * alternate number spellings, nonfinite JSON numbers and noncanonical ordering.
 */
export function decodeCompactMeaning(wire) {
  const started = performance.now(), wireBytes = Buffer.byteLength(wire, "utf8");
  assert(wireBytes <= 65536, "DIAGNOSTIC_SEMANTIC_LIMIT");
  const p = JSON.parse(wire);
  assert(JSON.stringify(p) === wire, "COMPACT_NONCANONICAL_OR_DUPLICATE_KEY");
  assert.deepEqual(Object.keys(p), ["version", "serializer", "legacyBytes", "cellCount", "schemas", "rows", "body", "sha256"],
    "COMPACT_ENVELOPE_FIELDS");
  assert(p.version === 3 && p.serializer === "legacy-json-v1", "COMPACT_VERSION");
  assert(Number.isSafeInteger(p.legacyBytes) && p.legacyBytes > 0, "COMPACT_LEGACY_BYTES");
  assert(typeof p.sha256 === "string" && /^[a-f0-9]{64}$/.test(p.sha256), "COMPACT_HASH_FORMAT");
  const fields = ["side", "binId", "width", "startNs", "endNs", "coveredDuration",
    "coverageRatio", "partialTWA", "integralQuantityNs", "status", "twa"];
  assert(p.cellCount === 512 && Array.isArray(p.rows) && p.rows.length === 512, "COMPACT_CELL_COUNT");
  assert(Array.isArray(p.schemas) && p.schemas.length > 0 && p.schemas.length <= 512, "COMPACT_SCHEMAS");
  const signatures = new Set();
  for (const keys of p.schemas) {
    assert(Array.isArray(keys) && keys.length === fields.length && new Set(keys).size === fields.length &&
      keys.every(k => fields.includes(k)), "COMPACT_CELL_FIELDS");
    const signature = JSON.stringify(keys);
    assert(!signatures.has(signature), "COMPACT_DUPLICATE_SCHEMA"); signatures.add(signature);
  }
  assert(p.body?.frame?.heatmap?.cells === null, "COMPACT_CELL_PLACEHOLDER");
  const used = new Set();
  const cells = p.rows.map(row => {
    assert(Array.isArray(row) && row.length === fields.length + 1, "COMPACT_ROW_ARITY");
    const id = row[0];
    assert(Number.isSafeInteger(id) && id >= 0 && id < p.schemas.length, "COMPACT_SCHEMA_ID");
    if (!used.has(id)) { assert.equal(id, used.size, "COMPACT_SCHEMA_ORDER"); used.add(id); }
    const cell = Object.fromEntries(p.schemas[id].map((key, i) => [key, row[i + 1]]));
    assert((cell.side === "BID" || cell.side === "ASK") && Number.isSafeInteger(cell.binId) &&
      Number.isSafeInteger(cell.width) && cell.width > 0, "COMPACT_CELL_TYPES");
    for (const key of ["startNs", "endNs", "coveredDuration", "integralQuantityNs"])
      assert(typeof cell[key] === "string" && /^-?(0|[1-9][0-9]*)$/.test(cell[key]), "COMPACT_CELL_TYPES");
    assert(typeof cell.coverageRatio === "number" && cell.coverageRatio >= 0 && cell.coverageRatio <= 1 &&
      (cell.partialTWA === null || typeof cell.partialTWA === "number") &&
      (cell.status === "VALID" ? typeof cell.twa === "number" : cell.status === "NO DATA" && cell.twa === null),
    "COMPACT_CELL_TYPES");
    return cell;
  });
  assert.equal(used.size, p.schemas.length, "COMPACT_UNUSED_SCHEMA");
  p.body.frame.heatmap.cells = cells;
  const text = JSON.stringify(p.body), legacyBytes = Buffer.byteLength(text, "utf8");
  assert.equal(legacyBytes, p.legacyBytes, "COMPACT_RESTORED_BYTES");
  const restored = performance.now();
  const sha256 = createHash("sha256").update(text).digest("hex");
  assert.equal(sha256, p.sha256, "COMPACT_SHA256_MISMATCH");
  return { value: p.body, text, sha256, legacyBytes, wireBytes,
    metrics: { restoreMs: restored - started, sha256Ms: performance.now() - restored } };
}
function sameOrderedJson(a, b) {
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameOrderedJson(a[k], b[k]));
}
/** Trusted local legacy reference required: digest agreement alone is NOT proof. */
export function verifyCompactMeaning(wire, reference) {
  const decoded = decodeCompactMeaning(wire), started = performance.now();
  const expected = JSON.parse(reference);
  assert(isDeepStrictEqual(decoded.value, expected), "COMPACT_STRUCTURE_MISMATCH");
  assert(sameOrderedJson(decoded.value, expected), "COMPACT_FIELD_ORDER");
  assert(decoded.text === reference, "COMPACT_LEGACY_BYTE_MISMATCH");
  assert.equal(decoded.sha256, createHash("sha256").update(reference).digest("hex"), "COMPACT_REFERENCE_HASH");
  return { ...decoded, verified: { structure: true, fieldAndArrayOrder: true, bytes: true, sha256: true },
    comparisonMs: performance.now() - started };
}

const EVIDENCE_LIMIT = 2 * 1024 * 1024;
const ROW_KEYS = ["stage", "at", "ms", "revision", "seq", "layer", "a", "b", "c"];
const digest = text => createHash("sha256").update(text).digest("hex");

/** Normalized legacy JSON, not native undefined/Map/BigInt identity.
 * Only numeric diagnostic rows are replaced; every other field stays in body.
 */
export function encodeEvidence(value) {
  const original = JSON.stringify(value), body = JSON.parse(original), tables = [];
  function walk(v, path) {
    if (!v || typeof v !== "object") return;
    if (!Array.isArray(v) && Object.hasOwn(v, "allocatedBytes") && Array.isArray(v.rows)) {
      const rows = v.rows;
      assert(rows.length <= 2048, "EVIDENCE_ROW_LIMIT");
      const tuples = rows.map(row => {
        assert.deepEqual(Object.keys(row), ROW_KEYS, "EVIDENCE_ROW_SCHEMA");
        return ROW_KEYS.map(k => row[k]);
      });
      tables.push({ path: [...path, "rows"], count: rows.length, sha256: digest(JSON.stringify(rows)), tuples });
      v.rows = null;
    }
    for (const key of Object.keys(v)) walk(v[key], [...path, key]);
  }
  walk(body, []);
  return JSON.stringify({ version: 1, serializer: "legacy-json-v1", rowKeys: ROW_KEYS,
    legacyBytes: Buffer.byteLength(original), sha256: digest(original), tables, body });
}

export function decodeEvidence(wire, reference) {
  const p = JSON.parse(wire);
  assert.equal(JSON.stringify(p), wire, "EVIDENCE_NONCANONICAL");
  assert.deepEqual(Object.keys(p), ["version", "serializer", "rowKeys", "legacyBytes", "sha256", "tables", "body"]);
  assert(p.version === 1 && p.serializer === "legacy-json-v1", "EVIDENCE_VERSION");
  assert.deepEqual(p.rowKeys, ROW_KEYS, "EVIDENCE_ROW_SCHEMA");
  assert(Array.isArray(p.tables), "EVIDENCE_TABLES");
  const paths = new Set();
  for (const t of p.tables) {
    assert.deepEqual(Object.keys(t), ["path", "count", "sha256", "tuples"]);
    assert(Array.isArray(t.path) && t.path.length > 0 && t.path.at(-1) === "rows", "EVIDENCE_PATH");
    const key = JSON.stringify(t.path); assert(!paths.has(key), "EVIDENCE_DUPLICATE_PATH"); paths.add(key);
    let parent = p.body;
    for (const component of t.path.slice(0, -1)) {
      assert(typeof component === "string" && parent && Object.hasOwn(parent, component), "EVIDENCE_PATH");
      parent = parent[component];
    }
    assert(parent && Object.hasOwn(parent, "allocatedBytes") && parent.rows === null, "EVIDENCE_PLACEHOLDER");
    assert(Number.isSafeInteger(t.count) && t.count >= 0 && t.count <= 2048 &&
      Array.isArray(t.tuples) && t.tuples.length === t.count, "EVIDENCE_ROW_COUNT");
    const rows = t.tuples.map(tuple => {
      assert(Array.isArray(tuple) && tuple.length === ROW_KEYS.length, "EVIDENCE_ROW_ARITY");
      return Object.fromEntries(ROW_KEYS.map((k, i) => [k, tuple[i]]));
    });
    assert.equal(digest(JSON.stringify(rows)), t.sha256, "EVIDENCE_ROW_HASH");
    parent.rows = rows;
  }
  const text = JSON.stringify(p.body);
  assert.equal(Buffer.byteLength(text), p.legacyBytes, "EVIDENCE_BYTES");
  assert.equal(digest(text), p.sha256, "EVIDENCE_HASH");
  assert.equal(encodeEvidence(p.body), wire, "EVIDENCE_SCHEMA_OR_TABLE_ORDER");
  if (reference !== undefined) {
    const trusted = JSON.stringify(reference);
    assert(sameOrderedJson(p.body, JSON.parse(trusted)) && text === trusted, "EVIDENCE_REFERENCE");
    assert.equal(digest(trusted), p.sha256, "EVIDENCE_REFERENCE_HASH");
  }
  return { value: p.body, text, sha256: p.sha256 };
}

export function boundedEvidence(value) {
  const wire = encodeEvidence(value);
  decodeEvidence(wire, value);
  assert(Buffer.byteLength(wire + "\n") <= EVIDENCE_LIMIT, "REPORT_SIZE_LIMIT");
  return wire + "\n";
}

export function comparisonPlan(workload, phase) {
  assert(["preflight", "formal"].includes(phase), "COMPARISON_PHASE");
  const cases = phase === "formal" ? ["cells128", "cells512"] : [workload];
  assert(phase !== "formal" || workload === "both", "FORMAL_REQUIRES_BOTH_CASES");
  cases.forEach(browserCasePolicy);
  return cases.flatMap(w => Array.from({ length: phase === "formal" ? 3 : 1 }, (_, i) =>
    ["control", "on"].map(mode => ({ id: `${w}-${i + 1}-${mode}`, workload: w, mode, repetition: i + 1 }))).flat());
}

export function timeStats(samples) {
  assert(samples.every(v => typeof v === "number" && Number.isFinite(v)), "TIME_SAMPLE");
  const a = [...samples].sort((x, y) => x - y), n = a.length;
  if (!n) return { status: "UNKNOWN", n: 0 };
  return { status: "MEASURED", n, mean: a.reduce((s, v) => s + v, 0) / n,
    median: n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2,
    p95: a[Math.ceil(n * .95) - 1], max: a[n - 1],
    note: "nearest-rank p95; finite samples, not a stable tail-latency guarantee" };
}

export function samplePhase(row) {
  // React c is its explicit mount flag; all other rows use public revision.
  return row.revision <= 0 || (row.stage === "react" && row.c === 1)
    ? "initialization" : "steady";
}

export function timingSamples(runs) {
  const groups = {};
  const add = (r, name, value) => {
    assert(Number.isFinite(value) && (value >= 0 || name.endsWith("TimerDelay")), `INVALID_TIME:${name}`);
    (groups[`${samplePhase(r)}:${name}`] ??= []).push(value);
  };
  for (const run of runs) {
    if (run.mode !== "on" || !run.telemetry) continue;
    for (const r of run.telemetry.rows) {
      if (r.stage === "ingest" || r.stage === "publish")
        assert(Number.isFinite(r.a) && Number.isFinite(r.b), "TIMER_TIMESTAMP_UNKNOWN");
      if (r.stage === "ingest") { add(r, "ingestSync", r.ms); add(r, "inputTimerDelay", r.b - r.a); }
      if (r.stage === "publish") add(r, "noticeTimerDelay", r.b - r.a);
      if (r.stage === "frame") add(r, r.a === 1 ? "frameHIT" : "frameMISS", r.ms);
      if (r.stage === "react") add(r, `react:${r.layer}`, r.ms);
      if (r.stage === "draw") add(r, `drawCPU:${r.layer}`, r.ms);
      if (r.stage === "raf") add(r, `rAFWait:${r.layer}`, r.ms);
    }
  }
  return groups;
}

export function summarizeRuns(runs) {
  const summarize = subset => {
    const samples = timingSamples(subset);
    const names = ["ingestSync", "inputTimerDelay", "noticeTimerDelay", "frameMISS", "frameHIT",
      ...["root", "heatmap", "bubble", "delta", "vp"].map(l => `react:${l}`),
      ...["heatmap", "bubble", "delta"].map(l => `drawCPU:${l}`),
      ...["heatmap", "bubble"].map(l => `rAFWait:${l}`)];
    for (const phase of ["initialization", "steady"]) for (const name of names) samples[`${phase}:${name}`] ??= [];
    return { times: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, timeStats(v)])),
      phaseDefinition: "initialization: revision <= 0 or explicit React mount c=1; steady: other positive revisions",
      timerDefinition: "signed entered-minus-scheduled offset, including early (<0) callbacks; no clamping",
      missingTimes: "UNKNOWN, never zero; especially OFF internals and absent frame HITs",
      completionMs: timeStats(subset.map(r => r.completionObservedMs).filter(Number.isFinite)),
      completionDefinition: "Includes 300ms input cadence and driver DOM polling; not pure processing throughput",
      glCountTotals: Object.fromEntries(["heatmap", "bubble"].map(layer => [layer,
        Object.fromEntries(["draws", "vertices", "uploads", "bytes"].map(key => [key,
          subset.length && subset.every(r => Number.isFinite(r.gl?.totals?.[layer]?.[key]))
            ? subset.reduce((n, r) => n + r.gl.totals[layer][key], 0) : "UNKNOWN"]))])),
      gl: subset.map(r => ({ mode: r.mode, observation: r.gl?.observation ?? "PERFORMANCE_OBSERVER",
        performanceComparable: r.mode === "on", totals: r.gl?.totals ?? "UNKNOWN",
        phases: r.mode === "on" && r.gl?.frames ? Object.fromEntries(["initialization", "steady"].map(phase => [phase,
          Object.fromEntries(["heatmap", "bubble"].map(layer => [layer,
            Object.fromEntries(["draws", "vertices", "uploads", "bytes"].map(key => [key,
              r.gl.frames.filter(f => (f.revision <= 0 ? "initialization" : "steady") === phase)
                .reduce((n, f) => n + f.layers[layer][key], 0)]))]))])) : "UNKNOWN" })) };
  };
  const cases = Object.fromEntries(["cells128", "cells512"].map(w => [w, {
      on: summarize(runs.filter(r => r.workload === w && r.mode === "on" && !r.failed)),
      off: summarize(runs.filter(r => r.workload === w && r.mode !== "on" && !r.failed)) }]));
  return { trials: runs.map(r => ({ workload: r.workload, mode: r.mode, repetition: r.repetition, ...summarize([r]) })),
    cases, pooling: "Case times pool all successful ON samples; inspect individual trials too",
    meanRatios512over128: Object.fromEntries(Object.keys(cases.cells128.on.times).map(k => {
      const a = cases.cells128.on.times[k], b = cases.cells512.on.times[k];
      return [k, a.status === "MEASURED" && b?.status === "MEASURED" && a.mean > 0 ? b.mean / a.mean : "UNKNOWN"];
    })),
    gpuMs: "UNKNOWN", presentationAt: "UNKNOWN", physicalGPU: "UNKNOWN", heap: "UNKNOWN", rss: "UNKNOWN", gc: "UNKNOWN" };
}

export function validateFormalTrial(t, job) {
  assert(!t.failed && !["FAIL", "HOLD", "UNKNOWN"].includes(t.status), "TRIAL_NOT_PASS");
  assert.equal(t.workload, job.workload); assert.equal(t.mode, job.mode); assert.equal(t.repetition, job.repetition);
  assert.deepEqual(t.counts, { inputs: 128, accepted: 128, duplicate: 0, rejected: 0 });
  assert.equal(t.revision, 128); assert(t.layerRevisions.length === 6 && t.layerRevisions.every(r => r === 128));
  assert(t.golden.length === 8 && t.golden.every(g => g.ok), "GOLDEN_MISMATCH");
  assert(typeof t.meaningHash === "string" && /^[a-f0-9]{64}$/.test(t.meaningHash), "MISSING_HASH");
  assert(t.meaningEncoding.wireBytes <= 65536, "DIAGNOSTIC_SEMANTIC_LIMIT");
  assert.equal(t.afterReleaseGate?.status, "PASS", "RESOURCE_GATE");
  assert(t.chromiumCleanup?.live.length === 0 && t.chromiumCleanup.zombies.length === 0 &&
    t.chromiumCleanup.profileRemoved, "CHROMIUM_REMAINING");
  assert(Object.values(t.afterReleaseGL).every(c => c.buffers === c.deletes), "BUFFER_NOT_RELEASED");
  assert(!t.gl.limited && t.gl.unrecordedApiCalls === 0, "GL_RECORD_LIMIT");
  for (const layer of ["heatmap", "bubble"]) {
    assert.equal(t.viewport[layer].status, "READY");
    assert.equal(t.gl.totals[layer].errors, 0);
    assert(t.gl.totals[layer].loss === 0 && t.gl.totals[layer].restore === 0, "CONTEXT_EVENT_DURING_COMPARISON");
    assert.equal(t.gl.lastDraws[layer].revision, 128);
    assert.equal(t.gl.lastDraws[layer].vertices,
      layer === "heatmap" ? (job.workload === "cells128" ? 128 : 512) * 6 : t.viewport.bubble.vertices);
  }
  if (job.mode === "on") {
    assert(t.telemetry.sessionId === 1 && t.telemetry.dropped === 0 && !t.telemetry.saturated &&
      t.telemetry.records < 2048 && t.telemetry.allocatedBytes === 147456, "NUMERIC_RECORD_LIMIT");
  } else {
    assert(t.telemetry === null && t.gl.observation === "OFF_SAFETY_ONLY", "OFF_NOT_SAFETY_ONLY");
    assert(Object.values(t.gl.totals).every(c => c.contexts > 0 && c.errorChecks > 0 &&
      c.cpuMs === "UNKNOWN"), "OFF_SAFETY_NOT_OBSERVED");
  }
}

export function comparisonEnvironment(t) {
  assert(typeof t.chromium === "string" && t.gpu?.webgl2 === true &&
    /SwiftShader/.test(t.gpu.renderer), "ENVIRONMENT_UNKNOWN_OR_NOT_SWIFTSHADER");
  const v = t.viewport, p = v.viewport;
  assert(Number.isFinite(p.dpr) && p.dpr > 0, "DPR_UNKNOWN");
  assert([v.heatmap.width, v.heatmap.height, v.bubble.width, v.bubble.height].every(x =>
    Number.isFinite(x) && x > 0), "CANVAS_SIZE_UNKNOWN");
  assert(t.completionLimitMs === 44400 && t.browserLimitMs === 59400, "WAIT_CONDITION_MISMATCH");
  return JSON.stringify({ chromium: t.chromium, gpu: t.gpu, dpr: p.dpr,
    canvas: [v.heatmap.width, v.heatmap.height, v.bubble.width, v.bubble.height],
    bounds: p.bounds, time: p.time, price: p.price,
    inputEveryMs: 300, completionLimitMs: t.completionLimitMs, browserLimitMs: t.browserLimitMs,
    profiler: "same existing development React Profiler boundaries",
    timers: "same D2 ownership observer; no forced HMR cancellation",
    on: "v2/v3 common numeric collector; v3 semantic export outside timed samples",
    off: "constant safety counters, not GL performance measurements" });
}

/** Injectable runner/checkpoint for offline protocol tests; no automatic retry. */
export async function executeComparison(plan, runTrial, checkpoint) {
  assert.deepEqual(plan, comparisonPlan("both", "formal"), "FORMAL_PLAN_INVALID");
  const report = { phase: "formal", plan, runs: [], failure: null, status: "RUNNING" };
  let environment;
  for (const job of plan) {
    let trial;
    try {
      trial = await runTrial({ ...job });
      assert(trial && typeof trial === "object", "MISSING_TRIAL");
      report.runs.push(trial);
      validateFormalTrial(trial, job);
      const observedEnvironment = comparisonEnvironment(trial);
      if (environment === undefined) environment = observedEnvironment;
      assert.equal(observedEnvironment, environment, "COMPARISON_ENVIRONMENT_MISMATCH");
      const peers = report.runs.filter(r => r.workload === job.workload);
      assert(peers.every(r => r.meaningHash === trial.meaningHash), "ON_OFF_MEANING_HASH_MISMATCH");
      await checkpoint(report, trial, job);
    } catch (error) {
      if (!trial) report.runs.push(trial = { ...(error.partialResult ?? {}), ...job, failed: true });
      trial.failed = true;
      report.failure = String(error); report.status = "HOLD";
      // Checkpoint must preserve the failed trial separately even if aggregate is full.
      await checkpoint(report, trial, job);
      return report;
    }
  }
  report.status = "PASS";
  return report;
}

/** Per-trial files and the all-trial aggregate EACH retain the old 2MiB file limit.
 * On aggregate overflow a HOLD manifest references preserved trial files; it is
 * explicitly NOT a successful complete aggregate or a bypass of that limit.
 */
async function formalComparison(output) {
  const plan = comparisonPlan("both", "formal"), trialDir = output + ".trials", refs = [];
  try { await lstat(output); throw Error("OUTPUT_ALREADY_EXISTS"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  await mkdir(trialDir, { recursive: true });
  assert.equal((await readdir(trialDir)).length, 0, "TRIAL_DIRECTORY_NOT_EMPTY");
  let reference, lastWire;
  const report = await executeComparison(plan, async job => {
    if (job.workload === "cells512" && !reference) reference = await capacityOnly(undefined, true);
    return browserRun(job.mode, job.repetition, false, job.workload, reference);
  }, async (r, trial, job) => {
    const file = `${job.id}-${r.failure ? "failed" : "completed"}.json`;
    let trialWire;
    try { trialWire = boundedEvidence({ job, trial, failure: r.failure }); }
    catch (e) {
      if (!r.failure) throw e;
      trialWire = boundedEvidence({ status: "HOLD", job, failure: r.failure, fullTrialAvailable: false,
        note: "Trial itself cannot be saved losslessly within its file budget. No successful evidence claim.",
        normalizedTrialSha256: digest(JSON.stringify(trial)) });
    }
    await writeFile(resolve(trialDir, file), trialWire, { flag: "wx" });
    refs.push({ file, bytes: Buffer.byteLength(trialWire), sha256: digest(trialWire) });
    r.evidenceLimits = { perTrialFile: EVIDENCE_LIMIT, completeAggregateFile: EVIDENCE_LIMIT,
      directorySumIsNotTheAggregateLimit: true };
    r.trialFiles = refs;
    r.summary = summarizeRuns(r.runs.filter(s => !s.failed));
    r.summary.failedTrialsNotUsedForCompleteStatistics = r.runs.filter(s => s.failed).map(s => ({
      workload: s.workload, mode: s.mode, repetition: s.repetition, failure: r.failure }));
    try { lastWire = boundedEvidence(r); }
    catch (e) {
      if (!r.failure) throw e;
      lastWire = boundedEvidence({ status: "HOLD", failure: r.failure, aggregateAvailable: false,
        note: "Complete aggregate exceeded capacity or was invalid. No trial omitted from the preserved file index.",
        plan, trialFiles: refs });
    }
  });
  if (report.status === "PASS") lastWire = boundedEvidence(report);
  await writeFile(output, lastWire, { flag: "wx" });
  if (report.failure) { process.exitCode = 1; console.error(report.failure); }
}

export function browserCasePolicy(workload) {
  assert(["baseline13", "cells128", "cells512"].includes(workload), "CASE_NOT_APPROVED_FOR_THIS_FUNCTIONAL_VERIFICATION");
  return { version: workload === "baseline13" ? 1 : workload === "cells128" ? 2 : 3,
    compactGL: workload !== "baseline13", method: workload === "cells512" ? "compactMeaning" : "meaning" };
}
export function browserReadoutExpression(workload) {
  const policy = browserCasePolicy(workload);
  const body = `({meaning:${policy.version === 3 ? "await " : ""}window.__orderflowMockDiagnostics.${policy.method}(),
      telemetry:window.__orderflowMockDiagnostics.snapshot(),gl:window.__b2gl?.snapshot(),
      errors:[...document.querySelectorAll('[role="alert"]')].map(e=>e.textContent)})`;
  return policy.version === 3 ? `(async()=>${body})()` : body;
}
export function resolveBrowserMeaning(workload, wire, reference) {
  const policy = browserCasePolicy(workload);
  assert(typeof wire === "string", "MISSING_MEANING");
  if (policy.version === 3) {
    assert(typeof reference === "string", "MISSING_INDEPENDENT_LEGACY_REFERENCE");
    return verifyCompactMeaning(wire, reference);
  }
  const bytes = Buffer.byteLength(wire, "utf8");
  assert(bytes <= 65536, "DIAGNOSTIC_SEMANTIC_LIMIT");
  return { text: wire, value: JSON.parse(wire), wireBytes: bytes, legacyBytes: bytes,
    sha256: createHash("sha256").update(wire).digest("hex"), verified: null };
}

/** OFF only: constant counters, no performance.now, active token, row log or extra GL calls. */
export function installSafetyGLObserver() {
  const proto = WebGL2RenderingContext.prototype, saved = new Map(), contexts = new WeakMap(), listeners = [];
  const totals = Object.fromEntries(["heatmap", "bubble"].map(layer => [layer, {
    contexts: 0, draws: 0, vertices: 0, uploads: 0, bytes: 0, buffers: 0, deletes: 0,
    errors: 0, errorChecks: 0, loss: 0, restore: 0, cpuMs: "UNKNOWN",
  }]));
  const lastDraws = {};
  let limited = false;
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const gl = nativeGetContext.apply(this, args);
    const layer = this.classList.contains("hm-canvas") ? "heatmap" : this.classList.contains("bb-canvas") ? "bubble" : null;
    if (args[0] === "webgl2" && gl && layer && !contexts.has(gl)) {
      if (listeners.length === 16) { limited = true; return gl; }
      contexts.set(gl, { layer, canvas: this, uploadedBytes: 0 }); totals[layer].contexts++;
      const lost = () => totals[layer].loss++, restored = () => totals[layer].restore++;
      this.addEventListener("webglcontextlost", lost); this.addEventListener("webglcontextrestored", restored);
      listeners.push([this, lost, restored]);
    }
    return gl;
  };
  for (const name of ["createBuffer", "deleteBuffer", "bufferData", "drawArrays", "getError"]) {
    const original = proto[name]; saved.set(name, original);
    proto[name] = function (...args) {
      const value = original.apply(this, args), info = contexts.get(this);
      if (!info) return value;
      const c = totals[info.layer];
      if (name === "createBuffer" && value) c.buffers++;
      if (name === "deleteBuffer" && args[0]) c.deletes++;
      if (name === "bufferData") {
        info.uploadedBytes = typeof args[1] === "number" ? args[1] : args[1]?.byteLength ?? 0;
        c.uploads++; c.bytes += info.uploadedBytes;
      }
      if (name === "drawArrays") {
        c.draws++; c.vertices += args[2];
        const marker = info.canvas.dataset?.revision;
        lastDraws[info.layer] = { revision: marker !== undefined && marker !== "" ? Number(marker) : -1,
          vertices: args[2], uploadedBytes: info.uploadedBytes, revisionSource: "CANVAS_COMMIT_MARKER" };
      }
      if (name === "getError") { c.errorChecks++; if (value !== 0) c.errors++; }
      return value;
    };
  }
  window.__b2gl = {
    snapshot: () => ({ version: 0, observation: "OFF_SAFETY_ONLY", totals, lastDraws,
      limited, unrecordedApiCalls: limited ? 1 : 0 }),
    dispose() {
      for (const [name, fn] of saved) proto[name] = fn;
      HTMLCanvasElement.prototype.getContext = nativeGetContext;
      for (const [canvas, lost, restored] of listeners) {
        canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", restored);
      }
      listeners.length = 0; saved.clear(); delete window.__b2gl;
    },
  };
}

export function resourceReleaseGate(snapshot, ownership, requireRaf = true) {
  if (!ownership || !Array.isArray(ownership.records) || !Array.isArray(ownership.initial) ||
    !snapshot || !Number.isSafeInteger(snapshot.intervals) || !Number.isSafeInteger(snapshot.raf) ||
    snapshot.intervals !== ownership.records.length)
    return { status: "HOLD", reason: "RESOURCE_OWNERSHIP_UNAVAILABLE" };
  const owned = ownership.records.filter(r => r.owner === "APP" || r.owner === "SESSION");
  if (owned.length) return { status: "FAIL", reason: "OWNED_INTERVAL_REMAINING", tokens: owned.map(r => r.token) };
  if (!ownership.baselineRecorded || ownership.limited || ownership.unrecorded || ownership.unknownCreations ||
    ownership.records.some(r => r.owner !== "BACKGROUND" || !r.sameInitialIdentity ||
      !ownership.initial.some(i => i.token === r.token && i.nativeId === r.nativeId && i.source === r.source &&
        i.owner === "BACKGROUND" && i.createdBeforeFirstStart)))
    return { status: "HOLD", reason: "RESOURCE_OWNERSHIP_UNKNOWN" };
  if (requireRaf && snapshot.raf !== 0) return { status: "HOLD", reason: "RAF_OWNERSHIP_UNKNOWN" };
  return { status: "PASS", reason: "NO_OWNED_OR_UNKNOWN_INTERVAL_REMAINS",
    unchangedBackground: ownership.records.map(r => r.token) };
}

function installResourceObserver() {
  const names = ["setInterval", "clearInterval", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"];
  const saved = Object.fromEntries(names.map(k => [k, window[k]])), intervals = new Map(), raf = new Set();
  // Live identities, not a rolling event trace. Overflow is explicit and permanently HOLD.
  const limit = 64, sourceLimit = 256, stackLimit = 8192, baseline = new Set();
  let sequence = 0, session = 0, initial = [], baselineRecorded = false, limited = false, unrecorded = 0;
  let created = 0, cleared = 0, unknownCreations = 0;
  function provenance() {
    const stack = new Error().stack;
    if (typeof stack !== "string" || stack.length > stackLimit)
      return { hint: "UNKNOWN", source: null, reason: "STACK_UNAVAILABLE_OR_OVER_BUDGET" };
    for (const line of stack.split("\n")) {
      const m = line.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
      if (!m) continue;
      try {
        const url = new URL(m[1]);
        if (url.origin !== window.location.origin || url.pathname.length > sourceLimit)
          return { hint: "UNKNOWN", source: null, reason: "SOURCE_OUTSIDE_OBSERVED_ORIGIN_OR_BUDGET" };
        const source = url.pathname, lineNumber = Number(m[2]), column = Number(m[3]);
        if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column))
          return { hint: "UNKNOWN", source: null, reason: "INVALID_SOURCE_POSITION" };
        // Only exact, inspected module paths establish ownership; never a callback-name guess.
        const hint = source === "/@vite/client" ? "VITE_HMR" :
          source === "/src/lib/mockAnalysisSession.ts" ? "SESSION" :
          source === "/src/hooks/useMockAnalysisSession.ts" ? "APP" : "UNKNOWN";
        return { hint, source, line: lineNumber, column, reason: hint === "UNKNOWN" ? "SOURCE_NOT_CLASSIFIED" : "EXACT_MODULE_PATH" };
      } catch { return { hint: "UNKNOWN", source: null, reason: "SOURCE_PARSE_FAILED" }; }
    }
    return { hint: "UNKNOWN", source: null, reason: "NO_MODULE_SOURCE" };
  }
  const record = r => ({ ...r, owner: r.hint === "VITE_HMR" ?
    baseline.has(r.token) && r.createdBeforeFirstStart ? "BACKGROUND" : "UNKNOWN" : r.hint,
    sameInitialIdentity: baseline.has(r.token) });
  window.setInterval = function (...args) {
    const p = provenance(), id = saved.setInterval.apply(window, args);
    created++;
    if (p.hint === "UNKNOWN" || (p.hint === "VITE_HMR" && baselineRecorded)) unknownCreations++;
    if (intervals.size === limit || intervals.has(id) || !Number.isSafeInteger(sequence + 1)) {
      limited = true; unrecorded++; return id; // Native execution is untouched; observation is incomplete.
    }
    intervals.set(id, { token: ++sequence, nativeId: typeof id === "number" ? id : null, ...p,
      createdBeforeFirstStart: !baselineRecorded, session });
    return id;
  };
  for (const name of ["clearInterval", "clearTimeout"]) window[name] = function (id) {
    const result = saved[name].call(window, id);
    if (intervals.delete(id)) cleared++;
    return result;
  };
  window.requestAnimationFrame = function (fn) {
    const id = saved.requestAnimationFrame.call(window, function (t) { raf.delete(id); return fn.call(this, t); });
    if (raf.size === limit) { limited = true; unrecorded++; } else raf.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) { raf.delete(id); return saved.cancelAnimationFrame.call(window, id); };
  window.__b2resources = { snapshot: () => ({ intervals: intervals.size, raf: raf.size }),
    beginSession(next) {
      if (!baselineRecorded) {
        for (const r of intervals.values()) if (r.hint === "VITE_HMR") baseline.add(r.token);
        initial = [...intervals.values()].map(record);
        baselineRecorded = true;
      }
      session = next;
    },
    ownership: () => ({ limit, sourceLimit, stackLimit, baselineRecorded, limited, unrecorded, unknownCreations,
      created, cleared, initial: initial.map(r => ({ ...r })), records: [...intervals.values()].map(record),
      scope: "Top-level window setInterval; clearInterval/clearTimeout shared IDs; RAF live IDs. No workers, child realms, setTimeout callbacks or pre-captured native aliases. Only bounded source path/position, no raw stack/callback/arguments." }),
    dispose() { Object.assign(window, saved); delete window.__b2resources; } };
}
async function browserGroup(pgid) {
  const live = [], zombies = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let text;
    try { text = await readFile(`/proc/${name}/stat`, "utf8"); }
    catch (e) { if (e.code === "ENOENT" || e.code === "ESRCH") continue; throw e; }
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pgid) (fields[0] === "Z" || fields[0] === "X" ? zombies : live).push(Number(name));
  }
  return { live, zombies };
}

function installGLObserver(compact = false, commitMarkers = false) {
  const proto = WebGL2RenderingContext.prototype, saved = new Map(), contexts = new WeakMap(), listeners = [];
  const counters = () => ({
    draws: 0, vertices: 0, uploads: 0, bytes: 0, buffers: 0, deletes: 0, loss: 0, restore: 0, errors: 0, cpuMs: 0,
  });
  const totals = Object.fromEntries(["heatmap", "bubble"].map(l => [l, counters()]));
  const draws = [], frames = [], frameIndex = new Map(), lastDraws = {};
  let limited = false, unrecordedApiCalls = 0;
  // v2: at most 256 revision records, each with two fixed layer counter sets.
  // Revision -1 explicitly means no matching active draw token, not an inferred DOM revision.
  function frameCounters(revision, layer) {
    if (!compact) return null;
    let entry = frameIndex.get(revision);
    if (!entry) {
      if (frames.length === 256) { limited = true; unrecordedApiCalls++; return null; }
      entry = { revision, layers: { heatmap: counters(), bubble: counters() } };
      frames.push(entry); frameIndex.set(revision, entry);
    }
    return entry.layers[layer];
  }
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const gl = getContext.apply(this, args);
    const layer = this.classList.contains("hm-canvas") ? "heatmap" : this.classList.contains("bb-canvas") ? "bubble" : null;
    if (args[0] === "webgl2" && gl && layer && !contexts.has(gl)) {
      if (listeners.length === 16) { limited = true; return gl; }
      const info = { layer, last: null, canvas: this, uploadedBytes: 0 }; contexts.set(gl, info);
      const lost = () => { totals[layer].loss++; const f = frameCounters(-1, layer); if (f) f.loss++; };
      const restored = () => { totals[layer].restore++; const f = frameCounters(-1, layer); if (f) f.restore++; };
      this.addEventListener("webglcontextlost", lost); this.addEventListener("webglcontextrestored", restored);
      listeners.push([this, lost, restored]);
    }
    return gl;
  };
  const methods = ["viewport", "clearColor", "clear", "enable", "blendFunc", "useProgram", "bindVertexArray",
    "bindBuffer", "bufferData", "uniform2f", "drawArrays", "getError", "createBuffer", "deleteBuffer",
    "createVertexArray", "deleteVertexArray", "getUniformLocation", "getAttribLocation", "compileShader",
    "shaderSource", "getShaderParameter", "createShader", "attachShader", "linkProgram", "createProgram",
    "getProgramParameter", "vertexAttribPointer", "enableVertexAttribArray", "deleteShader", "deleteProgram"];
  for (const name of methods) {
    const original = proto[name]; if (typeof original !== "function") continue;
    saved.set(name, original);
    proto[name] = function (...args) {
      const info = contexts.get(this);
      if (!info) return original.apply(this, args);
      const token = window.__orderflowMockDiagnostics?.activeDraw(), t = performance.now();
      const value = original.apply(this, args), ms = performance.now() - t, total = totals[info.layer];
      total.cpuMs += ms;
      const marker = commitMarkers ? info.canvas.dataset?.revision : undefined;
      const tokenMatches = token?.layer === info.layer;
      const revision = tokenMatches ? token.revision :
        marker !== undefined && marker !== "" && Number.isSafeInteger(Number(marker)) ? Number(marker) : -1;
      const f = frameCounters(revision, info.layer);
      if (f) f.cpuMs += ms;
      if (!compact && token && token.layer === info.layer && info.last?.start !== token.start && draws.length < 256) {
        info.last = { layer: info.layer, revision: token.revision, start: token.start, firstGLAt: t,
          preludeUpperMs: t - token.start, apiCpuMs: 0, vertices: 0 };
        draws.push(info.last);
      } else if (!compact && draws.length === 256) limited = true;
      if (token && info.last?.start === token.start) info.last.apiCpuMs += ms;
      let kind = -1, a = 0;
      if (name === "createBuffer" && value) { total.buffers++; if (f) f.buffers++; kind = 1; }
      if (name === "deleteBuffer" && args[0]) { total.deletes++; if (f) f.deletes++; }
      if (name === "bufferData") {
        a = typeof args[1] === "number" ? args[1] : args[1]?.byteLength ?? 0;
        info.uploadedBytes = a;
        total.uploads++; total.bytes += a; kind = 2;
        if (f) { f.uploads++; f.bytes += a; }
      }
      if (name === "drawArrays") {
        a = args[2]; total.draws++; total.vertices += a; kind = 3;
        lastDraws[info.layer] = { revision, vertices: a, uploadedBytes: info.uploadedBytes,
          revisionSource: tokenMatches ? "ACTIVE_DRAW_TOKEN" : commitMarkers ? "CANVAS_COMMIT_MARKER" : "UNKNOWN" };
        if (f) { f.draws++; f.vertices += a; }
        if (token && info.last?.start === token.start) info.last.vertices += a;
      }
      if (name === "getError" && value !== 0) { total.errors++; if (f) f.errors++; kind = 4; a = value; }
      if (kind >= 0) window.__orderflowMockDiagnostics?.gl(info.layer, kind, ms, a, 0);
      return value;
    };
  }
  window.__b2gl = {
    snapshot: () => ({ version: compact ? 2 : 1, limit: 256, totals, draws,
      frames: compact ? frames : undefined, limited, unrecordedApiCalls, lastDraws }),
    dispose() {
      for (const [name, original] of saved) proto[name] = original;
      HTMLCanvasElement.prototype.getContext = getContext;
      for (const [canvas, lost, restored] of listeners) {
        canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", restored);
      }
      saved.clear(); listeners.length = 0;
      draws.length = frames.length = 0; frameIndex.clear();
      delete window.__b2gl;
    },
  };
}

function captureViewport() {
  const root = document.querySelector('[data-testid="unified-controls"]');
  const value = root?.getAttribute("data-diagnostic-viewport");
  if (!value) return null; // baseline uses its unchanged existing surface.
  const vp = JSON.parse(value), b = vp.bounds, p = vp.price;
  const y = tick => b.top + (p.maxTick - tick) / (p.maxTick - p.minTick) * b.height;
  const rows = [...document.querySelectorAll('[data-testid^="vp-level-"]')].map(e => ({
    tick: Number(e.getAttribute("data-tick")), actualY: Number(e.getAttribute("data-y")),
    errorPx: Math.abs(Number(e.getAttribute("data-y")) - y(Number(e.getAttribute("data-tick")))),
  }));
  const h = document.querySelector(".hm-canvas"), bubble = document.querySelector(".bb-canvas");
  return { viewport: vp, source: document.querySelector('[data-testid="text-unified-source"]')?.textContent,
    vpRows: rows, heatmap: h ? { revision: Number(h.dataset.revision), rects: Number(h.dataset.rectCount),
      minNs: h.dataset.drawnMinNs, maxNs: h.dataset.drawnMaxNs, status: h.dataset.status,
      width: h.width, height: h.height } : null,
    bubble: bubble ? { revision: Number(bubble.dataset.revision), vertices: Number(bubble.dataset.vertexCount),
      status: bubble.dataset.status, width: bubble.width, height: bubble.height } : null };
}
async function browserRun(mode, repetition, lifecycle, workload, reference) {
  const policy = browserCasePolicy(workload), observeGL = mode === "on" || workload !== "baseline13";
  const observeResources = workload !== "baseline13", safetyOnly = observeGL && mode !== "on";
  const expectedInputs = workload === "baseline13" ? 13 : 128;
  const completionLimitMs = expectedInputs * 300 + 6000;
  const browserLimitMs = completionLimitMs + 15000;
  const dir = await mkdtemp("/tmp/orderflow-b2b1-browser-");
  const browser = spawn("/repl/tools/bin/chromium", ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run",
    "--no-default-browser-check", `--user-data-dir=${dir}`, "--remote-debugging-pipe"],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let id = 0, buffer = "";
  const pending = new Map();
  browser.stdio[4].on("data", b => {
    buffer += b;
    for (;;) {
      const i = buffer.indexOf("\0"); if (i < 0) break;
      const s = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!s) continue;
      const response = JSON.parse(s), p = pending.get(response.id); if (!p) continue;
      pending.delete(response.id); clearTimeout(p.timer);
      response.error ? p.reject(Error(JSON.stringify(response.error))) : p.resolve(response.result);
    }
  });
  browser.on("exit", () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("BROWSER_EXIT")); } pending.clear(); });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error(`CDP_TIMEOUT:${method}`)); }, 10000);
    pending.set(n, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const hardStop = setTimeout(() => { try { process.kill(-browser.pid, "SIGKILL"); } catch {} }, browserLimitMs);
  let captured;
  let rescue;
  try {
    const version = await call("Browser.getVersion"), target = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const page = (method, params) => call(method, params, sessionId);
    const evaluate = async expression => {
      const r = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw Error(`BROWSER_EVALUATION:${r.exceptionDetails.text}:${r.exceptionDetails.exception?.description}`);
      return r.result.value;
    };
    rescue = async () => evaluate(`({progress:window.__orderflowMockDiagnostics?.progress(),
      inspection:window.__orderflowMockDiagnostics?.inspectMeaning(),
      telemetry:window.__orderflowMockDiagnostics?.snapshot(),gl:window.__b2gl?.snapshot(),
      resources:window.__b2resources?.snapshot(),resourceOwnership:window.__b2resources?.ownership(),
      viewport:(${captureViewport.toString()})()})`);
    const wait = async (expression, limit = 10000) => {
      const deadline = performance.now() + limit;
      while (performance.now() < deadline) {
        const budget = await evaluate("window.__orderflowMockDiagnostics?.progress().recording");
        if (budget?.saturated || budget?.dropped) throw Error("DIAGNOSTIC_RECORD_LIMIT");
        if (await evaluate(expression)) return;
        await new Promise(r => setTimeout(r, 100));
      }
      throw Error(`CONDITION_TIMEOUT:${expression}`);
    };
    await page("Page.enable");
    await page("Network.enable");
    await page("Network.setBlockedURLs", { urls: ["*tick-stream.xyz*"] });
    if (observeResources) await page("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${installResourceObserver.toString()})()\n//# sourceURL=orderflow-resource-observer.js` });
    if (observeGL) await page("Page.addScriptToEvaluateOnNewDocument", {
      source: safetyOnly ? `(${installSafetyGLObserver.toString()})()` :
        `(${installGLObserver.toString()})(${policy.compactGL},false)` });
    await page("Page.navigate", { url: `http://127.0.0.1:80/?mockDiagnostics=${mode === "on" ? "1" : "control"}&mockCase=${workload}` });
    await wait(`!!document.querySelector('[data-testid="button-unified-start"]')`);
    const initial = await evaluate(`({text:document.body.textContent, bridge:!!window.__orderflowMockDiagnostics})`);
    assert(initial.text.includes("Events loaded: 0")); assert(!initial.bridge);
    const gpu = await evaluate(`(()=>{const c=document.createElement('canvas'),g=c.getContext('webgl2');
      if(!g)return {webgl2:false};const d=g.getExtension('WEBGL_debug_renderer_info');
      const out={webgl2:true,renderer:g.getParameter(d?d.UNMASKED_RENDERER_WEBGL:g.RENDERER),
        timerExtension:!!g.getExtension('EXT_disjoint_timer_query_webgl2')};
      g.getExtension('WEBGL_lose_context')?.loseContext();return out})()`);
    assert(gpu.webgl2, "WEBGL2_UNAVAILABLE");
    const start = await evaluate(`(()=>{window.__b2resources?.beginSession(1);
      const t=performance.now();document.querySelector('[data-testid="button-unified-start"]').click();return t})()`);
    await wait(`document.querySelector('[data-testid="status-data"]')?.textContent.includes("COMPLETED")`, completionLimitMs);
    const observedCompletion = await evaluate("performance.now()");
    await new Promise(r => setTimeout(r, 400));
    const preflight = await rescue();
    captured = { mode, repetition, workload, chromium: version.product, gpu, ...preflight,
      completionLimitMs, browserLimitMs, completionObservedMs: observedCompletion - start };
    const summary = preflight.inspection?.summary;
    assert(summary?.checks.every(c => c.ok), "GOLDEN_MISMATCH");
    if (workload !== "baseline13") {
      const view = preflight.viewport, p = view.viewport.price, t = view.viewport.time;
      assert(BigInt(t.minNs) <= 1767225600000000000n && BigInt(t.maxNs) >= 1767225606000000000n, "TIME_OUTSIDE_VIEWPORT");
      assert(p.minTick <= 79999.5 && p.maxTick >= 80065.5, "PRICE_OUTSIDE_VIEWPORT");
      assert(view.vpRows.length === 8 && view.vpRows.every(r => r.errorPx <= .001), "VP_COORDINATE_MISMATCH");
      assert.equal(view.heatmap.rects, workload === "cells128" ? 128 : 512);
      assert.equal(view.heatmap.revision, summary.revision); assert.equal(view.bubble.revision, summary.revision);
      assert.equal(view.heatmap.status, "READY"); assert.equal(view.bubble.status, "READY");
    }
    if (policy.version !== 3) assert(preflight.inspection?.allowed, "DIAGNOSTIC_SEMANTIC_LIMIT");
    const sample = await evaluate(browserReadoutExpression(workload));
    const decoded = resolveBrowserMeaning(workload, sample.meaning, reference), meaning = decoded.value;
    captured.meaningEncoding = { version: policy.version, wireBytes: decoded.wireBytes,
      restoredBytes: decoded.legacyBytes, verified: decoded.verified,
      referenceSource: policy.version === 3 ? "INDEPENDENT_NODE_LEGACY_REPLAY" : "LEGACY_BROWSER_SERIALIZER" };
    assert.equal(meaning.processedInputs, expectedInputs); assert.equal(meaning.counts.inputs, expectedInputs);
    assert(meaning.checks.every(c => c.ok), "GOLDEN_MISMATCH");
    assert.equal(meaning.counts.accepted, expectedInputs); assert.equal(meaning.counts.duplicate, 0); assert.equal(meaning.counts.rejected, 0);
    const revision = meaning.frame.revision;
    const layerRevisions = ["book", "heatmap", "bubbles", "delta", "volumeProfile", "quality"].map(l => meaning.frame[l].revision);
    assert(layerRevisions.every(r => r === revision), "MIXED_FRAME");
    assert(!sample.errors.some(s => /RENDER ERROR|WebGL2 unavailable/i.test(s)), "RENDER_ERROR");
    if (workload !== "baseline13") {
      const cellCount = workload === "cells512" ? 512 : 128;
      assert.equal(meaning.frame.heatmap.cells.length, cellCount);
      assert.equal(revision, 128);
      assert(!sample.gl.limited && sample.gl.unrecordedApiCalls === 0, "GL_RECORD_LIMIT");
      if (!safetyOnly) assert(sample.gl.frames.length <= 256);
      for (const layer of ["heatmap", "bubble"]) {
        assert.equal(sample.gl.totals[layer].errors, 0, `GL_ERRORS:${layer}`);
        assert.equal(preflight.viewport[layer].status, "READY", `LAYER_NOT_READY:${layer}`);
        if (safetyOnly) assert(sample.gl.totals[layer].contexts > 0 && sample.gl.totals[layer].errorChecks > 0,
          `OFF_SAFETY_NOT_OBSERVED:${layer}`);
        const last = sample.gl.lastDraws[layer];
        assert.equal(last.revision, revision, `FINAL_NATIVE_DRAW_REVISION:${layer}`);
        assert.equal(last.vertices, layer === "heatmap" ? cellCount * 6 : preflight.viewport.bubble.vertices,
          `FINAL_NATIVE_VERTICES:${layer}`);
        assert.equal(last.uploadedBytes, last.vertices * (layer === "heatmap" ? 32 : 52), `FINAL_NATIVE_UPLOAD:${layer}`);
        if (!safetyOnly) for (const key of ["draws", "vertices", "uploads", "bytes", "buffers", "deletes", "loss", "restore", "errors"])
          assert.equal(sample.gl.frames.reduce((n, f) => n + f.layers[layer][key], 0), sample.gl.totals[layer][key],
            `GL_TOTAL:${layer}:${key}`);
      }
      if (mode !== "on") assert.equal(sample.telemetry, null, "OFF_COLLECTOR_NOT_DISABLED");
    }
    if (mode === "on") {
      assert.equal(sample.telemetry.dropped, 0); assert(!sample.telemetry.saturated);
      assert(sample.telemetry.records < 2048);
      assert.equal(sample.telemetry.allocatedBytes, 147456);
      assert.equal(sample.telemetry.records, sample.telemetry.rows.length + sample.telemetry.receipts.length);
      assert.equal(sample.telemetry.observations, sample.telemetry.records +
        sample.telemetry.mergedReceipts + sample.telemetry.delegatedGL);
      for (const layer of ["heatmap", "bubble", "delta"]) {
        assert(sample.telemetry.rows.some(r => r.stage === "draw" && r.layer === layer && r.revision === revision), `MISSING_DRAW:${layer}`);
      }
      for (const layer of ["heatmap", "bubble", "delta", "vp"]) {
        assert(sample.telemetry.rows.some(r => r.stage === "received" && r.layer === layer && r.revision === revision) ||
          sample.telemetry.receipts.some(r => r.revision === revision && r[`${layer}At`] !== null), `MISSING_RECEIVE:${layer}`);
      }
      assert(sample.telemetry.rows.some(r => r.stage === "dom" && r.layer === "vp" && r.revision === revision) ||
        sample.telemetry.receipts.some(r => r.revision === revision && r.domAt !== null));
      assert(!sample.gl.limited);
      assert(Object.values(sample.gl.totals).every(t => t.errors === 0));
      if (sample.gl.version === 1) {
        assert(sample.gl.draws.some(d => d.layer === "heatmap" && d.revision === revision && d.vertices > 0));
        assert(sample.gl.draws.some(d => d.layer === "bubble" && d.revision === revision && d.vertices > 0));
      } else {
        assert.equal(sample.gl.unrecordedApiCalls, 0);
        assert(sample.gl.frames.length <= 256);
        for (const layer of ["heatmap", "bubble"]) {
          for (const key of ["draws", "vertices", "uploads", "bytes", "buffers", "deletes", "loss", "restore", "errors"]) {
            assert.equal(sample.gl.frames.reduce((n, f) => n + f.layers[layer][key], 0),
              sample.gl.totals[layer][key], `GL_TOTAL:${layer}:${key}`);
          }
          for (const f of sample.gl.frames) {
            const actual = f.layers[layer];
            const issued = sample.telemetry.rows.filter(r => r.stage === "draw" && r.layer === layer && r.revision === f.revision);
            assert.equal(actual.draws, issued.length, `GL_DRAW_REVISION:${layer}:${f.revision}`);
            assert.equal(actual.vertices, issued.reduce((n, r) => n + r.a, 0), `GL_VERTICES:${layer}:${f.revision}`);
            assert.equal(actual.uploads, actual.draws, `GL_UPLOADS:${layer}:${f.revision}`);
            assert.equal(actual.bytes, actual.vertices * (layer === "heatmap" ? 32 : 52), `GL_BYTES:${layer}:${f.revision}`);
          }
        }
        const perRevision = [];
        for (const r of sample.telemetry.rows.filter(r => r.stage === "frame")) {
          const receipt = sample.telemetry.receipts.filter(v => v.revision === r.revision);
          for (const key of ["heatmapAt", "bubbleAt", "deltaAt", "vpAt", "domAt"]) {
            assert(receipt.some(v => v[key] !== null), `RECEIPT:${key}:${r.revision}`);
          }
          for (const layer of ["heatmap", "bubble", "delta"]) {
            assert(sample.telemetry.rows.some(v => v.stage === "draw" && v.layer === layer && v.revision === r.revision),
              `DRAW:${layer}:${r.revision}`);
          }
          perRevision.push(r.revision);
        }
        assert.deepEqual(sample.telemetry.rows.filter(r => r.stage === "ingest").map(r => r.seq),
          Array.from({ length: expectedInputs }, (_, i) => i + 1), "INGEST_SAMPLE_SEQUENCE");
        captured.verifiedRevisions = perRevision;
      }
    }
    const result = captured = { ...captured, mode, repetition, chromium: version.product, gpu, counts: meaning.counts,
      revision, layerRevisions, golden: meaning.checks, quality: meaning.frame.quality,
      meaningHash: decoded.sha256,
      completionObservedMs: observedCompletion - start, telemetry: sample.telemetry, gl: sample.gl ?? null };
    if (workload === "baseline13") assert.equal(result.meaningHash,
      "dfe56d920917807ed5265bae6ba1c3039a36a3729207c4d1ae38da2c0dc54d27", "BASELINE_HASH_REGRESSION");
    if (lifecycle) {
      // The existing UI intentionally disables Stop after COMPLETED. Exercise it while RUNNING.
      await evaluate(`window.__b2resources?.beginSession(2);document.querySelector('[data-testid="button-unified-restart"]').click()`);
      await wait("window.__orderflowMockDiagnostics?.snapshot()?.sessionId===2");
      const fresh = await evaluate("window.__orderflowMockDiagnostics.snapshot()");
      assert(!fresh.rows.some(r => r.stage === "ingest")); // before the first 300ms input
      result.restartFresh = fresh.sessionId === 2;
      await evaluate(`document.querySelector('[data-testid="button-unified-stop"]').click()`);
      await wait("!window.__orderflowMockDiagnostics");
      result.stopReleased = true;
      if (observeResources) {
        result.afterStopResources = await evaluate("window.__b2resources.snapshot()");
        result.afterStopOwnership = await evaluate("window.__b2resources.ownership()");
        result.afterStopGate = resourceReleaseGate(result.afterStopResources, result.afterStopOwnership, false);
        assert.equal(result.afterStopGate.status, "PASS", result.afterStopGate.reason);
      }
      await evaluate(`window.__b2resources?.beginSession(3);document.querySelector('[data-testid="button-unified-restart"]').click()`);
      await wait("window.__orderflowMockDiagnostics?.snapshot()?.sessionId===3");
      await evaluate(`window.dispatchEvent(new Event("orderflow:diagnostic-unmount"))`);
      await wait("!window.__orderflowMockDiagnostics && !document.querySelector('.shell')");
      await new Promise(r => setTimeout(r, 400));
      assert(await evaluate("!window.__orderflowMockDiagnostics"));
      result.unmountReleased = true;
    } else {
      await evaluate(`document.querySelector('[data-testid="button-unified-exit"]').click()`);
      await wait(`!document.querySelector('.hm-canvas') && !document.querySelector('.bb-canvas')`);
      assert(await evaluate("!window.__orderflowMockDiagnostics"));
      result.exitReleased = true;
    }
    if (observeGL) {
      result.afterReleaseGL = await evaluate("window.__b2gl.snapshot().totals");
      assert(Object.values(result.afterReleaseGL).every(t => t.buffers === t.deletes), "BUFFER_NOT_RELEASED");
      await evaluate("window.__b2gl.dispose()");
    }
    if (observeResources) {
      result.afterReleaseResources = await evaluate("window.__b2resources.snapshot()");
      result.afterReleaseOwnership = await evaluate("window.__b2resources.ownership()");
      result.afterReleaseGate = resourceReleaseGate(result.afterReleaseResources, result.afterReleaseOwnership);
      assert.equal(result.afterReleaseGate.status, "PASS", result.afterReleaseGate.reason);
      await evaluate("window.__b2resources.dispose()");
    }
    return result;
  } catch (error) {
    if (rescue && !captured) {
      try { captured = { mode, repetition, workload, completionLimitMs, browserLimitMs, ...(await rescue()) }; } catch {}
    }
    if (captured) error.partialResult = captured;
    throw error;
  } finally {
    try { await call("Browser.close"); } catch {}
    if (browser.exitCode === null && !browser.signalCode) await new Promise(r => {
      browser.once("exit", r); setTimeout(r, 2000);
    });
    clearTimeout(hardStop);
    if (browser.exitCode === null && !browser.signalCode) { try { process.kill(-browser.pid, "SIGKILL"); } catch {} }
    let group = await browserGroup(browser.pid);
    if (group.live.length) {
      try { process.kill(-browser.pid, "SIGKILL"); } catch {}
      for (let n = 0; n < 20 && group.live.length; n++) {
        await new Promise(r => setTimeout(r, 100)); group = await browserGroup(browser.pid);
      }
    }
    await rm(dir, { recursive: true, force: true });
    if (captured) captured.chromiumCleanup = { pid: browser.pid, ...group, profileRemoved: true };
    if (group.live.length) {
      const error = Error("BROWSER_PROCESS_REMAINING"); error.partialResult = captured; throw error;
    }
  }
}

async function capacityOnly(output, referenceOnly = false) {
  const { createServer } = await import("vite");
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../../", import.meta.url)),
    logLevel: "error", server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] } });
  const originalWindow = globalThis.window, originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  const report = { phase: "OFFLINE_CODEC_CAPACITY", browserStarted: false, trials: [], failure: null,
    note: "Single finite artificial session per case; invoke the existing 300ms input callback synchronously, not as a throughput test. Only codec timings are measured. Vite is a middleware-only module loader, no listening port.",
    limits: { semanticBytes: 65536, records: 2048, fixedNumericBytes: 147456, driverGLRecords: 256, evidenceBytes: 2097152 },
    browserHeap: "UNKNOWN", browserRSS: "UNKNOWN", browserGC: "UNKNOWN", gpuMs: "UNKNOWN", presentationAt: "UNKNOWN" };
  let session, diagnostic;
  try {
    diagnostic = await server.ssrLoadModule("/src/diagnostics/mockDiagnostics.ts");
    const { createMockAnalysisSession } = await server.ssrLoadModule("/src/lib/mockAnalysisSession.ts");
    const { unifiedChecks } = await server.ssrLoadModule("/src/hooks/useMockAnalysisSession.ts");
    const expected = {
      baseline13: [14349, "dfe56d920917807ed5265bae6ba1c3039a36a3729207c4d1ae38da2c0dc54d27"],
      cells128: [40689, "5fd67038dc8ee736d2134ec52d097aab9d5f58c91be8d33508c274f3acd1c34c"],
      cells512: [126193, "b1a413d76d16417718c3fcd1561ec45c82972f9798e58a6bf73eb53fc5043e3e"],
    };
    for (const [id, version] of [["baseline13", 1], ["cells128", 2], ["cells512", 3]]) {
      if (referenceOnly && id !== "cells512") continue;
      const trial = { case: id, version, result: "STARTED" }; report.trials.push(trial);
      const timers = new Map(); let timerId = 0, d;
      try {
        globalThis.window = { location: { search: `?mockDiagnostics=1&mockCase=${id}` } };
        const c = diagnostic.selectDiagnosticCase();
        d = diagnostic.startDiagnostics(1);
        globalThis.setInterval = (fn, ms) => { const key = ++timerId; timers.set(key, { fn, ms }); return key; };
        globalThis.clearInterval = key => { if (timers.has(key)) timers.delete(key); else originalClear(key); };
        session = createMockAnalysisSession({ scope: c.scope, inputs: c.inputs, query: c.query,
          inputEveryMs: 300, diagnostics: d });
        session.setNotificationsEnabled(false); session.start();
        assert(timers.size === 1 && [...timers.values()][0].ms === 300, "UNEXPECTED_CAPACITY_TIMER");
        const callback = [...timers.values()][0].fn;
        for (let i = 0; i < c.inputs.length; i++) callback();
        const frame = session.readFrame(), status = session.getStatus();
        const content = { frame, checks: c.expected ? diagnostic.caseChecks(frame, c) : unifiedChecks(frame),
          counts: status.counts, revision: status.revision, processedInputs: status.processedInputs, state: status.state };
        diagnostic.setDiagnosticReader(() => content);
        // Local trusted reference, same legacy replacer. Never sent over the wire or saved in evidence.
        const legacy = JSON.stringify(content, (_k, v) => typeof v === "bigint" ? { bigint: v.toString() }
          : v instanceof Map ? { map: [...v] } : v);
        const inspection = window.__orderflowMockDiagnostics.inspectMeaning();
        Object.assign(trial, { processedInputs: status.processedInputs, revision: status.revision,
          counts: status.counts, oldBytes: inspection.bytes, golden: content.checks,
          layerRevisions: [frame.book, frame.heatmap, frame.bubbles, frame.delta, frame.volumeProfile, frame.quality].map(v => v.revision),
          cellCount: frame.heatmap.cells.length, queryCellCount: c.query.cells.length,
          scope: frame.scope, inputSha256: createHash("sha256").update(JSON.stringify(c.inputs)).digest("hex") });
        assert.equal(status.state, "COMPLETED"); assert.equal(status.processedInputs, c.inputs.length);
        assert(content.checks.every(v => v.ok), "GOLDEN_MISMATCH");
        const hash = createHash("sha256").update(legacy).digest("hex");
        assert.equal(inspection.bytes, expected[id][0], "LEGACY_BYTE_REGRESSION");
        assert.equal(hash, expected[id][1], "LEGACY_HASH_REGRESSION");
        trial.sha256 = hash;
        // Local trusted old JSON only; never transported around the browser wire limit.
        if (referenceOnly) return legacy;
        if (id !== "cells512") {
          assert.equal(window.__orderflowMockDiagnostics.meaning(), legacy);
          trial.outputBytes = inspection.bytes;
          trial.legacyMeaningUnchanged = true;
        } else {
          assert.throws(() => window.__orderflowMockDiagnostics.meaning(), /DIAGNOSTIC_SEMANTIC_LIMIT/);
          const before = process.memoryUsage();
          const encoded = await diagnostic.encodeCompactMeaning(legacy);
          trial.outputBytes = encoded.metrics.outputBytes;
          trial.encoder = encoded.metrics;
          const afterEncoding = process.memoryUsage();
          const decoded = verifyCompactMeaning(encoded.wire, legacy);
          const afterVerification = process.memoryUsage();
          Object.assign(trial, { restoredBytes: decoded.legacyBytes, verification: decoded.verified,
            restoredSha256: decoded.sha256, decoder: decoded.metrics, comparisonIncludingReferenceHashMs: decoded.comparisonMs,
            memory: { scope: "Node process including Vite/session; snapshots are not peak allocation or GC measurements",
              before, afterEncoding, afterVerification, gc: "UNKNOWN" },
            schemas: JSON.parse(encoded.wire).schemas, restoredCellCount: decoded.value.frame.heatmap.cells.length });
          assert.equal(decoded.value.frame.heatmap.cells.length, 512);
          // Same old serializer closure is used by the actual bridge. This second,
          // untimed conversion is an integration check, not an additional input trial.
          assert.equal(await window.__orderflowMockDiagnostics.compactMeaning(), encoded.wire, "BRIDGE_CODEC_MISMATCH");
          trial.bridgeWireIdentical = true;
        }
        trial.recording = d.stats();
        assert.equal(trial.recording.version, version); assert.equal(trial.recording.dropped, 0);
        assert(trial.recording.records < 2048 && trial.recording.allocatedBytes === 147456);
        trial.result = "PASS";
      } finally {
        session?.dispose(); session = undefined; diagnostic.releaseDiagnostics();
        globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear;
        trial.cleanup = { timersRemaining: timers.size, bridgeReleased: !window.__orderflowMockDiagnostics,
          slabBytesAfterDispose: d?.snapshot().allocatedBytes ?? 0 };
        assert(timers.size === 0 && trial.cleanup.bridgeReleased && trial.cleanup.slabBytesAfterDispose === 0, "CAPACITY_RESOURCE_LEAK");
      }
    }
  } catch (error) {
    if (referenceOnly) throw error;
    report.failure = String(error);
    Object.assign(report.trials.at(-1) ?? {}, { result: "FAIL", failure: String(error),
      attemptedOutputBytes: error.bytes ?? null });
    process.exitCode = 1;
  } finally {
    session?.dispose(); diagnostic?.releaseDiagnostics();
    globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    await server.close();
  }
  const text = JSON.stringify(report, null, 2) + "\n";
  assert(Buffer.byteLength(text) <= 2097152, "REPORT_SIZE_LIMIT");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, text, { flag: "wx" });
  console.log(JSON.stringify({ failure: report.failure, evidenceBytes: Buffer.byteLength(text),
    trials: report.trials.map(t => ({ case: t.case, result: t.result, oldBytes: t.oldBytes,
      outputBytes: t.outputBytes, restoredBytes: t.restoredBytes, sha256: t.sha256, recording: t.recording, cleanup: t.cleanup })) }, null, 2));
}
async function main() {
const output = resolve(process.argv[2] ?? ".local/diagnostics/task28-b2-b1/results.json");
assert(output.startsWith(resolve(".local/diagnostics") + "/"), "OUTPUT_MUST_BE_IGNORED_DIAGNOSTICS");
if (process.argv[3] === "capacity") { await capacityOnly(output); return; }
const workload = process.argv[3] ?? "baseline13", phase = process.argv[4] ?? "preflight";
const plan = comparisonPlan(workload, phase);
if (phase === "formal") { await formalComparison(output); return; }
assert(output.startsWith(resolve(".local/diagnostics") + "/"), "OUTPUT_MUST_BE_IGNORED_DIAGNOSTICS");
const report = { workload, phase, runs: [], failure: null,
  gpuMs: "UNKNOWN", presentationAt: "UNKNOWN",
  note: "OFF has control-mode semantic readout and, for cells128/512, untimed safety counters only. Completion includes DOM polling uncertainty." };
try {
  const reference = workload === "cells512" ? await capacityOnly(undefined, true) : undefined;
  if (reference) report.reference = { source: "INDEPENDENT_NODE_LEGACY_REPLAY",
    bytes: Buffer.byteLength(reference), sha256: createHash("sha256").update(reference).digest("hex") };
  for (const { repetition: r, mode } of plan) {
    const sample = await browserRun(mode, r, mode === "on" && r === 1, workload, reference);
    report.runs.push(sample);
    assert(report.runs.every(x => x.meaningHash === sample.meaningHash), "ON_OFF_MEANING_HASH_MISMATCH");
    console.log(JSON.stringify({ mode, repetition: r, hash: sample.meaningHash, records: sample.telemetry?.records ?? 0,
      completionObservedMs: sample.completionObservedMs, gl: sample.gl?.totals ?? "NOT_OBSERVED" }));
  }
} catch (e) {
  report.failure = String(e);
  if (e.partialResult) report.runs.push({ ...e.partialResult, failed: true });
  process.exitCode = 1;
}
await mkdir(dirname(output), { recursive: true });
const text = JSON.stringify(report, null, 2);
assert(Buffer.byteLength(text) <= 2 * 1024 * 1024, "REPORT_SIZE_LIMIT");
await writeFile(output, text + "\n", { flag: "wx" });
if (report.failure) console.error(report.failure);
}
// Importing the decoder in tests never starts Chromium or any input session.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
