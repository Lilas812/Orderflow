import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { browser, delay } from "../../../server/tools/perf/cdp.ts";
import { defaults } from "../../../server/src/settings/schema.ts";

const base = "http://127.0.0.1:25028", out = "data/phase14";
const result: any = { scenes: [], append: [], errors: [] };
const api = async (route: string, values?: object) => {
  const r = await fetch(`${base}/api/${route}`, values ? { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }) } : {});
  assert.equal(r.status, 200); return r.json();
};
const c = await browser(9224), page = await c.page("about:blank");
const debug = () => page.cdp.evaluate("window.__heatmapDebug");
async function wait(e: string) {
  const until = Date.now() + 90000;
  while (Date.now() < until) { if (await page.cdp.evaluate(e)) return; await delay(100); }
  throw Error(`timeout:${e}`);
}
async function navigate(from: number | null) {
  await page.cdp.call("Page.navigate", { url: `${base}/?${from === null ? "" : `mode=replay&from=${from}&speed=1&`}debug=1` });
  await wait("window.__heatmapDebug?.traffic.initialComplete && !window.__heatmapDebug.loadingRanges");
  await page.cdp.evaluate(`document.querySelector("#debug-panel").style.display="none"`);
}
async function span(sec: number) {
  while (Math.abs((await debug()).viewport.durationSec - sec) > .01) {
    const d = Math.log(sec / (await debug()).viewport.durationSec) / .0015;
    await page.cdp.evaluate(`(()=>{const e=document.getElementById("heatmap"),r=e.getBoundingClientRect();
      e.dispatchEvent(new WheelEvent("wheel",{clientX:r.x+r.width*.8,clientY:r.y+r.height*.5,deltaY:${Math.max(-1300, Math.min(1300, d))},bubbles:true,cancelable:true}));})()`);
    await delay(250);
  }
  await wait("!window.__heatmapDebug.loadingRanges");
}
async function capture(name: string, event?: { sec: number; price: number }) {
  const state = await debug();
  let clip: object | undefined;
  if (event) {
    const r = await page.cdp.evaluate(`(()=>{const r=document.getElementById("heatmap").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const x = r.x + (event.sec * 1e6 - state.viewport.startUs) / (state.viewport.durationSec * 1e6) * r.width;
    const y = r.y + (.5 - (event.price - state.viewport.centerPriceTicks) / state.viewport.priceSpanTicks) * r.height;
    clip = { x: Math.max(r.x, Math.min(r.x + r.width - 240, x - 120)),
      y: Math.max(r.y, Math.min(r.y + r.height - 80, y - 40)), width: 240, height: 80, scale: 2 };
  }
  const image = await page.cdp.call("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  await fs.writeFile(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
  result.scenes.push({ name, event, clip, debug: state });
}
try {
  await page.cdp.call("Runtime.enable"); page.cdp.on("Runtime.exceptionThrown", x => result.errors.push(x.exceptionDetails.text));
  await api("settings", { ...defaults });
  await navigate(null);
  result.liveDefault = (await debug()).viewport.durationSec;
  assert.equal(result.liveDefault, 3600);
  for (const heatStyle of ["glow", "block"] as const) {
    await api("settings", { ...defaults, heatStyle }); await navigate(1793022000);
    await wait("window.__heatmapDebug.cachedColumns>0");
    const begin = await page.cdp.evaluate("performance.now()");
    await delay(8500);
    const frames = await page.cdp.evaluate(`window.__heatmapFrameStats.filter(f=>f.at>=${begin})`);
    result.append.push({ heatStyle, frames, status: await api("status"), debug: await debug(),
      memory: await page.cdp.evaluate("performance.memory ? {used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null") });
  }
  // Clean side-by-side screenshots: same saved scene and exactly the same replay cutoff.
  for (const [name, heatStyle, seconds] of [
    ["clean-glow-10m", "glow", 600], ["clean-block-10m", "block", 600],
    ["clean-glow-1h", "glow", 3600], ["clean-block-1h", "block", 3600],
  ] as const) {
    await api("settings", { ...defaults, heatStyle }); await navigate(1793022000); await span(seconds);
    await wait("window.__heatmapDebug.replayHeadUs>=1793022012000000"); await capture(name);
  }
  // Real saved transitions, fixed thresholds for reproducible fade inspection (not synthetic data).
  await api("settings", { ...defaults, heatUpperMode: "size", heatUpperSize: 6, heatLowerMode: "size", heatLowerSize: 4 });
  await navigate(1793021460); await span(60);
  await capture("fade-appearance-cancel", { sec: 1793021430, price: 117240 });
  await navigate(1793021900); await span(60);
  await capture("fade-eaten", { sec: 1793021878, price: 117215 });
  await api("settings", { ...defaults }); await navigate(1793022000);
  await delay(1200);
  const before = await debug();
  await page.cdp.evaluate(`document.querySelector('[data-testid="button-settings"]').click()`);
  await wait("document.querySelector('dialog').open && !document.querySelector('#su-bigOrdersVisible').disabled");
  await page.cdp.evaluate(`(()=>{const e=document.querySelector("#su-bigOrdersVisible");e.value="true";e.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector('[data-testid="button-settings-save"]').click()})()`);
  await wait("!document.querySelector('dialog').open && window.__heatmapDebug.settings.values.bigOrdersVisible");
  await delay(1500); const after = await debug();
  assert.equal(after.bigOrders.tracking.rebuildCount, before.bigOrders.tracking.rebuildCount);
  assert.ok(after.bigOrders.tracking.processedColumns >= before.bigOrders.tracking.processedColumns);
  result.trackingToggle = { before: before.bigOrders.tracking, after: after.bigOrders.tracking };
  await capture("clean-big-visible");
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.failure = String(error);
  result.failedDebug = await debug().catch(() => null);
  throw error;
} finally {
  result.restored = await api("settings", { ...defaults });
  result.browserClosed = await c.close();
  result.statusAfterClose = await api("status");
  await fs.writeFile(`${out}/evidence.json`, JSON.stringify(result, null, 2));
}
console.log("PHASE14_EVIDENCE_PASSED");
