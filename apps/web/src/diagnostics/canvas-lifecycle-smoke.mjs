// Phase A only. No product imports, new dependencies, settings writes or automatic retries.
// baseline13-driver's inspected main guard makes named imports side-effect free.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadE2Baseline, validateE2ExternalEnvironment, validateE2BrowserStartup,
  installSafetyGLObserver, createBrowserTermination, verifyBrowserOwnership,
  resourceReleaseGate, resolveBrowserMeaning,
} from "./baseline13-driver.mjs";

const DRIVER = "apps/web/src/diagnostics/baseline13-driver.mjs";
const DRIVER_SHA = "c3c4abea3662ee71a3226d81800e0a3270db03725e8b09341fd0e2df393b72a3";
const LAYERS = ["heatmap", "bubble"];
const LIMIT = 2 * 1024 * 1024;
const digest = data => createHash("sha256").update(data).digest("hex");
export function resourceObserverSource(source) {
  assert.equal(digest(source), DRIVER_SHA, "FORMAL_DRIVER_CHANGED");
  const start = source.indexOf("function installResourceObserver()");
  const end = source.indexOf("\nasync function browserGroup", start);
  assert(start > 0 && end > start, "RESOURCE_OBSERVER_BOUNDARY");
  return `(${source.slice(start, end).trim()})()`;
}
export function rafAccounting(r) {
  return r.reserved === r.executed + r.cancelled + r.live;
}
export function verifyDrawCoverage(rows, lastRevision = 128) {
  for (const layer of LAYERS) {
    for (let revision = 1; revision <= lastRevision; revision++) {
      const draws = rows.filter(r => r.kind === "draw" && r.layer === layer && r.revision === revision);
      assert(draws.length > 0, `MISSING_DRAW:${layer}:${revision}`);
      assert(draws.every(r => r.tokenRevision === null || r.tokenRevision === revision), "MIXED_REVISION");
    }
  }
}
export function assessRestore({ restored, timedOut, lostDraws, rows, expectedHash }) {
  if (timedOut) return { status: "FAIL", reason: "CONTEXT_RESTORE_TIMEOUT" };
  if (!restored) return { status: "UNKNOWN", reason: "RESTORE_NOT_OBSERVED" };
  if (lostDraws) return { status: "FAIL", reason: "DRAW_WHILE_LOST" };
  if (!rows.length) return { status: "FAIL", reason: "RESTORE_DRAW_MISSING" };
  if (rows.some(r => r.tokenRevision !== null && r.tokenRevision !== r.revision))
    return { status: "FAIL", reason: "RESTORE_REVISION_MISMATCH" };
  if (rows.length > 1 && rows.some((r, i) => i && r.revision === rows[i - 1].revision &&
      r.sha256 === rows[i - 1].sha256))
    return { status: "FAIL", reason: "DUPLICATE_RESTORE_DRAW" };
  if (expectedHash && rows[0].sha256 !== expectedHash)
    return { status: "FAIL", reason: "RESTORE_GPU_PAYLOAD_MISMATCH" };
  return expectedHash ? { status: "PASS", reason: "GPU_PAYLOAD_MATCH" } :
    { status: "UNKNOWN", reason: "INDEPENDENT_PAYLOAD_REFERENCE_UNAVAILABLE" };
}
// E5 functional diagnostic only: defer SOURCE timer ticks, never edit hub/React state.
// Native 300ms input cadence and the separate 250ms notice timer remain intact.
export function installContinuationInputGate() {
  const saved = window.setInterval, events = [];
  let ceiling = 2, delivered = 0, deferredTicks = 0, registrations = 0, fault = null, disposed = false;
  const record = event => {
    if (events.length >= 128) { fault = "INPUT_GATE_RECORD_LIMIT"; throw Error(fault); }
    events.push({ at: performance.now(), ...event });
  };
  window.setInterval = function (fn, ms, ...args) {
    const source = /\/src\/lib\/mockAnalysisSession\.ts[?:]/.test(new Error().stack ?? "");
    if (!source || ms !== 300) return saved.call(this, fn, ms, ...args);
    if (typeof fn !== "function" || ++registrations > 4) throw Error("INPUT_GATE_SOURCE_LIMIT");
    record({ kind: "source", registration: registrations, inputEveryMs: ms });
    return saved.call(this, function (...callbackArgs) {
      if (disposed) throw Error("INPUT_GATE_AFTER_DISPOSE");
      const before = window.__orderflowMockDiagnostics?.progress().status?.revision;
      if (!Number.isSafeInteger(before) || before < 0) {
        fault = "INPUT_GATE_REVISION_UNOBSERVED"; throw Error(fault);
      }
      if (before >= ceiling) { deferredTicks++; return; }
      fn.apply(this, callbackArgs);
      const after = window.__orderflowMockDiagnostics?.progress().status?.revision;
      if (after !== before + 1) { fault = "INPUT_GATE_NON_SEQUENTIAL"; throw Error(fault); }
      delivered++; record({ kind: "delivered", before, after });
    }, ms, ...args);
  };
  window.__canvasContinuationInput = {
    setCeiling(value) {
      if (!Number.isSafeInteger(value) || value < 2 || value > 8) throw Error("INPUT_GATE_CEILING");
      ceiling = value; record({ kind: "ceiling", value });
    },
    snapshot: () => ({ ceiling, delivered, deferredTicks, registrations, fault, disposed, events: [...events] }),
    dispose() { disposed = true; window.setInterval = saved; },
  };
}
const R3_REFERENCE_JSON_SHA = "807fd3037e778918e6174a23f351fb14568f25964ce768e8c1d68878cda6d1fe";
const EMPTY_PAYLOAD_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
// The production diagnostic always uses the frozen R3 content pin. Artificial
// unit fixtures may supply their own independently fixed content digest.
export function continuationReferences(report, expectedDigest = R3_REFERENCE_JSON_SHA) {
  assert.equal(report.status, "PASS", "R3_REFERENCE_NOT_PASS");
  const refs = report.control?.phase?.rows?.filter(r => r.kind === "draw" &&
    LAYERS.includes(r.layer) && r.revision >= 2 && r.revision <= 8);
  assert(Array.isArray(refs), "R3_GPU_REFERENCE_MISSING");
  for (const layer of LAYERS) for (let revision = 2; revision <= 8; revision++) {
    const matches = refs.filter(r => r.layer === layer && r.revision === revision);
    assert(matches.length === 1, "R3_GPU_REFERENCE_AMBIGUOUS");
    const r = matches[0], stride = layer === "heatmap" ? 32 : 52;
    assert(Number.isSafeInteger(r.canvasId) && r.canvasId > 0 && r.tokenRevision === revision &&
      r.lost === false, "R3_GPU_REFERENCE_IDENTITY");
    assert(Number.isSafeInteger(r.vertices) && r.vertices >= 0 && Number.isSafeInteger(r.bytes) &&
      r.bytes >= 0 && r.vertices % 6 === 0 &&
      BigInt(r.bytes) === BigInt(r.vertices) * BigInt(stride), "R3_GPU_REFERENCE_GEOMETRY");
    assert(/^[a-f0-9]{64}$/.test(r.sha256), "R3_GPU_REFERENCE_HASH");
    if (r.vertices === 0) assert(layer === "bubble" && revision === 2 && r.sha256 === EMPTY_PAYLOAD_SHA,
      "R3_GPU_REFERENCE_UNEXPECTED_EMPTY");
    else assert(r.sha256 !== EMPTY_PAYLOAD_SHA, "R3_GPU_REFERENCE_NONEMPTY_HASH");
  }
  assert(/^[a-f0-9]{64}$/.test(expectedDigest) && digest(JSON.stringify(report)) === expectedDigest,
    "R3_REFERENCE_CONTENT_HASH");
  return refs.map(({ layer, revision, bytes, vertices, sha256 }) => ({ layer, revision, bytes, vertices, sha256 }));
}
export function assessContinuation(c, references) {
  const { layer, scenario, before, lost, restored, followups, stopped } = c;
  const restoreRevision = scenario === "A" ? 2 : 4;
  const wanted = Array.from({ length: 8 - restoreRevision }, (_, i) => restoreRevision + i + 1);
  if (!references || [restoreRevision, ...wanted].some(revision =>
    !references.some(r => r.layer === layer && r.revision === revision)))
    return { status: "UNKNOWN", reason: "CONTINUATION_REFERENCE_MISSING" };
  try {
    assert(LAYERS.includes(layer) && ["A", "B"].includes(scenario), "CONTINUATION_CASE");
    const id = before.canvas.id;
    const check = (s, revision, isLost, loss, restore) => {
      assert(s.canvas.id === id && s.canvas.connected, "CANVAS_IDENTITY_CHANGED");
      assert(s.canvas.revision === revision && s.source.revision === revision, "CONTINUATION_REVISION");
      assert(s.source.counts.inputs === revision && s.source.counts.accepted === revision &&
        s.source.counts.duplicate === 0 && s.source.counts.rejected === 0, "CONTINUATION_COUNTS");
      assert(s.size.width === 403 && s.size.height === 324, "CONTINUATION_CANVAS_SIZE");
      assert(s.canvas.lost === isLost && s.canvas.loss === loss && s.canvas.restore === restore,
        "CONTEXT_RELOST_OR_REPLACED");
      assert(s.size.status === (isLost ? "CONTEXT LOST" : "READY"), "CONTEXT_NOT_READY");
      assert(s.gl.errors === 0, "CONTINUATION_GL_ERRORS");
      assert(!s.limited && !s.inputGate.fault, "CONTINUATION_OBSERVATION_LIMIT");
      assert(rafAccounting(s.raf), "CONTINUATION_RAF_ACCOUNTING");
    };
    const draw = (s, revision, native) => {
      const rows = s.rows.filter(r => r.kind === "draw");
      assert(rows.length === 1, rows.length ? "CONTINUATION_DUPLICATE_DRAW" : "CONTINUATION_DRAW_MISSING");
      const r = rows[0], ref = references.find(r => r.layer === layer && r.revision === revision);
      assert(r.canvasId === id && r.revision === revision && !r.lost, "CONTINUATION_STALE_OR_LOST_DRAW");
      assert(r.tokenRevision === (native ? null : revision), "NATIVE_VS_RAF_REVISION");
      assert(r.bytes === ref.bytes && r.vertices === ref.vertices && r.sha256 === ref.sha256,
        "CONTINUATION_GPU_MISMATCH");
      const uploads = s.rows.filter(r => r.kind === "upload");
      assert(uploads.length === 1 && Number.isSafeInteger(r.uploadSerial) && r.uploadSerial > 0 &&
        uploads[0].uploadSerial === r.uploadSerial && uploads[0].canvasId === id &&
        uploads[0].revision === revision && !uploads[0].lost &&
        uploads[0].bytes === ref.bytes && uploads[0].sha256 === ref.sha256, "CONTINUATION_UPLOAD_MISSING_OR_MISMATCH");
      const clears = s.rows.filter(r => r.kind === "clear"), colors = s.rows.filter(r => r.kind === "clearColor");
      assert(clears.length === 1 && colors.length === 1 && clears[0].canvasId === id &&
        clears[0].revision === revision && !clears[0].lost && clears[0].mask === 16384 &&
        colors[0].canvasId === id && colors[0].revision === revision &&
        clears[0].scissor === false &&
        JSON.stringify(colors[0].rgba) === JSON.stringify(layer === "bubble" ? [0, 0, 0, 0] : [8 / 255, 9 / 255, 13 / 255, 1]) &&
        s.rows.indexOf(colors[0]) < s.rows.indexOf(clears[0]) &&
        s.rows.indexOf(clears[0]) < s.rows.indexOf(uploads[0]) &&
        s.rows.indexOf(uploads[0]) < s.rows.indexOf(r), "CONTINUATION_CLEAR_MISSING_OR_ORDER");
      if (ref.bytes === 0) {
        assert(layer === "bubble" && revision === 2 && ref.sha256 === EMPTY_PAYLOAD_SHA,
          "CONTINUATION_UNEXPECTED_EMPTY");
        const p = s.emptyPixels;
        assert(p?.canvasId === id && p.revision === revision && p.defaultFramebuffer &&
          p.colorMask?.every(Boolean) && p.error === 0 && p.rgba?.length === 20 &&
          p.rgba.every(v => v === 0), "CONTINUATION_EMPTY_NOT_TRANSPARENT");
      }
      if (!native) {
        const reserved = s.rows.filter(r => r.kind === "reserve"), executed = s.rows.filter(r => r.kind === "execute");
        assert(reserved.length === 1 && executed.length === 1 &&
          !s.rows.some(r => r.kind === "cancel") && reserved[0].rafId === executed[0].rafId &&
          executed[0].canvasId === id && executed[0].revision === revision, "CONTINUATION_RAF_CORRESPONDENCE");
      } else assert(!s.rows.some(r => r.kind === "execute"), "NATIVE_REPLAY_VIA_RAF");
      assert(s.raf.live === 0, "CONTINUATION_PENDING_RAF");
    };
    check(before, 2, false, 0, 0);
    check(lost, restoreRevision, true, 1, 0);
    assert(!lost.rows.some(r => r.kind === "draw"), "CONTINUATION_DRAW_WHILE_LOST");
    assert(lost.rows.filter(r => r.kind === "contextlost" && r.canvasId === id).length === 1,
      "LOSS_EVENT_UNOBSERVED");
    check(restored, restoreRevision, false, 1, 1);
    assert(restored.rows.filter(r => r.kind === "contextrestored" && r.canvasId === id).length === 1,
      "RESTORE_EVENT_UNOBSERVED");
    draw(restored, restoreRevision, true);
    assert.deepEqual(followups.map(s => s.source.revision), wanted, "CONTINUATION_SEQUENCE_MISSING");
    for (const s of followups) { check(s, s.source.revision, false, 1, 1); draw(s, s.source.revision, false); }
    // Stop intentionally releases the product diagnostic bridge. Do not fabricate
    // a post-stop source status; revision/counts were observed at followup 8.
    assert(stopped.canvas.id === id && stopped.canvas.connected && stopped.canvas.revision === 8 &&
      !stopped.canvas.lost && stopped.gl.errors === 0 && stopped.release.status === "PASS", "STOP_NOT_RELEASED");
    assert(!stopped.rows.some(r => r.kind === "draw") && stopped.raf.live === 0, "DRAW_AFTER_STOP");
    return { status: "PASS", reason: "SAME_CANVAS_NATIVE_AND_CONTINUOUS_GPU_MATCH",
      canvasId: id, restoredRevision: restoreRevision, continuedRevisions: wanted };
  } catch (e) { return { status: "FAIL", reason: String(e) }; }
}
export function continuationCases({ evaluate, snap, click, wait, references }) {
  return LAYERS.flatMap((layer, index) => ["A", "B"].map((scenario, part) => ({
    name: `E5 ${layer} Scenario ${scenario}`, gate: "core", run: async () => {
      const selector = `.${layer === "heatmap" ? "hm" : "bb"}-canvas`;
      await evaluate("window.__canvasContinuationInput.setCeiling(2)");
      await evaluate(`window.__b2resources.beginSession(${index * 2 + part + 1})`);
      await click(index === 0 && part === 0 ? "button-unified-start" : "button-unified-restart");
      await wait(`window.__orderflowMockDiagnostics.progress().status.revision===2 &&
        document.querySelector('${selector}')?.dataset.revision==="2" &&
        window.__b2gl.snapshot().totals.${layer}.draws>0`);
      await wait(`window.__canvasPhaseA.snapshot().then(s=>s.rows.some(r=>r.kind==="draw" &&
        r.layer==="${layer}" && r.revision===2 && r.tokenRevision===2))`, 5000, true);
      let cursor = (await snap()).phase.rows.length;
      const pack = async () => {
        const s = await snap(), rows = s.phase.rows.slice(cursor).filter(r => r.layer === layer);
        cursor = s.phase.rows.length;
        const canvas = s.phase.contexts.find(c => c.layer === layer && c.connected);
        const emptyPixels = layer === "bubble" && canvas?.revision === 2 && !canvas.lost
          ? await evaluate(`window.__canvasPhaseA.emptyPixels("${layer}")`) : null;
        return { canvas, rows, emptyPixels, source: s.progress?.status ?? null, raf: s.phase.totals[layer], gl: s.gl.totals[layer],
          size: s.layers.find(c => c.layer === layer), inputGate: s.inputGate,
          release: resourceReleaseGate(s.resources, s.ownership),
          limited: s.phase.limited || s.gl.limited || !!s.phase.unrecorded };
      };
      const before = await pack(), canvasId = before.canvas?.id;
      assert(Number.isSafeInteger(canvasId), "CONTINUATION_IDENTITY_UNOBSERVED");
      const requested = await evaluate(`window.__canvasPhaseA.intervene("${layer}","lose")`);
      if (requested !== "REQUESTED") return { status: requested, reason: "EXTENSION_UNAVAILABLE" };
      await wait(`document.querySelector('${selector}').dataset.status==="CONTEXT LOST"`);
      const revision = scenario === "A" ? 2 : 4;
      if (scenario === "B") {
        await evaluate("window.__canvasContinuationInput.setCeiling(4)");
        await wait(`window.__orderflowMockDiagnostics.progress().status.revision===4 &&
          document.querySelector('${selector}').dataset.revision==="4"`);
      }
      const lost = await pack();
      await evaluate(`window.__canvasPhaseA.intervene("${layer}","restore")`);
      await wait(`document.querySelector('${selector}').dataset.status==="READY" &&
        window.__canvasPhaseA`);
      const restored = await pack(), followups = [];
      for (let next = revision + 1; next <= 8; next++) {
        await evaluate(`window.__canvasContinuationInput.setCeiling(${next})`);
        await wait(`window.__orderflowMockDiagnostics.progress().status.revision===${next} &&
          document.querySelector('${selector}').dataset.revision==="${next}"`);
        // DOM commit alone is not a draw: wait for the real observer's GPU draw.
        await wait(`window.__canvasPhaseA.snapshot().then(s=>s.rows.some(r=>r.kind==="draw" &&
          r.canvasId===${canvasId} && r.revision===${next}))`, 5000, true);
        followups.push(await pack());
      }
      await click("button-unified-stop");
      await new Promise(r => setTimeout(r, 350));
      const stopped = await pack();
      const result = { layer, scenario, before, lost, restored, followups, stopped };
      return { ...assessContinuation(result, references), observation: result };
    },
  })));
}
export async function runCases(cases, record) {
  for (const c of cases) {
    let result;
    try { result = { name: c.name, gate: c.gate, ...await c.run() }; }
    catch (e) { result = { name: c.name, gate: c.gate, status: "FAIL", reason: String(e) }; }
    assert(["PASS", "FAIL", "UNKNOWN", "NOT_SUPPORTED"].includes(result.status), "INVALID_CLASSIFICATION");
    await record(result);
    if (result.status === "FAIL" || (c.gate === "core" && result.status !== "PASS")) return false;
  }
  return true;
}
export async function saveEvidence(path, value) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  assert(Buffer.byteLength(bytes) <= LIMIT, "PHASE_A_EVIDENCE_LIMIT");
  await writeFile(path, bytes, { flag: "wx" });
  return { path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) };
}

