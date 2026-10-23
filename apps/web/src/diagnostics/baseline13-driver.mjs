// Existing Chromium + native CDP pipe only. No dependencies, external URLs or application timers.
// Functional verification only: node .../baseline13-driver.mjs [new output.json] [baseline13|cells128] [preflight]
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

function installGLObserver(compact = false) {
  const proto = WebGL2RenderingContext.prototype, saved = new Map(), contexts = new WeakMap(), listeners = [];
  const counters = () => ({
    draws: 0, vertices: 0, uploads: 0, bytes: 0, buffers: 0, deletes: 0, loss: 0, restore: 0, errors: 0, cpuMs: 0,
  });
  const totals = Object.fromEntries(["heatmap", "bubble"].map(l => [l, counters()]));
  const draws = [], frames = [], frameIndex = new Map();
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
      const info = { layer, last: null }; contexts.set(gl, info);
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
      const f = frameCounters(token?.layer === info.layer ? token.revision : -1, info.layer);
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
        total.uploads++; total.bytes += a; kind = 2;
        if (f) { f.uploads++; f.bytes += a; }
      }
      if (name === "drawArrays") {
        a = args[2]; total.draws++; total.vertices += a; kind = 3;
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
      frames: compact ? frames : undefined, limited, unrecordedApiCalls }),
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
async function browserRun(mode, repetition, lifecycle, workload) {
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
    if (mode === "on") await page("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${installGLObserver.toString()})(${workload === "cells128"})` });
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
    const start = await evaluate(`(()=>{const t=performance.now();document.querySelector('[data-testid="button-unified-start"]').click();return t})()`);
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
    assert(preflight.inspection?.allowed, "DIAGNOSTIC_SEMANTIC_LIMIT");
    const sample = await evaluate(`({meaning:window.__orderflowMockDiagnostics.meaning(),
      telemetry:window.__orderflowMockDiagnostics.snapshot(),gl:window.__b2gl?.snapshot(),
      errors:[...document.querySelectorAll('[role="alert"]')].map(e=>e.textContent)})`);
    const meaning = JSON.parse(sample.meaning);
    assert.equal(meaning.processedInputs, expectedInputs); assert.equal(meaning.counts.inputs, expectedInputs);
    assert(meaning.checks.every(c => c.ok), "GOLDEN_MISMATCH");
    const revision = meaning.frame.revision;
    const layerRevisions = ["book", "heatmap", "bubbles", "delta", "volumeProfile", "quality"].map(l => meaning.frame[l].revision);
    assert(layerRevisions.every(r => r === revision), "MIXED_FRAME");
    assert(!sample.errors.some(s => /RENDER ERROR|WebGL2 unavailable/i.test(s)), "RENDER_ERROR");
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
      meaningHash: createHash("sha256").update(sample.meaning).digest("hex"),
      completionObservedMs: observedCompletion - start, telemetry: sample.telemetry, gl: sample.gl ?? null };
    if (workload === "baseline13") assert.equal(result.meaningHash,
      "dfe56d920917807ed5265bae6ba1c3039a36a3729207c4d1ae38da2c0dc54d27", "BASELINE_HASH_REGRESSION");
    if (lifecycle) {
      // The existing UI intentionally disables Stop after COMPLETED. Exercise it while RUNNING.
      await evaluate(`document.querySelector('[data-testid="button-unified-restart"]').click()`);
      await wait("window.__orderflowMockDiagnostics?.snapshot()?.sessionId===2");
      const fresh = await evaluate("window.__orderflowMockDiagnostics.snapshot()");
      assert(!fresh.rows.some(r => r.stage === "ingest")); // before the first 300ms input
      result.restartFresh = fresh.sessionId === 2;
      await evaluate(`document.querySelector('[data-testid="button-unified-stop"]').click()`);
      await wait("!window.__orderflowMockDiagnostics");
      result.stopReleased = true;
      await evaluate(`document.querySelector('[data-testid="button-unified-restart"]').click()`);
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
    if (mode === "on") {
      result.afterReleaseGL = await evaluate("window.__b2gl.snapshot().totals");
      assert(Object.values(result.afterReleaseGL).every(t => t.buffers === t.deletes), "BUFFER_NOT_RELEASED");
      await evaluate("window.__b2gl.dispose()");
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
    await rm(dir, { recursive: true, force: true });
  }
}

const output = resolve(process.argv[2] ?? ".local/diagnostics/task28-b2-b1/results.json");
const workload = process.argv[3] ?? "baseline13", phase = process.argv[4] ?? "preflight";
assert(["baseline13", "cells128"].includes(workload), "CASE_NOT_APPROVED_FOR_THIS_FUNCTIONAL_VERIFICATION");
assert(phase === "preflight", "FORMAL_COMPARISON_NOT_APPROVED");
assert(output.startsWith(resolve(".local/diagnostics") + "/"), "OUTPUT_MUST_BE_IGNORED_DIAGNOSTICS");
const report = { workload, phase, runs: [], failure: null,
  gpuMs: "UNKNOWN", presentationAt: "UNKNOWN", note: "No heavy trace; OFF has only explicit control-mode semantic readout. Completion includes DOM polling uncertainty." };
try {
  for (let r = 1; r <= (phase === "preflight" ? 1 : 3); r++) for (const mode of r % 2 ? ["control", "on"] : ["on", "control"]) {
    const sample = await browserRun(mode, r, mode === "on" && r === 1, workload);
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
