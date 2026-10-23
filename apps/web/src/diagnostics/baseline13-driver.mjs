// Existing Chromium + native CDP pipe only. No dependencies, external URLs or application timers.
// Offline codec capacity: node .../baseline13-driver.mjs [new output.json] capacity
// Legacy browser preflight entry remains separate; never invoked by capacity/tests.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

async function capacityOnly(output) {
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
}
// Importing the decoder in tests never starts Chromium or any input session.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
