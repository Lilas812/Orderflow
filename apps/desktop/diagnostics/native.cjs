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
    const { installLayoutMonitor, layoutGate, stableLayout } = await import("./layout.mjs");
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
    await evaluate(`(${installLayoutMonitor.toString()})()`);
    if (process.argv.includes("--layout-probe")) {
      // Artificial DOM height only. No session.start, no market inputs.
      await evaluate(`document.getElementById("desktop-layout").disabled=true;
        document.documentElement.style.overflowY="scroll"`);
      await wait(300);
      result.legacyBefore = await evaluate("window.__desktopLayout.read()");
      await evaluate(`(()=>{const e=document.createElement("div");e.id="artificial-height";
        e.style.height="2000px";e.style.flexShrink="0";
        document.querySelector('[data-testid="load29-page"]').append(e);})()`);
      await wait(300);
      result.legacyAfter = await evaluate("window.__desktopLayout.read()");
      await evaluate(`document.getElementById("artificial-height").remove();
        document.documentElement.style.overflowY="";
        document.getElementById("desktop-layout").disabled=false`);
      await wait(300);
      result.fixedBefore = await evaluate("window.__desktopLayout.read()");
      await evaluate(`(()=>{const e=document.createElement("div");e.id="artificial-height";
        e.style.height="2000px";e.style.flexShrink="0";
        document.querySelector('[data-testid="load29-page"]').append(e);})()`);
      await wait(300);
      result.fixedAfter = await evaluate("window.__desktopLayout.read()");
      result.cause = {
        bodyScrollbarPx: result.legacyBefore.body.clientWidth - result.legacyAfter.body.clientWidth,
        gridLossPx: result.legacyBefore.grid.width - result.legacyAfter.grid.width,
        legacyDeclaredWidth: result.legacyBefore.grid.clientWidth - 72 - 240,
        legacyOverflowWidth: result.legacyAfter.grid.clientWidth - 72 - 240,
        fixedGridChange: result.fixedBefore.grid.width - result.fixedAfter.grid.width,
      };
      save("scrollbar-probe.json", { ...result, noMarketInput: true });
      assert.equal(result.cause.bodyScrollbarPx, 15, "SCROLLBAR_CAUSE_NOT_REPRODUCED");
      assert.equal(result.cause.gridLossPx, 15, "GRID_SCROLLBAR_CAUSE");
      assert.equal(result.cause.fixedGridChange, 0, "FIXED_SCROLLBAR_WIDTH");
      assert.equal(await evaluate("window.__load29.snapshot().status.processedInputs"), 0, "PROBE_MARKET_INPUT");
      await evaluate(`document.getElementById("artificial-height").remove();window.__desktopLayout.dispose()`);
      result.dispose = await disposed();
      await evaluate("window.__load29Observer.dispose()");
      result.status = "PASS";
      return;
    }
    await evaluate("window.__load29.prepareLayout();window.__desktopLayout.watch()");
    const settle = [];
    for (let i = 0; i < 50; i++) {
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await evaluate("window.__desktopLayout.watch()");
      settle.push(await evaluate("window.__desktopLayout.read()"));
      if (settle.length < 3) continue;
      try { result.expected = stableLayout(settle); break; } catch {}
    }
    assert(result.expected, "LAYOUT_NOT_SETTLED_BEFORE_INPUT");
    assert.equal(result.expected.height, 324, "SAVED_CANVAS_HEIGHT_CONDITION");
    assert.equal(await evaluate("window.__load29.snapshot().status.processedInputs"), 0, "PRE_LAYOUT_MARKET_INPUT");
    result.layoutBefore = settle.at(-1);
    save("start.json", { stage, before: result.before, window: result.window, expected: result.expected,
      layoutBefore: result.layoutBefore, settle, inputSha256: definition.inputSha256,
      productionBuild: true, independentSession: true });
    if (process.argv.includes("--empty-layout")) {
      // Actual mounted four-panel UI, artificial DOM height only, no market input.
      await evaluate(`(()=>{const e=document.createElement("div");e.id="artificial-height";
        e.style.height="2000px";e.style.flexShrink="0";
        document.querySelector('[data-testid="load29-page"]').append(e);})()`);
      const overflowSamples = [];
      for (let i = 0; i < 6; i++) {
        await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        const s = await evaluate("window.__desktopLayout.read()");
        layoutGate(s, result.expected); overflowSamples.push(s);
      }
      stableLayout(overflowSamples);
      result.emptyOverflow = overflowSamples;
      result.emptyState = await evaluate("window.__load29.snapshot()");
      assert(!result.emptyState.started && result.emptyState.status.processedInputs === 0 &&
        result.emptyState.timers === 0 && result.emptyState.panels.every(p => p.exists), "EMPTY_LAYOUT_INPUT_OR_PANELS");
      await evaluate('document.getElementById("artificial-height").remove()');
      result.resizeObserver = await evaluate("window.__desktopLayout.rows");
      result.layoutMonitorDisposed = await evaluate("window.__desktopLayout.dispose()");
      result.dispose = await disposed(); await wait(100);
      result.afterObserver = await evaluate("window.__load29Observer.snapshot()");
      assert.equal(result.afterObserver.pending, 0);
      assert.equal(result.afterObserver.totals.buffers, result.afterObserver.totals.deletes, "BUFFER_REMAINDER");
      await evaluate("window.__load29Observer.dispose()");
      result.status = "PASS";
      return;
    }
    await evaluate("window.__load29.start()");
    result.layoutSamples = [];
    while (!complete) {
      assert(!fault, fault); await wait(100);
      const s = await evaluate("window.__desktopLayout.read()");
      layoutGate(s, result.expected);
      assert(result.layoutSamples.length < 2100, "LAYOUT_SAMPLE_CAP");
      result.layoutSamples.push(s);
    }
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
    result.layoutAfter = await evaluate("window.__desktopLayout.read()");
    result.resizeObserver = await evaluate("window.__desktopLayout.rows");
    layoutGate(result.layoutAfter, result.expected);
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
    result.resize = "NOT_RUN (formal stages prohibit intentional window resize)";
    result.layoutMonitorDisposed = await evaluate("window.__desktopLayout.dispose()");
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
    if (web && !web.isDestroyed()) {
      try { result.failureLayout = await web.executeJavaScript("window.__desktopLayout?.read()"); } catch {}
      try { await web.executeJavaScript("window.__desktopLayout?.dispose()"); } catch {}
    }
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
