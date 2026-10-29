import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { browser, delay } from "../../../server/tools/perf/cdp.ts";
import { defaults } from "../../../server/src/settings/schema.ts";

const base = "http://127.0.0.1:25028", out = "data/phase14";
await fs.mkdir(out, { recursive: true });
const api = async (route: string, values?: unknown) => {
  const r = await fetch(`${base}/api/${route}`, values ? { method: "PUT",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) } : {});
  assert.equal(r.status, 200); return r.json();
};
const result: any = { startedAt: new Date().toISOString(), stages: [], errors: [],
  source: "実保存データのspeed=1リプレイ。上流WSなし。各シーンは同じ開始位置で再読込。",
  statusBefore: await api("status") };
const chrome = await browser(9224);
let page: Awaited<ReturnType<typeof chrome.page>> | undefined;
const save = () => fs.writeFile(`${out}/browser-checks.json`, JSON.stringify(result, null, 2));
const debug = () => page!.cdp.evaluate("window.__heatmapDebug");
async function wait(expression: string, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await page!.cdp.evaluate(expression)) return; await delay(100); }
  throw Error(`wait_timeout:${expression}`);
}
async function timeSpan(seconds: number) {
  const current = await debug();
  const delta = Math.log(seconds / current.viewport.durationSec) / .0015;
  await page!.cdp.evaluate(`(()=>{const e=document.getElementById("heatmap"),r=e.getBoundingClientRect();
    e.dispatchEvent(new WheelEvent("wheel",{clientX:r.x+r.width*.8,clientY:r.y+r.height*.5,
    deltaY:${delta},bubbles:true,cancelable:true}));})()`);
  await delay(400);
  await wait("!window.__heatmapDebug.loadingRanges");
  assert.ok(Math.abs((await debug()).viewport.durationSec - seconds) < .01);
}
async function priceSpan(ticks: number) {
  for (let n = 0; n < 4; n++) {
    const d = await debug();
    if (Math.abs(d.viewport.priceSpanTicks - ticks) < .05) return;
    const dy = Math.max(-190, Math.min(190, Math.log(ticks / d.viewport.priceSpanTicks) / .008));
    const r = await page!.cdp.evaluate(`(()=>{const r=document.getElementById("price-axis").getBoundingClientRect();
      return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await page!.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...r, button: "left", clickCount: 1 });
    await page!.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y + dy, button: "left", buttons: 1 });
    await page!.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y + dy, button: "left" });
    await delay(300);
  }
  assert.ok(Math.abs((await debug()).viewport.priceSpanTicks - ticks) < .05);
}
async function shot(name: string) {
  const r = await page!.cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(`${out}/${name}.png`, Buffer.from(r.data, "base64"));
  result.stages.push({ name, time: new Date().toISOString(), debug: await debug(),
    browserMemory: await page!.cdp.evaluate("performance.memory ? {used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null"),
    layout: await page!.cdp.evaluate(`Object.fromEntries(["heatmap","big-orders","volume-profile","vp-guides"].map(id=>{
      const e=document.getElementById(id),r=e.getBoundingClientRect();return[id,{x:r.x,width:r.width,height:r.height,display:getComputedStyle(e).display}]}))`) });
  await save();
}
try {
  const initial = await api("settings"); assert.equal(initial.version, 4);
  page = await chrome.page("about:blank");
  await page.cdp.call("Runtime.enable");
  page.cdp.on("Runtime.exceptionThrown", e => result.errors.push(e.exceptionDetails?.text));
  for (const [name, style, seconds] of [
    ["01-glow-10m", "glow", 600], ["02-block-10m", "block", 600],
    ["03-glow-1h", "glow", 3600], ["04-block-1h", "block", 3600],
  ] as const) {
    await api("settings", { ...defaults, heatStyle: style });
    await page.cdp.call("Page.navigate", { url: `${base}/?mode=replay&from=1793022000&speed=1&debug=1` });
    await wait("window.__heatmapDebug?.traffic.initialComplete && window.__heatmapDebug.cachedColumns>0 && !window.__heatmapDebug.loadingRanges");
    assert.equal((await debug()).settings.values.heatStyle, style);
    await timeSpan(seconds);
    await wait("window.__heatmapDebug.replayHeadUs >= 1793022012000000");
    await shot(name);
  }
  await api("settings", { ...defaults, bigOrdersVisible: true });
  await page.cdp.call("Page.reload");
  await wait("window.__heatmapDebug?.settings.values.bigOrdersVisible && window.__heatmapDebug.cachedColumns>0 && !window.__heatmapDebug.loadingRanges");
  await shot("05-big-visible");
  await page.cdp.evaluate(`document.querySelector('[data-testid="button-settings"]').click()`);
  await wait("document.querySelector('dialog').open && !document.querySelector('#su-heatStyle').disabled");
  result.settingsControls = await page.cdp.evaluate(`({style:!!document.querySelector("#su-heatStyle"),
    visible:!!document.querySelector("#su-bigOrdersVisible"),
    oldBarLength:!!document.querySelector("#su-bookBarPct"),oldBarOpacity:!!document.querySelector("#su-bookBarOpacity")})`);
  assert.equal(result.settingsControls.oldBarLength, false); assert.equal(result.settingsControls.oldBarOpacity, false);
  await shot("06-settings");
  await page.cdp.evaluate(`document.querySelector("dialog").close()`);
  await priceSpan(24); await shot("07-book-expanded");
  await priceSpan(800); await shot("08-book-compressed");
  await api("settings", { ...defaults });
  await page.cdp.call("Page.reload");
  await wait("window.__heatmapDebug?.cachedColumns>0 && !window.__heatmapDebug.loadingRanges");
  // Consecutive real replay columns: diagnostics record layer and cache work, not synthetic live traffic.
  result.columnSamples = [];
  for (let i = 0; i < 8; i++) { await delay(1050); result.columnSamples.push(await debug()); }
  await shot("09-restored-default");
  result.status = await api("status");
  assert.equal(result.status.upstream.state, "stopped");
  assert.deepEqual(result.errors, []);
  result.passed = true;
} finally {
  try {
    result.restored = await api("settings", { ...defaults });
    assert.equal(result.restored.version, 4); assert.deepEqual(result.restored.values, defaults);
  } catch (e) { result.restoreError = String(e); }
  result.browserClosed = await chrome.close();
  result.statusAfterClose = await api("status");
  await save();
}
assert.equal(result.restoreError, undefined);
assert.equal(result.passed, true);
console.log("PHASE14_CHECK_PASSED");
