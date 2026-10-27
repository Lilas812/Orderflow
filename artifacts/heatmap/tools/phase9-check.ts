import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { browser, delay } from "../../../server/tools/perf/cdp.ts";
import { staticProxy } from "../../../server/tools/perf/static-proxy.ts";

const out = path.resolve("data/phase9");
await fs.mkdir(out, { recursive: true });
const afterRestart = process.argv.includes("--after-restart");
const results: any = { phase: afterRestart ? "after-restart" : "first", profile: `/tmp/heatmap-perf-browser-${process.pid}`,
  stages: [], memory: [], checks: {}, startedAt: new Date().toISOString() };
const resultFile = path.join(out, afterRestart ? "after-restart.json" : "browser-checks.json");
const api = async () => (await fetch("http://localhost:80/api/settings")).json();
const status = async () => (await fetch("http://localhost:80/api/status")).json();
const proxy = await staticProxy(path.resolve("artifacts/heatmap/dist/public"), 19090);
const chrome = await browser(9222);
let page: Awaited<ReturnType<typeof chrome.page>>;
const expr = "({debug:window.__heatmapDebug,labels:document.getElementById('time-axis')?.textContent,dialog:document.querySelector('dialog')?.open})";
async function wait(expression: string, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await page.cdp.evaluate(expression)) return; await delay(100); }
  throw Error(`wait_timeout:${expression}`);
}
async function shot(name: string) {
  const snap = await page.cdp.evaluate(expr);
  const image = await page.cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(out, name + ".png"), Buffer.from(image.data, "base64"));
  results.stages.push({ name, ...snap }); await save();
  return snap;
}
const save = () => fs.writeFile(resultFile, JSON.stringify(results, null, 2));
const click = (selector: string) => page.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function ready() {
  await wait("window.__heatmapDebug?.traffic.initialComplete && window.__heatmapDebug.loadingRanges===0 && window.__heatmapDebug.cachedColumns>0");
  await delay(1300);
}
async function open() {
  await click('[data-testid="button-settings"]');
  await wait("document.querySelector('dialog').open && !document.querySelector('#su-bubbleMin').disabled");
}
async function set(key: string, value: string | number) {
  await page.cdp.evaluate(`(()=>{const e=document.getElementById(${JSON.stringify("su-" + key)});
    e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function memory(name: string) {
  await page.cdp.call("HeapProfiler.collectGarbage");
  const data = await page.cdp.evaluate(`({at:Date.now(),performance:performance.memory?{
    usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,
    jsHeapSizeLimit:performance.memory.jsHeapSizeLimit}:null,
    shared:window.__heatmapDebug.sharedColumns,columns:window.__heatmapDebug.cachedColumns})`);
  const heap = await page.cdp.call("Runtime.getHeapUsage");
  results.memory.push({ name, ...data, heap }); await save();
}
async function change(key: string, value: number | string, name: string) {
  await open(); await set(key, value); await click('[data-testid="button-settings-save"]');
  await wait("!document.querySelector('dialog').open");
  await delay(1200);
  const saved = await api(); assert.equal(saved.values[key], value);
  const s = await shot(name); assert.equal(s.debug.settings.values[key], value);
}
async function reset(name: string) {
  const boxes = await page.cdp.evaluate(`Object.fromEntries(['heatmap','price-axis'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{x:r.x,y:r.y,w:r.width,h:r.height}]}))`);
  const b = boxes.heatmap;
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: b.x + b.w / 2, y: b.y + b.h / 2, deltaY: -350, deltaX: 0 });
  await delay(150);
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x + b.w / 3, y: b.y + b.h / 2, button: "left", clickCount: 1 });
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x + b.w * .6, y: b.y + b.h / 2, buttons: 1 });
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x + b.w * .6, y: b.y + b.h / 2, button: "left", clickCount: 1 });
  await delay(700); await shot(name + "-before");
  const check = await page.cdp.evaluate(`(()=>{const before=window.__heatmapDebug;
    document.querySelector('[data-testid="button-view-reset"]').click();
    const after=window.__heatmapDebug,r=document.getElementById('heatmap').getBoundingClientRect();
    const anchor=${JSON.stringify(name)}==='replay-reset'?after.replayHeadUs:after.latestTimeUs+1000000;
    return {priceAtClick:before.currentPrice,after,anchorX:(anchor-after.viewport.startUs)/(after.viewport.durationSec*1000000)*r.width,width:r.width};})()`);
  assert.equal(check.after.follow, true); assert.equal(check.after.viewport.durationSec, 600);
  assert.equal(check.after.viewport.priceSpanTicks, 160);
  assert.equal(check.after.viewport.centerPriceTicks, check.priceAtClick);
  assert.ok(Math.abs(check.anchorX - check.width * .8) < 1.5);
  results.checks[name] = check; await delay(500); await shot(name + "-after");
}
try {
  const before = await api(); results.initialSettings = before;
  page = await chrome.page("http://127.0.0.1:19090/?mode=replay&from=1793022000&speed=1&debug=1");
  const exceptions: any[] = []; page.cdp.on("Runtime.exceptionThrown", p => exceptions.push(p));
  await ready();
  if (afterRestart) {
    const expected = JSON.parse(await fs.readFile(path.join(out, "expected-persisted.json"), "utf8"));
    assert.deepEqual(before, expected);
    const s = await shot("second-profile-after-restart");
    assert.deepEqual(s.debug.settings.values, expected.values);
    results.checks.persistedAndNewProfile = true;
    // Restore through the actual form, not through a verification-only setter.
    await open(); await click('[data-testid="button-settings-defaults"]');
    await click('[data-testid="button-settings-save"]'); await wait("!document.querySelector('dialog').open");
    const restored = await api();
    assert.deepEqual(restored.values, { heatTopPct: 1, bubbleMin: 10, bigTopPct: 2, bigMinSec: 5, timeZone: "Asia/Tokyo" });
    results.restored = restored; await delay(1200); await shot("defaults-restored");
    // All three documented URL overrides keep their legacy verification ranges; tz is ignored.
    await chrome.closePage(page);
    page = await chrome.page("http://127.0.0.1:19090/?mode=replay&from=1793022000&speed=1&debug=1&bubbleMin=9999&bigTop=100&bigMinSec=0&tz=ct");
    await ready();
    const url = await page.cdp.evaluate("window.__heatmapDebug.settings");
    assert.equal(url.values.bubbleMin, 9999); assert.equal(url.values.bigTopPct, 100); assert.equal(url.values.bigMinSec, 0);
    assert.equal(url.values.timeZone, "Asia/Tokyo");
    await open();
    assert.equal(await page.cdp.evaluate("document.querySelectorAll('.su-override').length"), 3);
    await shot("url-overrides"); results.checks.url = url;
    await click('[data-testid="button-settings-close"]');
    assert.deepEqual((await api()).values, restored.values);
  } else {
    await memory("before-settings");
    await open(); await shot("settings-open");
    const head = await page.cdp.evaluate("window.__heatmapDebug.latestTimeUs");
    const duration = await page.cdp.evaluate("window.__heatmapDebug.viewport.durationSec");
    await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 160, y: 260, deltaY: -300, deltaX: 0 });
    await delay(1500);
    assert.equal(await page.cdp.evaluate("window.__heatmapDebug.viewport.durationSec"), duration);
    assert.ok(await page.cdp.evaluate(`window.__heatmapDebug.latestTimeUs>${head}`));
    results.checks.modalUpdatesWithoutChartInput = true;
    await set("heatTopPct", 0); assert.ok(await page.cdp.evaluate("document.querySelector('[data-testid=\"button-settings-save\"]').disabled"));
    await shot("settings-invalid");
    await page.cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    assert.deepEqual(await api(), before);
    await change("bubbleMin", 1, "bubble-min-1");
    await open(); await click('[data-testid="button-settings-defaults"]');
    await page.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 400, button: "left", clickCount: 1 });
    await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 400, button: "left", clickCount: 1 });
    assert.equal((await api()).values.bubbleMin, 1); results.checks.defaultsAndCloseDoNotSave = true;
    await change("heatTopPct", 10, "heat-top-10");
    await change("bigTopPct", 20, "big-top-20"); await memory("after-big-threshold");
    await change("bigMinSec", 600, "big-min-600"); await memory("after-big-duration");
    await change("timeZone", "America/Chicago", "time-zone-chicago");
    // Inject only an HTTP failure. Market data and chart state remain genuine.
    await open(); await set("bubbleMin", 2);
    page.cdp.on("Fetch.requestPaused", p => {
      void page.cdp.call("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 500,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from(JSON.stringify({ error: "settings_save_failed" })).toString("base64") });
    });
    await page.cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*api/settings", requestStage: "Request" }] });
    await click('[data-testid="button-settings-save"]');
    await wait("document.querySelector('[data-testid=\"status-settings\"]').textContent.includes('保存できません')");
    assert.equal((await api()).values.bubbleMin, 1);
    assert.equal(await page.cdp.evaluate("window.__heatmapDebug.settings.values.bubbleMin"), 1);
    await shot("settings-save-failed");
    await page.cdp.call("Fetch.disable"); await click('[data-testid="button-settings-close"]');
    await page.cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*api/settings", requestStage: "Request" }] });
    await click('[data-testid="button-settings"]');
    await wait("document.querySelector('[data-testid=\"status-settings\"]').textContent.includes('読み込めません')");
    assert.ok(await page.cdp.evaluate("document.querySelector('[data-testid=\"button-settings-save\"]').disabled"));
    await shot("settings-load-failed");
    await page.cdp.call("Fetch.disable"); await click('[data-testid="button-settings-close"]');
    await reset("replay-reset");
    await memory("after-all-settings");
    const shared = await page.cdp.evaluate("window.__heatmapDebug.sharedColumns");
    assert.ok(shared.overlap > 0); assert.equal(shared.shared, shared.overlap);
    results.checks.sharedColumnIdentity = shared;
    const persisted = await api(); await fs.writeFile(path.join(out, "expected-persisted.json"), JSON.stringify(persisted, null, 2));
    await chrome.closePage(page);
    page = await chrome.page("http://127.0.0.1:19090/?debug=1");
    await ready(); await reset("live-reset");
  }
  results.status = await status(); results.exceptions = exceptions;
  assert.deepEqual(exceptions, []);
  results.success = true;
  console.log("PHASE9_UI_CHECK_PASSED", { phase: results.phase, stages: results.stages.length, memory: results.memory });
} finally {
  results.closed = await chrome.close();
  await proxy.close();
  results.afterCloseStatus = await status();
  const ours = results.afterCloseStatus.phase2b.connections.filter((c: any) => c.userAgent?.includes(`NQPerf/${process.pid}`));
  assert.equal(ours.length, 0, "no verification WS remains");
  await save();
}