// Runs in the page realm. A failed query is an error, never "unsupported=false".
export function observeGpu() {
  let gl, result, observationError, cleanupError;
  try {
    gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) throw Error("GPU_CONTEXT_UNAVAILABLE");
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    if (typeof renderer !== "string" || !renderer) throw Error("GPU_RENDERER_UNOBSERVED");
    const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (timer !== null && typeof timer !== "object") throw Error("GPU_TIMER_EXTENSION_UNOBSERVED");
    result = { webgl2: true, renderer, timerExtension: timer !== null };
  } catch (e) { observationError = String(e); }
  finally {
    if (gl) {
      try { gl.getExtension("WEBGL_lose_context")?.loseContext(); }
      catch (e) { cleanupError = String(e); }
    }
  }
  if (observationError || cleanupError)
    throw Error(JSON.stringify({ reason: "GPU_OBSERVATION_FAILED", observationError, cleanupError }));
  return result;
}
export async function afterStartupVerification(chromium, gpu, dpr, baseline, run) {
  assert(gpu && gpu.webgl2 === true && typeof gpu.renderer === "string" &&
    typeof gpu.timerExtension === "boolean", "GPU_SCHEMA_INCOMPLETE");
  validateE2BrowserStartup(chromium, gpu, dpr, baseline);
  return run();
}
export function assessPageCleanup(snapshot) {
  if (!snapshot) return { status: "NOT_OBSERVED", reason: "PAGE_SNAPSHOT_UNAVAILABLE" };
  const resources = resourceReleaseGate(snapshot.resources, snapshot.ownership);
  if (resources.status !== "PASS") return {
    status: resources.status === "FAIL" ? "FAIL" : "UNKNOWN", reason: resources.reason, resources,
  };
  const phase = snapshot.phase;
  if (!phase || !Array.isArray(phase.contexts))
    return { status: "NOT_OBSERVED", reason: "BUFFER_OBSERVATION_UNAVAILABLE", resources };
  if (phase.limited || phase.unrecorded) return { status: "FAIL", reason: "RESOURCE_OBSERVATION_LIMIT", resources };
  if (!phase.contexts.length) {
    if (!Array.isArray(snapshot.layers) || snapshot.layers.length !== 0 ||
      !LAYERS.every(l => snapshot.gl?.totals?.[l]?.contexts === 0))
      return { status: "UNKNOWN", reason: "NO_INDEPENDENT_CONTEXT_ABSENCE_PROOF", resources };
    return { status: "PASS", resources, buffers: { status: "NOT_APPLICABLE",
      reason: "NO_LAYER_CANVAS_AND_NO_CONTEXT_IN_TWO_OBSERVERS" } };
  }
  if (!phase.contexts.every(c => ["created", "deleted", "invalidated", "liveBuffers"]
    .every(k => Number.isSafeInteger(c[k]) && c[k] >= 0)))
    return { status: "UNKNOWN", reason: "BUFFER_COUNTS_UNAVAILABLE", resources };
  const released = phase.contexts.every(c => c.liveBuffers === 0 && c.created === c.deleted + c.invalidated);
  return { status: released ? "PASS" : "FAIL", reason: released ? "BUFFER_ACCOUNTING_MATCH" : "BUFFER_LEAK", resources };
}
// Used by the real finally and offline fault injection. Cleanup cannot erase the trial failure.
export async function cleanupPhase(report, io) {
  const cleanup = report.cleanup = { page: { status: "NOT_OBSERVED" },
    browser: { status: "NOT_OBSERVED" }, profile: { status: "NOT_OBSERVED" },
    evidence: { status: "PENDING" }, errors: [] };
  const fail = (stage, e) => {
    cleanup.errors.push({ stage, error: String(e) });
    report.status = "FAIL";
    report.failure ??= `${stage}:${String(e)}`;
  };
  try {
    if (io.pageAvailable()) {
      await io.exitPage();
      report.cleanupPage = await io.snapshot();
      cleanup.page = assessPageCleanup(report.cleanupPage);
      if (cleanup.page.status !== "PASS") fail("PAGE_CLEANUP", cleanup.page.reason);
    } else fail("PAGE_CLEANUP", "PAGE_NOT_OBSERVED");
  } catch (e) {
    cleanup.page = { status: "FAIL", reason: String(e) };
    report.cleanupFailure = String(e); fail("PAGE_CLEANUP", e);
  }
  try {
    report.termination = await io.finishBrowser();
    cleanup.browser = { status: report.termination.status };
    if (report.termination.status !== "PASS" || report.termination.signal?.attempted)
      fail("BROWSER_CLEANUP", report.termination.reason ?? "TERMINATION_NOT_CLEAN");
  } catch (e) { cleanup.browser = { status: "FAIL", reason: String(e) }; fail("BROWSER_CLEANUP", e); }
  try {
    const remaining = await io.inspectGroup();
    assert(Array.isArray(remaining.live) && Array.isArray(remaining.zombies), "GROUP_NOT_OBSERVED");
    report.chromiumCleanup = { live: remaining.live, zombies: remaining.zombies, profileRemoved: false };
    if (remaining.live.length || remaining.zombies.length) {
      cleanup.profile = { status: "NOT_REMOVED", reason: "BROWSER_GROUP_REMAINS" };
      fail("PROCESS_CLEANUP", "BROWSER_GROUP_REMAINS");
    } else {
      await io.removeProfile();
      report.chromiumCleanup.profileRemoved = true;
      cleanup.profile = { status: "PASS" };
    }
  } catch (e) { cleanup.profile = { status: "FAIL", reason: String(e) }; fail("PROFILE_CLEANUP", e); }
  report.phaseBEligible = report.status === "PASS" && cleanup.page.status === "PASS" &&
    cleanup.browser.status === "PASS" && cleanup.profile.status === "PASS";
  cleanup.evidence = { status: "WRITE_REQUESTED" };
  try { await io.persistEvidence(); cleanup.evidence.status = "WRITTEN"; }
  catch (e) {
    cleanup.evidence = { status: "FAIL", reason: String(e) };
    fail("EVIDENCE_WRITE", e); report.phaseBEligible = false;
    io.evidenceFailure?.({ status: report.status, failure: report.failure, cleanup });
  }
  return report;
}

