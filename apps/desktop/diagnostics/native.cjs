/* One native production-built diagnostic session. Original main + preload and
 * security policy remain intact. Only the local built-asset root is redirected. */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { gzipSync } = require("node:zlib");
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const out = path.resolve(arg("output")), stage = Number(arg("stage")), build = path.resolve(arg("build"));
let save, wall, web, fault = null, complete = false, result = { stage, status: "RUNNING", forcedTermination: false };
let records = [], recordBytes = 0, count = 0, block = 0, receipts = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const policy = require("../dist/main/policy.js"), original = policy.localResponse;
policy.localResponse = request => original(request, build); // Assets only, not market state.
const disposed = async () => {
  if (!web || web.isDestroyed()) return;
  try { return await web.executeJavaScript("window.__load29?.dispose()"); } catch { return null; }
};
process.on("SIGTERM", () => {
  fault ??= "PARENT_STOP"; result.status = "FAIL"; result.error = fault;
  try { if (save) { flush(); result.blocks = receipts; result.recordCount = count; save("emergency.json", result); } } catch {}
  app.quit();
});
const flush = () => {
  if (!records.length) return;
  const raw = Buffer.from(JSON.stringify(records)), { createHash } = require("node:crypto");
  receipts.push(save(`block-${String(block++).padStart(3, "0")}.json`, {
    codec: "gzip/base64", bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex"),
    data: gzipSync(raw).toString("base64"),
  }));
  records = []; recordBytes = 0;
};
require("../dist/main/main.js");
app.whenReady().then(async () => {
  try {
    const { writer, LIMITS, geometryGate, stats } = await import("./contracts.mjs");
    save = writer(out, path.dirname(out));
    assert([0, 1, 2].includes(stage), "STAGE");
    const definition = JSON.parse(fs.readFileSync(arg("input")));
    result.versions = process.versions;
    assert.equal(process.versions.electron, "45.0.0", "ELECTRON_VERSION");
    assert.equal(process.versions.chrome, "156.0.8078.48", "CHROMIUM_VERSION");
    wall = setTimeout(() => { fault = "WALL_TIMEOUT"; void disposed().finally(() => app.quit()); }, LIMITS.wall[stage]);
    let win;
    for (let i = 0; i < 150; i++) {
      win = BrowserWindow.getAllWindows()[0];
      if (win && win.isVisible() && !win.webContents.isLoading() && win.webContents.getURL()) break;
      await wait(100);
    }
    assert(win, "NATIVE_WINDOW_MISSING"); web = win.webContents;
    result.window = { visible: win.isVisible(), bounds: win.getBounds(), preferences: web.getLastWebPreferences() };
    assert(result.window.visible && result.window.preferences.sandbox &&
      result.window.preferences.contextIsolation && !result.window.preferences.nodeIntegration, "WINDOW_SECURITY");
    assert.equal(web.getURL(), "orderflow://app/index.html", "PRODUCTION_ORIGIN");
    web.on("console-message", (_e, level) => { if (level === 3) fault ??= "RENDERER_CONSOLE_ERROR"; });
    web.on("preload-error", () => { fault ??= "PRELOAD_ERROR"; });
    web.debugger.attach("1.3");
    await web.debugger.sendCommand("Runtime.enable");
    await web.debugger.sendCommand("Performance.enable");
    await web.debugger.sendCommand("Runtime.addBinding", { name: "__load29Send" });
    web.debugger.on("message", (_event, method, p) => {
      if (method !== "Runtime.bindingCalled" || p.name !== "__load29Send") return;
      try {
        const row = JSON.parse(p.payload), n = Buffer.byteLength(p.payload);
        assert(n <= LIMITS.file && ++count <= LIMITS.rows, "RECORD_CAP");
        if (recordBytes + n > 1024 ** 2) flush();
        records.push(row); recordBytes += n;
        if (row.kind === "failure") fault ??= row.fault;
        if (row.kind === "complete") complete = true;
      } catch (e) { fault ??= String(e); }
    });
    const evaluate = expression => web.executeJavaScript(expression);
    for (let i = 0; !await evaluate("!!window.__desktopA2Ready"); i++) {
      assert(i < 100, "BOOTSTRAP_TIMEOUT"); await wait(100);
    }
    result.before = await evaluate(`({dpr:devicePixelRatio,innerWidth,innerHeight,
      bridge:window.orderflowDesktop,requireType:typeof window.require,processType:typeof window.process})`);
    assert(result.before.dpr === 1 && result.before.requireType === "undefined" &&
      result.before.processType === "undefined" && result.before.bridge.mode === "MOCK / SIMULATED", "RENDERER_ISOLATION");
    await evaluate(`window.dispatchEvent(new CustomEvent("desktop-a2-input",{detail:${JSON.stringify({ stage, definition })}}))`);
    for (let i = 0; !await evaluate('!!window.__load29 && !!document.querySelector(\'[data-testid="chart-area"]\')'); i++) {
      assert(i < 100, "ENTRY_TIMEOUT"); await wait(100);
    }
    // Declare the Canvas size from the actual pre-input plot, never a 403px constant.
    result.expected = await evaluate(`(()=>{const grid=document.querySelector(".cs-grid");
      return {innerWidth,innerHeight,dpr:devicePixelRatio,width:grid.clientWidth-72-240,height:324,
        recipe:"pre-input grid clientWidth minus existing price axis 72 and VP 240; stable scrollbar"};})()`);
    save("start.json", { stage, before: result.before, window: result.window, expected: result.expected,
      inputSha256: definition.inputSha256, productionBuild: true, independentSession: true });
    await evaluate("window.__load29.start()");
    while (!complete) { assert(!fault, fault); await wait(100); }
    await wait(250); assert(!fault, fault);
    result.state = await evaluate("window.__load29.snapshot()");
    result.finalUi = await evaluate(`({
      vpTotals:document.querySelector('[data-testid="vp-totals"]')?.textContent,
      vpSummary:document.querySelector('[data-testid="vp-levels-summary"]')?.textContent,
      vpRows:[...document.querySelectorAll('[data-testid^="vp-row-"]')].map(e=>e.textContent),
      gpuSecurity:window.orderflowDesktop,
      externalFetch: "NOT_ATTEMPTED (deny policy unit-tested; no external network probe)"
    })`);
    result.observer = await evaluate("window.__load29Observer.snapshot()");
    result.geometry = await evaluate("window.__load29Observer.geometry()");
    geometryGate(result.geometry, result.expected);
    const s = result.state;
    assert.equal(s.status.processedInputs, definition.inputs.length, "INPUT_COUNT");
    assert.equal(s.revision, definition.inputs.length, "FINAL_REVISION");
    assert(s.panels.every(p => p.exists && p.rect.width > 0 && p.rect.height > 0 &&
      (p.testid === "delta-panel" || Number(p.revision) === s.revision)), "PANEL_REVISION");
    assert(s.panels.find(p => p.testid === "vp-panel").svgRects > 0, "VP_EMPTY");
    assert(!result.observer.fault && result.observer.totals.errors === 0, "GL_ERROR");
    assert(result.observer.contexts.length === 2 && result.observer.contexts.every(c =>
      c.connected && !c.lost && c.error === 0 && /SwiftShader/.test(c.renderer)), "CONTEXT_OR_GPU");
    result.metrics = await web.debugger.sendCommand("Performance.getMetrics");
    result.appMetrics = app.getAppMetrics();
    assert(!s.recorder.saturated && s.recorder.dropped === 0, "DIAGNOSTIC_LOSS");
    const reads = s.readRows, obs = result.observer.rows, ing = s.recorder.rows ?? [];
    result.performance = {
      interval: "start to final completed publication; resize and cleanup excluded",
      frameMiss: stats(reads.filter(r => r.cache === "MISS").map(r => r.ms)),
      frameHit: stats(reads.filter(r => r.cache === "HIT").map(r => r.ms)),
      reactRoot: stats(s.reactRows.map(r => r.ms)),
      heatmapGlCallCpu: stats(obs.filter(r => r.kind === "draw" && r.layer === "heatmap").map(r => r.ms)),
      bubbleGlCallCpu: stats(obs.filter(r => r.kind === "draw" && r.layer === "bubble").map(r => r.ms)),
      deltaEffect: stats(obs.filter(r => r.kind === "delta-draw").map(r => r.ended - r.started)),
      rafWait: stats(obs.filter(r => r.kind === "raf").map(r => r.wait)),
      publishTimerLateness: stats(s.frameRows.map(r => Math.max(0, r.at - r.due))),
      ingestSynchronous: stats(ing.filter(r => r.stage === "ingest").map(r => r.ms)),
      inputTimerLateness: stats(ing.filter(r => r.stage === "timer").map(r => r.ms)),
      vpCpu: "UNKNOWN (no isolated product VP instrumentation)",
      gpuExecution: "UNKNOWN", recorderRows: ing.length,
      uiEndToEndLatency: "UNKNOWN (no per-input-to-pixel timestamp)",
    };
    const image = (await web.capturePage()).toPNG();
    save("window-capture.json", { encoding: "png/base64", sha256: require("node:crypto").createHash("sha256").update(image).digest("hex"),
      data: image.toString("base64") });
    // Outside measured interval: actual native resize, unchanged input revision.
    win.setSize(1100, 800); await wait(400);
    result.resize = await evaluate("window.__load29Observer.geometry()");
    assert(result.resize.canvases[0].cssWidth !== result.geometry.canvases[0].cssWidth, "RESIZE_NOT_OBSERVED");
    assert(result.resize.canvases.every(c => c.width === Math.round(c.cssWidth * result.resize.dpr) &&
      c.bufferWidth === c.width && c.bufferHeight === c.height), "RESIZE_BUFFER");
    assert.equal(await evaluate("window.__load29.snapshot().revision"), s.revision, "RESIZE_REVISION");
    result.dispose = await disposed(); await wait(100);
    result.afterObserver = await evaluate("window.__load29Observer.snapshot()");
    assert.equal(result.dispose.timers, 0); assert.equal(result.dispose.after.subscribers, 0);
    assert.equal(result.dispose.mountedCanvases, 0);
    assert.equal(result.afterObserver.pending, 0);
    assert.equal(result.afterObserver.totals.buffers, result.afterObserver.totals.deletes, "BUFFER_REMAINDER");
    await evaluate("window.__load29Observer.dispose()");
    result.status = "PASS";
  } catch (e) {
    result.status = "FAIL"; result.error = String(e);
    await disposed();
  } finally {
    clearTimeout(wall);
    if (fault) { result.status = "FAIL"; result.error ??= fault; }
    try { flush(); result.blocks = receipts; result.recordCount = count; save("native-result.json", result); }
    catch (e) { result.status = "FAIL"; console.error("EVIDENCE_SAVE_FAILED"); }
    if (result.status !== "PASS") process.exitCode = 1;
    if (web?.debugger.isAttached()) web.debugger.detach();
    process.stdout.write("\nA2_CLEANUP\n");
    app.quit();
  }
}).catch(() => { process.exitCode = 1; app.quit(); });
