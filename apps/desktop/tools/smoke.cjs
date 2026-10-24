/* Finite native-Electron functional smoke, never a Task29 performance/Stage trial.
 * Uses the real main/preload/App; no injected product state, fixture or golden. */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const output = process.argv.find(a => a.startsWith("--output-dir="));
if (!output) throw Error("SMOKE_OUTPUT_REQUIRED");
const dir = path.resolve(output.slice("--output-dir=".length));
fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
const report = { status: "RUNNING", kind: "NATIVE_ELECTRON_BASELINE13_FUNCTIONAL_SMOKE",
  platform: process.platform, versions: process.versions, stages: [], failures: [], forcedTermination: false };
const save = () => fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
const wall = setTimeout(() => {
  report.status = "FAIL"; report.failures.push("SMOKE_WALL_TIMEOUT");
  save(); process.exitCode = 1; app.quit(); // No SIGKILL or unrelated process operation.
}, 45_000);
require("../dist/main/main.js");
const wait = ms => new Promise(r => setTimeout(r, ms));
const snapshot = `(() => {
  const text = id => document.querySelector('[data-testid="'+id+'"]')?.textContent ?? null;
  const canvases = ["heatmap-canvas","bubble-canvas"].map(id => {
    const el = document.querySelector('[data-testid="'+id+'"]');
    if (!el) return {id, missing:true};
    const box=el.getBoundingClientRect(), gl=el.getContext("webgl2");
    return {id,revision:el.dataset.revision,css:[box.width,box.height],position:[box.x,box.y],
      attributes:[el.width,el.height],buffer:gl?[gl.drawingBufferWidth,gl.drawingBufferHeight]:null,
      error:gl?.getError(),renderer:gl?.getParameter(gl.RENDERER)};
  });
  return {status:text("status-data"),counts:text("text-unified-counts"),
    revision:document.querySelector('[data-testid="text-unified-revisions"]')?.dataset.revision,
    checks:[...document.querySelectorAll('[data-testid="unified-checks"] [data-ok]')].map(x=>({text:x.textContent,ok:x.dataset.ok})),
    delta:!!document.querySelector('[data-testid="delta-panel"]'),
    vp:!!document.querySelector('[data-testid="vp-panel"]'),
    dpr:devicePixelRatio,canvases,bridge:{appName:window.orderflowDesktop.appName,
      mode:window.orderflowDesktop.mode,apiVersion:window.orderflowDesktop.apiVersion,
      observationCommands:Object.keys(window.orderflowDesktop.observations)},
    requireType:typeof window.require,processType:typeof window.process};
})()`;