// External, Phase-A-only observation. Never changes renderer inputs or application state.
export function installPhaseObserver() {
  const rows = [], contexts = new Map(), pending = new Set(), rafs = new Map();
  const totals = Object.fromEntries(["heatmap", "bubble"].map(l => [l,
    { reserved: 0, executed: 0, cancelled: 0, live: 0 }]));
  const saved = {}, proto = WebGL2RenderingContext.prototype;
  let limited = false, unrecorded = 0, serial = 0;
  const push = row => {
    if (rows.length >= 2048) { limited = true; unrecorded++; return; }
    rows.push({ at: performance.now(), ...row });
  };
  const layerOf = canvas => canvas.classList.contains("hm-canvas") ? "heatmap" :
    canvas.classList.contains("bb-canvas") ? "bubble" : null;
  const revision = canvas => Number(canvas.dataset.revision || -1);
  const active = layer => {
    const c = [...contexts.values()].find(c => c.layer === layer && c.canvas.isConnected);
    return { canvasId: c?.id ?? null, revision: c ? revision(c.canvas) : null };
  };
  const originLayer = () => {
    const stack = new Error().stack ?? "";
    return stack.includes("/components/HeatmapCanvas.tsx") ? "heatmap" :
      stack.includes("/components/BubbleCanvas.tsx") ? "bubble" : null;
  };
  saved.getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const gl = saved.getContext.apply(this, args), layer = layerOf(this);
    if (args[0] === "webgl2" && gl && layer && !contexts.has(gl)) {
      if (contexts.size >= 16) { limited = true; return gl; }
      const c = { canvas: this, layer, id: ++serial, buffers: new Set(), invalidated: 0,
         created: 0, deleted: 0, lost: false, upload: null, uploadSerial: 0, loss: 0, restore: 0 };
      contexts.set(gl, c);
      c.onLost = () => {
        c.lost = true; c.loss++; c.invalidated += c.buffers.size; c.buffers.clear();
        push({ kind: "contextlost", layer, canvasId: c.id, revision: revision(this) });
      };
      c.onRestore = () => {
        c.lost = false; c.restore++;
        push({ kind: "contextrestored", layer, canvasId: c.id, revision: revision(this) });
      };
      this.addEventListener("webglcontextlost", c.onLost);
      this.addEventListener("webglcontextrestored", c.onRestore);
    }
    return gl;
  };
  for (const name of ["createBuffer", "deleteBuffer", "bufferData", "drawArrays", "clearColor", "clear"]) {
    saved[name] = proto[name];
    proto[name] = function (...args) {
      const result = saved[name].apply(this, args), c = contexts.get(this);
      if (!c) return result;
      if (name === "createBuffer" && result) { c.buffers.add(result); c.created++; }
      if (name === "deleteBuffer" && args[0] && c.buffers.delete(args[0])) c.deleted++;
      if (name === "clearColor" || name === "clear") push({
        kind: name, layer: c.layer, canvasId: c.id, revision: revision(c.canvas), lost: this.isContextLost(),
        ...(name === "clear" ? { mask: args[0], scissor: this.isEnabled(this.SCISSOR_TEST) } : { rgba: [...args] }),
      });
      if (name === "bufferData" && args[0] === 34962 && ArrayBuffer.isView(args[1])) {
        const data = args[1];
        if (data.byteLength > 262144 || pending.size >= 8) { limited = true; unrecorded++; return result; }
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        const upload = c.upload = { bytes: bytes.byteLength, sha256: null };
        const uploadSerial = ++c.uploadSerial;
        push({ kind: "upload", layer: c.layer, canvasId: c.id, revision: revision(c.canvas),
          uploadSerial, lost: this.isContextLost(), upload });
        const job = crypto.subtle.digest("SHA-256", bytes).then(hash => {
          upload.sha256 = [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, "0")).join("");
        }).catch(() => { limited = true; }).finally(() => pending.delete(job));
        pending.add(job);
      }
      if (name === "drawArrays") {
        const token = window.__orderflowMockDiagnostics?.activeDraw();
        push({ kind: "draw", layer: c.layer, canvasId: c.id, revision: revision(c.canvas),
          tokenRevision: token?.revision ?? null, vertices: args[2], lost: this.isContextLost(),
          uploadSerial: c.uploadSerial, upload: c.upload });
      }
      return result;
    };
  }
  saved.raf = window.requestAnimationFrame; saved.cancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = function (fn) {
    const layer = originLayer();
    const id = saved.raf.call(window, function (stamp) {
      if (layer) {
        rafs.delete(id); totals[layer].executed++; totals[layer].live--;
        push({ kind: "execute", layer, rafId: id, ...active(layer) });
      }
      return fn.call(this, stamp);
    });
    if (layer) {
      if (rafs.size >= 16) { limited = true; unrecorded++; }
      rafs.set(id, layer); totals[layer].reserved++; totals[layer].live++;
      push({ kind: "reserve", layer, rafId: id, ...active(layer) });
    }
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    const layer = rafs.get(id);
    if (layer) {
      rafs.delete(id); totals[layer].cancelled++; totals[layer].live--;
      push({ kind: "cancel", layer, rafId: id, ...active(layer) });
    }
    return saved.cancel.call(window, id);
  };
  window.__canvasPhaseA = {
    async snapshot() {
      await Promise.all([...pending]);
      return { rows: rows.map(({ upload, ...r }) => upload ? { ...r, bytes: upload.bytes, sha256: upload.sha256 } : r),
        totals: structuredClone(totals), limited, unrecorded, contexts: [...contexts.values()].map(c => ({
          id: c.id, layer: c.layer, revision: revision(c.canvas), connected: c.canvas.isConnected,
          created: c.created, deleted: c.deleted, invalidated: c.invalidated, liveBuffers: c.buffers.size,
          lost: c.lost, loss: c.loss, restore: c.restore,
        })) };
    },
    // Read-only observations of the real default framebuffer. Five samples are
    // reported as samples, not a full-frame pixel comparison.
    emptyPixels(layer) {
      const entry = [...contexts.entries()].find(([, c]) => c.layer === layer && c.canvas.isConnected);
      if (!entry) return null;
      const [gl, c] = entry, w = c.canvas.width, h = c.canvas.height, rgba = [];
      const defaultFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === null &&
        gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === null;
      if (gl.isContextLost() || !defaultFramebuffer) return { canvasId: c.id, defaultFramebuffer, lost: true };
      for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [Math.floor(w / 2), Math.floor(h / 2)]]) {
        const pixel = new Uint8Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); rgba.push(...pixel);
      }
      return { canvasId: c.id, revision: revision(c.canvas), defaultFramebuffer,
        scissor: gl.isEnabled(gl.SCISSOR_TEST), colorMask: [...gl.getParameter(gl.COLOR_WRITEMASK)],
        rgba, error: gl.getError(), sampleCount: 5 };
    },
    // Actual extension invocation is an intervention, separate from snapshots.
    intervene(layer, action) {
      const entry = [...contexts.entries()].find(([, c]) => c.layer === layer && c.canvas.isConnected);
      if (!entry) return "UNKNOWN";
      const ext = entry[1].extension ??= entry[0].getExtension("WEBGL_lose_context");
      if (!ext) return "NOT_SUPPORTED";
      if (action === "lose") ext.loseContext(); else ext.restoreContext();
      return "REQUESTED";
    },
    dispose() {
      HTMLCanvasElement.prototype.getContext = saved.getContext;
      for (const name of ["createBuffer", "deleteBuffer", "bufferData", "drawArrays", "clearColor", "clear"]) proto[name] = saved[name];
      window.requestAnimationFrame = saved.raf; window.cancelAnimationFrame = saved.cancel;
      for (const c of contexts.values()) {
        c.canvas.removeEventListener("webglcontextlost", c.onLost);
        c.canvas.removeEventListener("webglcontextrestored", c.onRestore);
      }
      delete window.__canvasPhaseA;
    },
  };
}

