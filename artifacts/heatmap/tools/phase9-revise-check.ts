import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { browser, delay } from "../../../server/tools/perf/cdp.ts";
import { staticProxy } from "../../../server/tools/perf/static-proxy.ts";

const out = path.resolve("data/phase9-revise");
await fs.mkdir(out, { recursive: true });
const result: any = { stages: [], memory: [], errors: [], injection: "初回GETのみダミー503。板・約定は実API/実保存データ。",
  startedAt: new Date().toISOString() };
const save = () => fs.writeFile(path.join(out, "browser-checks.json"), JSON.stringify(result, null, 2));
const api = async (route = "settings") => (await fetch(`http://localhost:8080/api/${route}`)).json();
const proxy = await staticProxy(path.resolve("artifacts/heatmap/dist/public"), 19090);
const chrome = await browser(9222);
let page: Awaited<ReturnType<typeof chrome.page>>;
async function wait(expression: string, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await page.cdp.evaluate(expression)) return; await delay(100); }
  throw Error(`wait_timeout:${expression}`);
}
const debug = () => page.cdp.evaluate("window.__heatmapDebug");
const click = (selector: string) => page.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function ready() {
  await wait("window.__heatmapDebug?.traffic.initialComplete && !window.__heatmapDebug.loadingRanges && window.__heatmapDebug.cachedColumns>0");
  await delay(1200);
}
async function shot(name: string, clip?: object) {
  const image = await page.cdp.call("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  await fs.writeFile(path.join(out, `${name}.png`), Buffer.from(image.data, "base64"));
  result.stages.push({ name, debug: await debug() }); await save();
}
async function open() {
  await click('[data-testid="button-settings"]');
  await wait("document.querySelector('dialog').open && !document.querySelector('#su-bubbleMin').disabled");
}
async function set(key: string, value: number) {
  await page.cdp.evaluate(`(()=>{const e=document.getElementById('su-'+${JSON.stringify(key)});
    e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function submit() {
  await click('[data-testid="button-settings-save"]');
  await wait("!document.querySelector('dialog').open");
  await delay(500);
}
async function defaults() {
  await open(); await click('[data-testid="button-settings-defaults"]'); await submit();
}
async function memory(name: string) {
  await page.cdp.call("HeapProfiler.collectGarbage");
  result.memory.push({ name, browser: await page.cdp.evaluate("({used:performance.memory?.usedJSHeapSize,total:performance.memory?.totalJSHeapSize})"),
    heap: await page.cdp.call("Runtime.getHeapUsage"), status: await api("status") });
  await save();
}
try {
  result.v1Read = await api(); assert.equal(result.v1Read.version, 2);
  const raw = JSON.parse(await fs.readFile("data/settings.json", "utf8"));
  result.beforeSaveVersion = raw.version;
  page = await chrome.page("about:blank");
  page.cdp.on("Runtime.exceptionThrown", e => result.errors.push(e));
  await page.cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: `{
    const nativeFetch=fetch.bind(window);window.__settingsGetCount=0;
    window.fetch=(input,init)=>{const u=new URL(typeof input==="string"?input:input.url,location.href);
      if(u.pathname==="/api/settings"&&(!init?.method||init.method==="GET")&&++window.__settingsGetCount===1)
        return Promise.resolve(new Response('{"error":"dummy_initial_503"}',{status:503}));
      return nativeFetch(input,init);
    };
    console.info("ダミー：設定初回GETだけ503を注入。板・約定は実データ");
  }` });
  await page.cdp.call("Page.navigate", { url: "http://127.0.0.1:19090/?mode=replay&from=1793022000&speed=1&debug=1" });
  await ready();
  result.recovery = await page.cdp.evaluate("({getCount:window.__settingsGetCount,warning:document.body.textContent.includes('設定を読めませんでした'),values:window.__heatmapDebug.settings.values})");
  assert.equal(result.recovery.getCount, 2); assert.equal(result.recovery.warning, false);
  await defaults();
  await shot("replay-defaults"); await memory("defaults");
  await open(); assert.equal(await page.cdp.evaluate("document.querySelectorAll('.su-field').length"), 8);
  await shot("settings-eight-fields");
  for (const [key, value] of [["bookBarPct", 20], ["bookBarOpacity", 1], ["bubbleScale", 2]] as const) await set(key, value);
  await submit();
  const applied = await debug();
  assert.equal(applied.settings.values.bookBarPct, 20); assert.equal(applied.settings.values.bookBarOpacity, 1);
  assert.equal(applied.settings.values.bubbleScale, 2); assert.equal((await api()).version, 2);
  await shot("replay-large"); await memory("changed");
  const clip = await page.cdp.evaluate(`(()=>{const r=document.getElementById('delta-scale').getBoundingClientRect();
    return{x:r.x,y:r.y,width:r.width,height:r.height,scale:3}})()`);
  await shot("delta-scale-detail", clip);
  // Real pan: latest board remains, while its forward color band must disappear.
  const box = await page.cdp.evaluate(`(()=>{const r=document.getElementById('heatmap').getBoundingClientRect();
    return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + box.width * .2, y: box.y + 150, button: "left", clickCount: 1 });
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.width * .8, y: box.y + 150, button: "left", buttons: 1 });
  await page.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.width * .8, y: box.y + 150, button: "left" });
  await ready(); assert.equal((await debug()).currentBook.bandStart, null);
  await shot("replay-browse");
  await defaults();
  await chrome.closePage(page);
  page = await chrome.page("http://127.0.0.1:19090/?debug=1"); await ready();
  assert.equal(await page.cdp.evaluate("document.body.textContent.includes('設定を読めませんでした')"), false);
  const observations: any[] = [];
  for (let i = 0; i < 60; i++) { observations.push(await debug()); await delay(100); }
  result.live = { observations, isolated: observations.slice(1).flatMap((next, i) => {
    const prev = observations[i];
    return next.currentBook.drawCount > prev.currentBook.drawCount && next.depthDrawCount === prev.depthDrawCount
      ? [{ before: prev.currentBook, after: next.currentBook, depth: next.depthDrawCount }] : [];
  }) };
  assert.ok(result.live.isolated.length, "real live board-only draws");
  assert.ok(observations.some(d => d.currentBook.bandStart !== null));
  await shot("live-band"); await memory("live");
  await defaults();
  result.finalSettings = await api();
  assert.deepEqual(result.finalSettings.values, { heatTopPct: 1, bubbleMin: 10, bigTopPct: 2, bigMinSec: 5,
    timeZone: "Asia/Tokyo", bubbleScale: 1, bookBarPct: 10, bookBarOpacity: .5 });
  await fs.writeFile(path.join(out, "benchmark-settings.json"), JSON.stringify(result.finalSettings));
  assert.deepEqual(result.errors, []);
  result.success = true;
} catch (e) {
  result.failure = e instanceof Error ? e.stack : String(e);
  throw e;
} finally {
  result.closed = await chrome.close(); result.proxyClosed = await proxy.close();
  const status = await api("status");
  result.wsAfterClose = status.delivery ?? status.pipeline?.delivery ?? status;
  await save();
}
console.log("PHASE9_REVISE_CHECK_PASSED");
