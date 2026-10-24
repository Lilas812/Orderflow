/* One native production-built diagnostic session. Original main + preload and
 * security policy remain intact. Only the local built-asset root is redirected. */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { gzipSync } = require("node:zlib");
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const out = path.resolve(arg("output")), stage = Number(arg("stage")), build = path.resolve(arg("build"));
const runId = arg("run-id"), tools = import("./processMonitor.mjs");
let save, wall, web, fault = null, complete = false, shutdownRequested = false, shutdownTask;
let result = { stage, runId, status: "RUNNING", forcedTermination: false,
  primaryFault: null, cleanupFaults: [], evidenceFaults: [] };
let records = [], recordBytes = 0, count = 0, block = 0, receipts = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const policy = require("../dist/main/policy.js"), original = policy.localResponse;
policy.localResponse = request => original(request, build); // Assets only, not market state.
let disposal, layoutDisposal, observerDisposal;
const disposed = () => disposal ??= Promise.resolve().then(() => {
  assert(web && !web.isDestroyed(), "DISPOSE_WEB_MISSING");
  return web.executeJavaScript("window.__load29?.dispose()");
});
const disposeLayout = () => layoutDisposal ??= Promise.resolve().then(() => {
  assert(web && !web.isDestroyed(), "LAYOUT_DISPOSE_WEB_MISSING");
  return web.executeJavaScript("window.__desktopLayout?.dispose()");
});
const disposeObserver = () => observerDisposal ??= Promise.resolve().then(() => {
  assert(web && !web.isDestroyed(), "OBSERVER_DISPOSE_WEB_MISSING");
  return web.executeJavaScript("window.__load29Observer?.dispose()");
});
function primary(error, phase) {
  fault ??= error instanceof Error ? error.message : String(error);
  result.primaryFault ??= { phase, timestamp: performance.now(), reason: fault,
    stack: error instanceof Error ? error.stack : null };
  result.status = "FAIL"; result.error ??= fault;
}
function shutdown(reason) {
  if (reason) primary(reason, "SHUTDOWN_REQUEST");
  if (shutdownTask) return shutdownTask;
  shutdownRequested = true;
  shutdownTask = tools.then(async ({ createShutdown, bounded, faultRecord }) => {
    const send = type => process.connected ? bounded(new Promise((resolve, reject) =>
      process.send({ type, runId }, e => e ? reject(e) : resolve())), 250, "CONTROL_SEND_TIMEOUT") : Promise.resolve();
    const close = createShutdown([
      ["DISPOSING", async () => { clearTimeout(wall); await send("DIAGNOSTIC_DISPOSING"); }],
      ["LAYOUT_DISPOSE", () => bounded(disposeLayout(), 1000, "LAYOUT_DISPOSE_TIMEOUT")],
      ["SESSION_DISPOSE", async () => {
        result.dispose = await bounded(disposed(), 1000, "SESSION_DISPOSE_TIMEOUT");
        assert(result.dispose?.after?.timers === 0 && result.dispose.after.subscribers === 0 &&
          result.dispose.mountedCanvases === 0, "SESSION_DISPOSAL_UNCONFIRMED");
        // Unlike the legacy dispose().timers literal, snapshot observes the actual pump + session.
        result.shutdownSnapshot = await bounded(web.executeJavaScript(
          "(()=>{const s=window.__load29?.snapshot();return s?{timers:s.timers,disposed:s.disposed,status:s.status}:null})()"),
        1000, "SHUTDOWN_SNAPSHOT_TIMEOUT");
        assert(result.shutdownSnapshot?.disposed && result.shutdownSnapshot.timers === 0, "LIVE_TIMER_REMAINDER");
      }],
      ["OBSERVER_DISPOSE", async () => {
        if (!result.afterObserver) result.afterObserver = await bounded(
          web.executeJavaScript("window.__load29Observer?.snapshot()"), 1000, "OBSERVER_SNAPSHOT_TIMEOUT");
        assert(result.afterObserver && !result.afterObserver.fault && result.afterObserver.pending === 0 &&
          result.afterObserver.totals.buffers === result.afterObserver.totals.deletes &&
          result.afterObserver.totals.errors === 0, "OBSERVER_RESOURCE_REMAINDER");
        const released = await bounded(disposeObserver(), 1000, "OBSERVER_DISPOSE_TIMEOUT");
        assert(released && released.pending === 0 && !released.fault, "OBSERVER_DISPOSE_UNCONFIRMED");
      }],
      ["DEBUGGER_DETACH", () => { if (web?.debugger.isAttached()) web.debugger.detach(); }],
    ], record => result.cleanupFaults.push(record));
    result.shutdown = await close();
    if (fault && !result.primaryFault) primary(fault, "NATIVE_FAULT");
    if (fault || result.cleanupFaults.length) result.status = "FAIL";
    try {
      flush(); result.blocks = receipts; result.recordCount = count;
      assert(save, "NATIVE_WRITER_UNAVAILABLE"); save("native-result.json", result);
    } catch (e) {
      result.status = "FAIL"; result.evidenceFaults.push(faultRecord(e, "NATIVE_RESULT_WRITE"));
      console.error("EVIDENCE_SAVE_FAILED");
    }
    try { await send("DIAGNOSTIC_SAVED"); }
    catch (e) { primary(e, "SAVED_ACK"); }
    // app.quit allows normal window closing and will-quit. app.exit is used only
    // after that barrier (or as a recorded FAIL after a finite quit timeout).
    let quitFinished = false;
    const code = () => result.status === "PASS" ? 0 : 1;
    const quitReceipt = (name, value) => {
      try { assert(save, "NATIVE_WRITER_UNAVAILABLE"); save(name, value); }
      catch { result.status = "FAIL"; console.error("QUIT_EVIDENCE_SAVE_FAILED"); }
    };
    const quitTimer = setTimeout(() => {
      if (quitFinished) return;
      primary("NATIVE_QUIT_TIMEOUT", "QUIT");
      quitReceipt("quit-timeout.json", { runId, status: "FAIL", reason: "NATIVE_QUIT_TIMEOUT" });
      app.exit(1);
    }, 2000);
    app.once("will-quit", () => {
      quitFinished = true; clearTimeout(quitTimer);
      const windows = BrowserWindow.getAllWindows().length;
      if (windows !== 0) primary("WINDOWS_REMAINING", "QUIT");
      quitReceipt("quit.json", { runId, status: result.status, windows, willQuit: true,
        primaryFault: result.primaryFault, evidenceFaults: result.evidenceFaults });
      process.exitCode = code(); app.exit(code());
    });
    try { app.quit(); }
    catch (e) {
      primary(e, "APP_QUIT"); clearTimeout(quitTimer);
      quitReceipt("quit-error.json", { runId, status: "FAIL", primaryFault: result.primaryFault }); app.exit(1);
    }
  });
  return shutdownTask;
};
process.on("SIGTERM", () => { void shutdown("PARENT_STOP"); });
process.on("message", message => {
  if (message && Object.keys(message).length === 2 && message.runId === runId && message.type === "DIAGNOSTIC_STOP")
    void shutdown("PARENT_STOP");
  else void shutdown("CONTROL_MESSAGE_INVALID");
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
    assert(/^[a-f0-9-]{36}$/.test(runId ?? ""), "RUN_ID");
    const definition = JSON.parse(fs.readFileSync(arg("input")));
    result.versions = process.versions;
    assert.equal(process.versions.electron, "45.0.0", "ELECTRON_VERSION");
    assert.equal(process.versions.chrome, "156.0.8078.48", "CHROMIUM_VERSION");
    wall = setTimeout(() => { void shutdown("WALL_TIMEOUT"); }, LIMITS.wall[stage]);
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
    web.on("console-message", (_e, level) => { if (level === 3) primary("RENDERER_CONSOLE_ERROR", "CONSOLE"); });
    web.on("preload-error", () => { primary("PRELOAD_ERROR", "PRELOAD"); });
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
        if (row.kind === "failure") primary(row.fault, "BINDING_FAILURE");
        if (row.kind === "complete") complete = true;
      } catch (e) { primary(e, "BINDING"); }
    });
    const evaluate = expression => {
      assert(!shutdownRequested, "SHUTDOWN_IN_PROGRESS"); return web.executeJavaScript(expression);
    };
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
      await evaluate(`document.getElementById("artificial-height").remove()`);
      await disposeLayout();
      result.dispose = await disposed();
      await disposeObserver();
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
    assert.equal(result.expected.width, 647, "SAVED_CANVAS_WIDTH_CONDITION");
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
      result.layoutMonitorDisposed = await disposeLayout();
      result.dispose = await disposed(); await wait(100);
      result.afterObserver = await evaluate("window.__load29Observer.snapshot()");
      assert.equal(result.afterObserver.pending, 0);
      assert.equal(result.afterObserver.totals.buffers, result.afterObserver.totals.deletes, "BUFFER_REMAINDER");
      await disposeObserver();
      result.status = "PASS";
      return;
    }
    result.formalInterval = { start: await evaluate("window.__desktopLayout.beginFormal()") };
    await evaluate("window.__load29.start()");
    result.layoutSamples = [];
    while (!complete) {
      assert(!fault, fault); await wait(100);
      const s = await evaluate("window.__desktopLayout.read()");
      layoutGate(s, result.expected);
      assert.equal(s.epoch, result.formalInterval.start.generation, "FORMAL_RESIZE_OBSERVER_GENERATION");
      assert.deepEqual(s.canvasRects, result.layoutBefore.canvasRects, "FORMAL_CANVAS_POSITION");
      assert(result.layoutSamples.length < 2100, "LAYOUT_SAMPLE_CAP");
      result.layoutSamples.push(s);
    }
    await wait(250); assert(!fault, fault);
    result.formalInterval.end = await evaluate("window.__desktopLayout.endFormal()");
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
    assert(s.publication?.done && s.publication.hub === s.revision &&
      s.publication.published === s.revision &&
      Object.values(s.publication.reflected).every(r => r === s.revision) &&
      s.publication.timers === 0, "FINAL_FOUR_PANEL_PUBLICATION");
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
      interval: "input/read timings formal only; React/observer totals also include explicitly recorded pre-input initialization",
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
    result.layoutMonitorDisposed = await disposeLayout();
    result.dispose = await disposed(); await wait(100);
    result.afterObserver = await evaluate("window.__load29Observer.snapshot()");
    assert.equal(result.dispose.timers, 0); assert.equal(result.dispose.after.subscribers, 0);
    assert.equal(result.dispose.mountedCanvases, 0);
    assert.equal(result.afterObserver.pending, 0);
    assert.equal(result.afterObserver.totals.buffers, result.afterObserver.totals.deletes, "BUFFER_REMAINDER");
    await disposeObserver();
    result.status = "PASS";
  } catch (e) {
    primary(e, "NATIVE_EXECUTION");
    if (web && !web.isDestroyed()) {
      try { result.failureLayout = await web.executeJavaScript("window.__desktopLayout?.read()"); } catch {}
      try { result.failureState = await web.executeJavaScript("window.__load29?.snapshot()"); } catch {}
      try { result.failureObserver = await web.executeJavaScript("window.__load29Observer?.snapshot()"); } catch {}
    }
  } finally {
    await shutdown();
  }
}).catch(e => { void shutdown(e); });