// Kernel identity readers mirror the inspected formal driver; its exported termination
// and ownership verifier remain the single policy implementation.
async function identity(pid) {
  const text = await readFile(`/proc/${pid}/stat`, "utf8"), f = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  return { pid, ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), startTicks: f[19],
    uid: Number(status.match(/^Uid:\s+(\d+)/m)?.[1]), state: f[0] };
}
async function group(pgid) {
  const processes = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const p = await identity(Number(name));
      if (p.pgid === pgid || p.sid === pgid) processes.push(p);
    } catch (e) {
      if (["ENOENT", "ESRCH"].includes(e.code)) continue;
      let text;
      try { text = await readFile(`/proc/${name}/stat`, "utf8"); } catch { continue; }
      const f = text.slice(text.lastIndexOf(")") + 2).split(/\s+/);
      if (Number(f[2]) === pgid || Number(f[3]) === pgid) throw Error("OWNERSHIP_UNKNOWN");
    }
    assert(processes.length <= 256, "OWNERSHIP_OBSERVATION_LIMIT");
  }
  return { processes, live: processes.filter(p => p.pgid === pgid && !["Z", "X"].includes(p.state)).map(p => p.pid),
    zombies: processes.filter(p => p.pgid === pgid && ["Z", "X"].includes(p.state)).map(p => p.pid) };
}
export async function smoke(output, { continuation = false } = {}) {
  const baseline = await loadE2Baseline();
  const driver = await readFile(DRIVER, "utf8"), observer = resourceObserverSource(driver);
  const environment = { node: process.version, cpu: cpus()[0].model.trim(), logicalCpu: cpus().length,
    cpuMax: (await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim(),
    memoryMax: (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim() };
  validateE2ExternalEnvironment(baseline, environment);
  const report = { status: "RUNNING", environment, driverSha256: digest(driver),
    toolSha256: digest(await readFile(fileURLToPath(import.meta.url))), cases: [], phaseBEligible: false };
  let references;
  if (continuation) {
    const path = ".local/diagnostics/task28-c4-e4-r3/phase-a/report.json", bytes = await readFile(path);
    references = continuationReferences(JSON.parse(bytes));
    report.reference = { path, sha256: digest(bytes), references, use: "R3_EXPECTATION_ONLY_NOT_CURRENT_OBSERVATION" };
  }
  // The finite wall includes all interventions, navigation and cleanup.
  const dir = await mkdtemp("/tmp/orderflow-phase-a-");
  const spawnedAt = performance.now();
  const browser = spawn("/repl/tools/bin/chromium", ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run",
    "--no-default-browser-check", `--user-data-dir=${dir}`, "--remote-debugging-pipe"],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let id = 0, buffer = "", termination, started, transportFailure = null;
  const pending = new Map();
  const rejectPending = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("CDP_CLOSED")); } pending.clear(); };
  browser.on("exit", rejectPending); browser.on("error", rejectPending);
  browser.stdio[3].on("error", rejectPending); browser.stdio[4].on("error", rejectPending);
  browser.stdio[4].on("data", data => {
    buffer += data;
    if (buffer.length >= LIMIT) {
      transportFailure = "CDP_BUFFER_LIMIT"; buffer = ""; rejectPending(); return;
    }
    for (;;) {
      const i = buffer.indexOf("\0"); if (i < 0) break;
      const value = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!value) continue;
      const r = JSON.parse(value), p = pending.get(r.id); if (!p) continue;
      pending.delete(r.id); clearTimeout(p.timer);
      r.error ? p.reject(Error(`CDP_ERROR:${r.error.code}`)) : p.resolve(r.result);
    }
  });
  const call = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
    if (browser.exitCode !== null || browser.signalCode || !browser.stdio[3].writable)
      return reject(Error("CDP_UNAVAILABLE"));
    if (transportFailure && method !== "Browser.close") return reject(Error(transportFailure));
    if (termination?.expired() && method !== "Browser.close") return reject(Error("BROWSER_WALL_TIMEOUT"));
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error(`CDP_TIMEOUT:${method}`)); }, 10000);
    pending.set(n, { resolve: resolveCall, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  try { started = await identity(browser.pid); } catch { started = null; }
  const exited = () => browser.exitCode !== null || !!browser.signalCode;
  // Provide the actual immutable leader identity to the reused policy.
  // The page can never authorize a process signal.
  termination = createBrowserTermination({
    close: () => call("Browser.close"), exited, holdsLeader: () => browser.pid === started?.pid && !exited(),
    inspect: () => group(browser.pid),
    waitExit: async ms => { const end = performance.now() + ms; while (!exited() && performance.now() < end)
      await new Promise(r => setTimeout(r, 50)); },
    signal: (pid, signal) => process.kill(pid, signal),
    recover: async ms => { const end = performance.now() + ms; while (performance.now() < end) {
      const g = await group(browser.pid); if (!g.live.length && !g.zombies.length) return;
      await new Promise(r => setTimeout(r, 100));
    } },
  }, { trialId: "canvas-phase-a", started });
  const wall = setTimeout(() => { void termination.wallTimeout().catch(() => {}); },
    Math.max(0, 150000 - (performance.now() - spawnedAt)));
  let evaluate, snap, page;
  const checkpoint = () => saveEvidence(output + ".checkpoint.json", report);
  const record = async result => {
    report.cases.push(result);
    // Unique checkpoints preserve every failure/success without overwriting older evidence.
    await saveEvidence(output + `.case-${report.cases.length}.json`, result);
  };
  try {
    assert.equal(verifyBrowserOwnership(started, await group(browser.pid)).status, "PASS", "OWNERSHIP_UNKNOWN");
    const version = await call("Browser.getVersion"), target = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    page = (method, params) => call(method, params, sessionId);
    evaluate = async expression => {
      const r = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw Error(`PAGE_EVALUATION:${r.exceptionDetails.text}`);
      return r.result.value;
    };
    const wait = async (expression, ms = 5000, asyncCondition = false) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        const v = await evaluate(`(async()=>({ok:!!(${asyncCondition ? "await" : ""} (${expression})),
          record:window.__orderflowMockDiagnostics?.progress().recording,
          inputFault:window.__canvasContinuationInput?.snapshot().fault}))()`);
        assert(!v.record?.saturated && !v.record?.dropped, "DIAGNOSTIC_RECORD_LIMIT");
        assert(!v.inputFault, "INPUT_GATE_FAULT");
        if (v.ok) return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw Error("CONTEXT_OR_CONDITION_TIMEOUT");
    };
    snap = () => evaluate(`(async()=>({phase:await window.__canvasPhaseA.snapshot(),gl:window.__b2gl.snapshot(),
      resources:window.__b2resources.snapshot(),ownership:window.__b2resources.ownership(),
       inputGate:window.__canvasContinuationInput?.snapshot(),
      progress:window.__orderflowMockDiagnostics?.progress(),
       layers:[...document.querySelectorAll('.hm-canvas,.bb-canvas')].map(c=>({layer:c.classList.contains("hm-canvas")?"heatmap":"bubble",revision:Number(c.dataset.revision),
        status:c.dataset.status,width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height}))}))()`);
    const click = testid => evaluate(`document.querySelector('[data-testid="${testid}"]').click()`);
    await page("Page.enable"); await page("Network.enable");
    await page("Network.setBlockedURLs", { urls: ["*tick-stream.xyz*"] });
    await page("Page.addScriptToEvaluateOnNewDocument", {
      source: `${observer};(${installSafetyGLObserver.toString()})();(${installPhaseObserver.toString()})()
        ${continuation ? `;(${installContinuationInputGate.toString()})()` : ""}` });
    await page("Page.navigate", { url: "http://127.0.0.1:80/?mockDiagnostics=1&mockCase=cells128" });
    await wait(`!!document.querySelector('[data-testid="button-unified-start"]')`);
    // Capture only the inspected background identities, before GPU observation or MOCK input.
    await evaluate("window.__b2resources.beginSession(0)");
    report.resourceBaseline = await evaluate("window.__b2resources.ownership()");
    report.browser = { chromium: version.product, observation: "PENDING" };
    const probe = await evaluate(`(()=>{try{return{status:"COMPLETE",gpu:(${observeGpu.toString()})()}}
      catch(e){return{status:"ERROR",reason:String(e)}}})()`);
    report.browser.observation = probe.status;
    if (probe.status !== "COMPLETE") {
      report.browser.error = probe.reason;
      throw Error(probe.reason ?? "GPU_NOT_OBSERVED");
    }
    const gpu = probe.gpu;
    const dpr = await evaluate("devicePixelRatio");
    report.browser = { chromium: version.product, gpu, dpr, observation: "COMPLETE" };
    const cases = continuation ? continuationCases({ evaluate, snap, click, wait, references }) : [
      { name: "A1 initial and revision drawing / A2 accounting", gate: "core", run: async () => {
        await evaluate("window.__b2resources.beginSession(1)");
        await click("button-unified-start");
        await wait(`window.__orderflowMockDiagnostics?.inspectMeaning().summary?.revision>=1`);
        const first = await snap();
        assert(first.layers.length === 2 && first.layers.every(l => l.width === 403 && l.height === 324), "CANVAS_DIMENSIONS");
        await wait(`document.querySelector('[data-testid="status-data"]')?.textContent.includes("COMPLETED")`, 44400);
        await new Promise(r => setTimeout(r, 400));
        const end = await snap();
        const text = await evaluate("window.__orderflowMockDiagnostics.meaning()");
        const meaning = resolveBrowserMeaning("cells128", text);
        assert.equal(meaning.sha256, baseline.hashes.cells128, "FIXED_MEANING_HASH");
        assert.deepEqual(meaning.value.counts, { inputs: 128, accepted: 128, duplicate: 0, rejected: 0 });
        assert(meaning.value.checks.length === 8 && meaning.value.checks.every(c => c.ok), "GOLDEN");
        assert(["book", "heatmap", "bubbles", "delta", "volumeProfile", "quality"]
          .every(l => meaning.value.frame[l].revision === 128), "MIXED_FRAME");
        assert(!end.phase.limited && !end.gl.limited && !end.phase.unrecorded, "PHASE_RECORD_LIMIT");
        assert(Object.values(end.gl.totals).every(l => l.errors === 0), "GL_ERRORS");
        verifyDrawCoverage(end.phase.rows);
        assert(Object.values(end.phase.totals).every(rafAccounting), "RAF_ACCOUNTING");
        const beforeQuiet = structuredClone(end.phase.totals);
        await new Promise(r => setTimeout(r, 350));
        assert.deepEqual((await snap()).phase.totals, beforeQuiet, "STATS_ONLY_CALLBACKS");
        report.control = end;
        return { status: "PASS", meaningHash: meaning.sha256, first: first.layers, totals: end.phase.totals,
          drawCounts: Object.fromEntries(LAYERS.map(l => [l, end.phase.rows.filter(r => r.kind === "draw" && r.layer === l).length])) };
      } },
      ...LAYERS.map(layer => ({ name: `A5 ${layer} unchanged input actual loss/restore`, gate: "extended", run: async () => {
        const before = await snap(), prefix = before.phase.rows.length;
        const requested = await evaluate(`window.__canvasPhaseA.intervene("${layer}","lose")`);
        if (requested !== "REQUESTED") return { status: requested, reason: "EXTENSION_UNAVAILABLE" };
        await wait(`document.querySelector('.${layer === "heatmap" ? "hm" : "bb"}-canvas').dataset.status==="CONTEXT LOST"`);
        await new Promise(r => setTimeout(r, 350));
        const lost = await snap();
        await evaluate(`window.__canvasPhaseA.intervene("${layer}","restore")`);
        let timedOut = false;
        try { await wait(`document.querySelector('.${layer === "heatmap" ? "hm" : "bb"}-canvas').dataset.status==="READY"`); }
        catch (e) { if (String(e).includes("TIMEOUT")) timedOut = true; else throw e; }
        await new Promise(r => setTimeout(r, 100));
        const after = await snap();
        const draws = after.phase.rows.slice(prefix).filter(r => r.kind === "draw" && r.layer === layer);
        const reference = before.phase.rows.filter(r => r.kind === "draw" && r.layer === layer).at(-1);
        const result = assessRestore({ restored: !timedOut, timedOut, rows: draws,
          lostDraws: lost.phase.rows.slice(prefix).filter(r => r.kind === "draw" && r.layer === layer).length,
          expectedHash: reference.sha256 });
        return { ...result, draws, before: reference, lost: lost.phase.contexts, after: after.phase.contexts };
      } })),
      ...LAYERS.map((layer, i) => ({ name: `A5 ${layer} revision advances while actually lost`, gate: "extended", run: async () => {
        await evaluate(`window.__b2resources.beginSession(${i + 2})`);
        await click("button-unified-restart");
        await wait("window.__orderflowMockDiagnostics.inspectMeaning().summary?.revision>=2");
        const before = await snap(), prefix = before.phase.rows.length;
        const oldRevision = before.layers[0].revision;
        const requested = await evaluate(`window.__canvasPhaseA.intervene("${layer}","lose")`);
        if (requested !== "REQUESTED") return { status: requested, reason: "EXTENSION_UNAVAILABLE" };
        await wait(`document.querySelector('.${layer === "heatmap" ? "hm" : "bb"}-canvas').dataset.status==="CONTEXT LOST"`);
        await wait(`window.__orderflowMockDiagnostics.inspectMeaning().summary?.revision>=${oldRevision + 2}`);
        // Existing Stop freezes inputs but does not mutate analytical state.
        await click("button-unified-stop");
        await new Promise(r => setTimeout(r, 300));
        const lost = await snap(), latest = lost.layers[0].revision;
        const lostDraws = lost.phase.rows.slice(prefix).filter(r => r.kind === "draw" && r.layer === layer).length;
        await evaluate(`window.__canvasPhaseA.intervene("${layer}","restore")`);
        let timedOut = false;
        try { await wait(`document.querySelector('.${layer === "heatmap" ? "hm" : "bb"}-canvas').dataset.status==="READY"`); }
        catch (e) { if (String(e).includes("TIMEOUT")) timedOut = true; else throw e; }
        await new Promise(r => setTimeout(r, 150));
        const after = await snap(), rows = after.phase.rows.slice(prefix).filter(r => r.kind === "draw" && r.layer === layer);
        const reference = report.control.phase.rows.find(r => r.kind === "draw" && r.layer === layer && r.revision === latest);
        const result = assessRestore({ restored: !timedOut, timedOut, lostDraws, rows, expectedHash: reference?.sha256 });
        return { ...result, oldRevision, latest, referenceHash: reference?.sha256, rows,
          after: after.phase.contexts, resources: after.resources };
      } })),
      { name: "A4 existing UI operations", gate: "extended", run: async () => {
        const operations = [];
        const operation = async (name, intervene) => {
          const before = await snap();
          await intervene();
          await new Promise(r => setTimeout(r, 350));
          const after = await snap();
          assert(after.layers.every(l => l.status === "READY" && l.revision === before.layers[0].revision),
            "UI_OPERATION_REVISION_OR_STATUS");
          assert(Object.values(after.gl.totals).every(l => l.errors === 0), "UI_GL_ERROR");
          const draws = after.phase.rows.length - before.phase.rows.length;
          return { name, status: draws > 0 ? "PASS" : "UNKNOWN",
            reason: draws > 0 ? "SAME_REVISION_REDRAW_OBSERVED" : "OPERATION_EFFECT_NOT_INDEPENDENTLY_PROVEN",
            beforeRevision: before.layers[0].revision, afterRevision: after.layers[0].revision, observedRows: draws };
        };
        const box = await evaluate(`(()=>{const r=document.querySelector('[data-testid="chart-area"]').getBoundingClientRect();
          return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
        operations.push(await operation("zoom", () => evaluate(`document.querySelector('[data-testid="chart-area"]')
          .dispatchEvent(new WheelEvent("wheel",{deltaY:-100,clientX:${box.x},clientY:${box.y},bubbles:true,cancelable:true}))`)));
        operations.push(await operation("pan", async () => {
          await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
          await page("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
          await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + 20, y: box.y, button: "left", buttons: 1 });
          await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + 20, y: box.y, button: "left" });
        }));
        operations.push(await operation("resize", () => page("Emulation.setDeviceMetricsOverride",
          { width: 820, height: 600, deviceScaleFactor: 1, mobile: false })));
        operations.push(await operation("DPR", () => page("Emulation.setDeviceMetricsOverride",
          { width: 820, height: 600, deviceScaleFactor: 2, mobile: false })));
        await page("Emulation.clearDeviceMetricsOverride");
        // Settings are draft previews only. Never use Save or write a settings file.
        await click("button-settings");
        await wait(`!!document.querySelector('[data-testid="settings-drawer"]')`);
        const tab = await evaluate(`!!document.querySelector('[data-testid="settings-tab-heatmap"]')`);
        if (tab) await click("settings-tab-heatmap");
        const threshold = await evaluate(`!!document.querySelector('[data-testid="settings-heatmap-minimumVolume"]')`);
        if (threshold) {
          operations.push(await operation("threshold", () => evaluate(`(()=>{const e=document.querySelector('[data-testid="settings-heatmap-minimumVolume"]');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"2");
            e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));})()`)));
        } else operations.push({ name: "threshold", status: "NOT_SUPPORTED", reason: "UI_FIELD_UNAVAILABLE" });
        operations.push({ name: "colors", status: "UNKNOWN", reason: "Color field traversal not independently audited" });
        await click("button-settings-cancel");
        await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
        const tooltip = await evaluate(`!!document.querySelector('.hm-tip,.bb-tip')`);
        operations.push({ name: "hover", status: tooltip ? "PASS" : "UNKNOWN",
          reason: tooltip ? "ACTUAL_TOOLTIP_OBSERVED" : "CENTER_POINT_NOT_PROVEN_TO_HIT_DATA" });
        operations.push({ name: "pin", status: "UNKNOWN", reason: "No independently identified projected bubble point" });
        return { status: operations.every(o => o.status === "PASS") ? "PASS" : "UNKNOWN", operations };
      } },
      { name: "A3 stop / restart / unmount / remount", gate: "core", run: async () => {
        await click("button-unified-restart");
        await wait("window.__orderflowMockDiagnostics.inspectMeaning().summary?.revision>=2");
        await click("button-unified-stop");
        await new Promise(r => setTimeout(r, 350));
        const stopped = await snap();
        assert(Object.values(stopped.phase.totals).every(t => t.live === 0), "STOP_RAF_RESIDUAL");
        await click("button-unified-restart");
        await wait("window.__orderflowMockDiagnostics.inspectMeaning().summary?.revision>=1");
        await evaluate(`window.dispatchEvent(new Event("orderflow:diagnostic-unmount"))`);
        await wait("!document.querySelector('.shell')");
        await new Promise(r => setTimeout(r, 350));
        const released = await snap();
        const count = released.phase.rows.filter(r => r.kind === "draw").length;
        await new Promise(r => setTimeout(r, 200));
        assert.equal((await snap()).phase.rows.filter(r => r.kind === "draw").length, count, "DRAW_AFTER_UNMOUNT");
        assert.equal(resourceReleaseGate(released.resources, released.ownership).status, "PASS", "RESOURCE_RELEASE");
        assert(released.phase.contexts.every(c => c.liveBuffers === 0 &&
          c.created === c.deleted + c.invalidated), "BUFFER_LEAK");
        report.afterRelease = released;
        return { status: "PASS", stopped, released, remount: "UNKNOWN_NO_PRODUCT_CONTROL" };
      } },
    ];
    report.passedSequence = await afterStartupVerification(version.product, gpu, dpr, baseline,
      () => runCases(cases, record));
    report.status = report.passedSequence ? "PASS" : "FAIL";
  } catch (e) { report.status = "FAIL"; report.failure = String(e); }
  finally {
    await cleanupPhase(report, {
      pageAvailable: () => !!(evaluate && snap),
      exitPage: async () => {
        await evaluate(`document.querySelector('[data-testid="button-unified-exit"]')?.click()`);
        await new Promise(r => setTimeout(r, 400));
        if (continuation) {
          report.inputGate = await evaluate("window.__canvasContinuationInput.snapshot()");
          await evaluate("window.__canvasContinuationInput.dispose()");
        }
      },
      snapshot: () => snap(),
      finishBrowser: async () => { try { return await termination.finish(); } finally { clearTimeout(wall); } },
      inspectGroup: () => {
        assert(Number.isSafeInteger(browser.pid), "BROWSER_IDENTITY_UNAVAILABLE");
        return group(browser.pid);
      },
      removeProfile: () => rm(dir, { recursive: true }),
      persistEvidence: async () => {
        await mkdir(resolve(output, ".."), { recursive: true });
        await checkpoint();
        await saveEvidence(output, report);
      },
      evidenceFailure: value => console.error("PHASE_A_EVIDENCE_WRITE_FAILED", JSON.stringify(value)),
    });
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  assert(output && output.startsWith(".local/diagnostics/task28-c4-e4/"), "EXPLICIT_NEW_OUTPUT_REQUIRED");
  const report = await smoke(output);
  console.log(JSON.stringify({ status: report.status, cases: report.cases.map(c => ({ name: c.name, status: c.status,
    reason: c.reason })), phaseBEligible: report.phaseBEligible, termination: report.termination,
    chromiumCleanup: report.chromiumCleanup }));
  if (report.status !== "PASS") process.exitCode = 1;
}