app.whenReady().then(async () => {
  try {
    let win;
    for (let n = 0; n < 100; n++) {
      win = BrowserWindow.getAllWindows()[0];
      if (win && !win.webContents.isLoading() && win.webContents.getURL()) break;
      await wait(100);
    }
    assert(win, "WINDOW_MISSING");
    const web = win.webContents;
    report.windowPreferences = web.getLastWebPreferences();
    assert.equal(report.windowPreferences.sandbox, true);
    assert.equal(report.windowPreferences.contextIsolation, true);
    assert.equal(report.windowPreferences.nodeIntegration, false);
    let current;
    for (let n = 0; n < 150; n++) {
      current = await web.executeJavaScript(snapshot);
      if (current.status?.includes("COMPLETED")) break;
      await wait(100);
    }
    report.initial = current;
    report.nativeWindow = { visible: win.isVisible(), title: win.getTitle(), bounds: win.getBounds(),
      contentBounds: win.getContentBounds(), minimumSize: win.getMinimumSize(), resizable: win.isResizable() };
    assert.equal(report.nativeWindow.visible, true, "NATIVE_WINDOW_NOT_VISIBLE");
    assert.equal(report.nativeWindow.title, "Orderflow Lab");
    assert(current.status?.includes("COMPLETED"), "FINITE_MOCK_NOT_COMPLETED");
    assert.equal(current.revision, "13");
    assert(current.checks.length >= 5 && current.checks.every(x => x.ok === "true"), "BASELINE_CHECKS");
    assert.equal(current.requireType, "undefined");
    assert.equal(current.processType, "undefined");
    assert.equal(current.bridge.mode, "MOCK / SIMULATED");
    const canvasGate = value => {
      assert(value.delta && value.vp, "FOUR_DISPLAYS");
      for (const c of value.canvases) {
        assert(!c.missing && c.buffer && c.css.every(x => x > 0), "CANVAS_MISSING");
        assert.equal(c.revision, value.revision);
        assert.equal(c.error, 0);
        assert.deepEqual(c.attributes, c.buffer);
        assert.deepEqual(c.attributes, c.css.map(x => Math.round(x * value.dpr)));
      }
      assert.deepEqual(value.canvases[0].css, value.canvases[1].css);
      assert.deepEqual(value.canvases[0].position, value.canvases[1].position);
    };
    canvasGate(current);
    const image = (await web.capturePage()).toPNG();
    fs.writeFileSync(path.join(dir, "native-window.png"), image, { flag: "wx", mode: 0o600 });
    report.captureSha256 = createHash("sha256").update(image).digest("hex");
    win.setSize(1100, 800);
    await wait(400);
    const resized = await web.executeJavaScript(snapshot);
    canvasGate(resized); assert.notEqual(resized.canvases[0].css[0], current.canvases[0].css[0]);
    report.resized = resized;
    web.debugger.attach("1.3");
    await web.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1100, height: 800, deviceScaleFactor: 2, mobile: false,
    });
    await wait(400);
    const dpr = await web.executeJavaScript(snapshot);
    assert.equal(dpr.dpr, 2); canvasGate(dpr);
    report.syntheticDpr = dpr;
    await web.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    // Real production main/preload/renderer route; no endpoint, Secrets or raw
    // market input. Switching is a source change, not relabeling the MOCK frame.
    await web.executeJavaScript(`(() => {
      const e=document.querySelector('[aria-label="Desktop data source"]');
      e.value="OBSERVATIONS"; e.dispatchEvent(new Event("change",{bubbles:true}));
    })()`);
    await wait(500);
    const hold = await web.executeJavaScript(`(() => ({
      status:document.querySelector('[data-testid="status-data"]')?.textContent,
      text:document.querySelector('[data-testid="observation-status"]')?.textContent,
      revision:document.querySelector('[data-testid="observation-revisions"]')?.dataset.revision,
      ladder:!!document.querySelector('[data-testid="observation-ladder"]'),
      delta:!!document.querySelector('[data-testid="delta-panel"]'),
      mockButton:!!document.querySelector('[data-testid="button-mock-toggle"]'),
      generation:document.querySelector('[data-testid="observation-status"]')?.dataset.generation,
      qty:[...document.querySelectorAll('[data-testid="ladder-row"]')].map(r=>[r.dataset.qtyBid,r.dataset.qtyAsk])
    }))()`);
    assert.equal(hold.status, "HOLD"); assert.equal(hold.revision, "0");
    assert(hold.text.includes("coverage UNKNOWN") && hold.text.includes("NOT_CONNECTED"), "HOLD_QUALITY");
    assert(hold.ladder && hold.delta && !hold.mockButton, "SOURCE_ISOLATION");
    assert(Number(hold.generation) > 0, "IPC_GENERATION_MISSING");
    report.observationHold = hold;
    fs.writeFileSync(path.join(dir, "native-observation-hold.png"), (await web.capturePage()).toPNG(), { flag: "wx", mode: 0o600 });
    await web.executeJavaScript(`(() => {
      [...document.querySelectorAll("button")].find(b=>b.textContent==="受信表示を停止").click();
    })()`);
    await wait(300);
    assert((await web.executeJavaScript(`document.querySelector('[data-testid="observation-status"]').textContent`)).includes("USER_STOPPED"));
    await web.executeJavaScript(`(() => {
      [...document.querySelectorAll("button")].find(b=>b.textContent==="表示世代を再開始").click();
    })()`);
    await wait(300);
    const generation = await web.executeJavaScript(`document.querySelector('[data-testid="observation-status"]').dataset.generation`);
    assert(Number(generation) > Number(hold.generation), "RESTART_GENERATION");
    report.observationRestartGeneration = generation;
    web.debugger.detach();
    report.metrics = app.getAppMetrics(); // Snapshot, not a sustained CPU/RSS benchmark.
    // Real React unmount and effect cleanups, observed before closing the native window.
    await web.executeJavaScript('window.dispatchEvent(new Event("pagehide"));');
    assert.equal(await web.executeJavaScript('document.querySelectorAll("canvas").length'), 0);
    report.unmount = { canvases: 0, method: "pagehide -> root.unmount -> existing effect cleanup",
      timerAndGlCounts: "UNKNOWN (no permanent product instrumentation)" };
    report.status = "PASS";
    save();
    win.close(); app.quit();
  } catch (error) {
    report.status = "FAIL"; report.failures.push(String(error.message).slice(0, 200));
    save(); process.exitCode = 1; app.quit();
  }
});
app.on("will-quit", () => { clearTimeout(wall); report.willQuit = true; save(); });
