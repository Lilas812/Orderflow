import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { browser, delay } from "../../../server/tools/perf/cdp.ts";
import { defaults } from "../../../server/src/settings/schema.ts";

const out = "data/phase10c";
const base = "http://127.0.0.1:25028";
await fs.mkdir(out, { recursive: true });
const api = async (route: string) => (await fetch(`${base}/api/${route}`)).json();
const vpOnly = process.argv.includes("--vp-only");
const result: any = vpOnly ? JSON.parse(await fs.readFile(`${out}/browser-checks.json`, "utf8"))
  : { startedAt: new Date().toISOString(), stages: [], errors: [] };
const save = () => fs.writeFile(`${out}/browser-checks.json`, JSON.stringify(result, null, 2));
const chrome = await browser(9222);
let page: Awaited<ReturnType<typeof chrome.page>>;
async function wait(expression: string, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.cdp.evaluate(expression)) return;
    await delay(100);
  }
  throw Error(`wait_timeout:${expression}`);
}
const click = (selector: string) => page.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const debug = () => page.cdp.evaluate("window.__heatmapDebug");
async function open() {
  await click('[data-testid="button-settings"]');
  await wait("document.querySelector('dialog').open && !document.querySelector('#su-heatUpperMode').disabled");
}
async function set(key: string, value: string | number) {
  await page.cdp.evaluate(`(()=>{const e=document.getElementById('su-'+${JSON.stringify(key)});
    e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function submit() {
  await click('[data-testid="button-settings-save"]');
  await wait("!document.querySelector('dialog').open");
  await delay(1400);
}
async function reset() {
  await open(); await click('[data-testid="button-settings-defaults"]'); await submit();
}
async function shot(name: string) {
  const image = await page.cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
  result.stages.push({ name, capturedAt: new Date().toISOString(), debug: await debug() });
  await save();
}
async function drag(dy: number) {
  const rect = await page.cdp.evaluate(`(()=>{const r=document.getElementById('price-axis').getBoundingClientRect();
    return{x:r.x+r.width/2,y:r.y+r.height*.3}})()`);
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...rect, button: "left", clickCount: 1 });
  for (let step = 1; step <= 20; step++) {
    await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y + dy * step / 20, button: "left", buttons: 1 });
    await delay(35);
  }
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y + dy, button: "left" });
  await delay(1400);
}
try {
  page = await chrome.page(`${base}/?mode=replay&from=1793022000&speed=1&debug=1`);
  page.cdp.on("Runtime.exceptionThrown", e => result.errors.push(e.exceptionDetails?.text));
  await page.cdp.call("Runtime.enable");
  await wait("window.__heatmapDebug?.traffic.initialComplete && !window.__heatmapDebug.loadingRanges && window.__heatmapDebug.cachedColumns>0");
  await wait("window.__heatmapDebug?.vp.prices>0");
  if (!vpOnly) {
  await reset();
  await shot("01-default");
  const initialHead = (await debug()).replayHeadUs;
  for (const [name, settings] of [
    ["02-upper-size", { heatUpperMode: "size", heatUpperSize: 100 }],
    ["03-lower-pct", { heatLowerMode: "pct", heatLowerPct: 20 }],
    ["04-lower-size", { heatLowerMode: "size", heatLowerSize: 5 }],
    ["05-gamma-half", { heatGamma: .5 }],
    ["06-gamma-two", { heatGamma: 2 }],
  ] as const) {
    await open(); await click('[data-testid="button-settings-defaults"]');
    for (const [key, value] of Object.entries(settings)) await set(key, value);
    await submit();
    for (const [key, value] of Object.entries(settings)) assert.equal((await debug()).settings.values[key], value);
    await shot(name);
  }
  assert.ok((await debug()).replayHeadUs > initialHead, "speed=1 replay advances");
  await open();
  await set("heatUpperMode", "size"); await set("heatUpperSize", 42);
  await set("heatLowerMode", "size"); await set("heatLowerSize", 88);
  await set("heatUpperMode", "auto"); await set("heatLowerMode", "off");
  assert.equal(await page.cdp.evaluate("document.querySelector('#su-heatUpperSize').closest('.su-field').hidden"), true);
  assert.equal(await page.cdp.evaluate("document.querySelector('#su-heatLowerSize').closest('.su-field').hidden"), true);
  await submit();
  const stored = await api("settings");
  assert.equal(stored.version, 3); assert.equal(stored.values.heatUpperSize, 42); assert.equal(stored.values.heatLowerSize, 88);
  await page.cdp.call("Page.reload");
  await wait("window.__heatmapDebug?.settings.values.heatUpperSize===42 && window.__heatmapDebug.settings.values.heatLowerSize===88");
  await open(); await set("heatUpperMode", "size"); await set("heatLowerMode", "size");
  assert.equal(await page.cdp.evaluate("document.querySelector('#su-heatUpperSize').value"), "42");
  assert.equal(await page.cdp.evaluate("document.querySelector('#su-heatLowerSize').value"), "88");
  await submit();
  await wait("document.querySelector('#debug-panel')?.textContent.includes('下限を上限の手前に合わせた') || document.body.textContent.includes('下限を上限の手前に合わせた')");
  await shot("07-lower-clamp");
  }
  await reset();
  await wait("window.__heatmapDebug?.vp.prices>0 && !window.__heatmapDebug.loadingRanges");
  // Taller screenshot lets the entire VA fit while each price still has >1 physical pixel.
  await page.cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await delay(300);
  await drag(Math.log(650 / (await debug()).viewport.priceSpanTicks) / .008);
  const boxes = await page.cdp.evaluate(`Object.fromEntries(["vp-guides","volume-profile","big-orders","vp-labels","price-axis","current-price-label"].map(id=>{
    const e=document.getElementById(id);if(!e)return[id,null];const r=e.getBoundingClientRect();
    return[id,{x:r.x,y:r.y,width:r.width,height:r.height,z:getComputedStyle(e).zIndex}]}))`);
  result.boxes = boxes;
  const vpBox = boxes["volume-profile"];
  assert.equal(boxes["vp-guides"].height, vpBox.height);
  assert.equal(boxes["vp-guides"].y, vpBox.y);
  assert.equal(boxes["vp-guides"].x, boxes["big-orders"].x);
  assert.ok(Math.abs(boxes["vp-guides"].x + boxes["vp-guides"].width - vpBox.x - vpBox.width) < 1);
  assert.equal(boxes["vp-labels"].z, "1"); assert.equal(boxes["current-price-label"].z, "2");
  await shot("08-vp-expanded");
  const expanded = await debug();
  assert.ok(expanded.viewport.priceSpanTicks < vpBox.height);
  assert.ok(expanded.vp.low > expanded.viewport.centerPriceTicks - expanded.viewport.priceSpanTicks / 2);
  assert.ok(expanded.vp.high < expanded.viewport.centerPriceTicks + expanded.viewport.priceSpanTicks / 2);
  await drag(Math.log(2) / .008);
  assert.ok((await debug()).viewport.priceSpanTicks > vpBox.height, "physical-row compression");
  await shot("09-vp-compressed");
  result.status = await api("status");
  result.browserMemory = await page.cdp.evaluate("performance.memory ? {used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null");
  assert.deepEqual(result.errors, []);
  result.passed = true;
} finally {
  if (page!) {
    try {
      await reset();
      result.restored = await api("settings");
      assert.deepEqual(result.restored.values, defaults);
      await fs.writeFile(`${out}/benchmark-settings.json`, JSON.stringify(result.restored));
    } catch (e) { result.restoreError = String(e); }
  }
  result.browserClosed = await chrome.close();
  result.statusAfterClose = await api("status");
  await save();
}
assert.equal(result.restoreError, undefined);
console.log("PHASE10C_CHECK_PASSED");
