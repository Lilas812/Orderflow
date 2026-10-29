// Isolated browser check: real saved bytes, dummy downstream only, no receiver/upstream.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { browser, delay } from "../../../server/tools/perf/cdp.ts";
import { DEFAULT_SETTINGS } from "../src/data/settings.ts";

const out = "data/crosshair";
await fs.mkdir(out, { recursive: true });
const chrome = await browser(9236);
const result: any = { startedAt: new Date().toISOString(), scenes: [], errors: [], networkRequests: [] };
const page = await chrome.page("about:blank", "artifacts/heatmap/dist/public");
const cdp = page.cdp;
cdp.on("Runtime.exceptionThrown", e => result.errors.push(e.exceptionDetails));
await cdp.call("Runtime.enable");
const feed = (await fs.readFile("server/tools/perf/frozen-feed.js", "utf8"))
  .replace("this.data = data;", "data.metadata.toSec -= 60; this.data = data; window.__crosshairSocket = this;")
  .replace("const last = data.columns.at(-1);", "const last = data.columns.findLast(c => c.sec < data.metadata.toSec);")
  .replace('mode: "replay"', 'mode: new URL(location.href).searchParams.get("mode")==="live" ? "live" : "replay"')
  .replace("c.sec >= start && c.sec < end", "c.sec >= start && c.sec < end && c.sec < this.data.metadata.toSec")
  .replace("t.tsUs >= start * 1e6 && t.tsUs < end * 1e6",
    "t.tsUs >= start * 1e6 && t.tsUs < end * 1e6 && t.tsUs < this.data.metadata.toSec * 1e6")
  .replace('send(text) {', 'send(text) { window.__crosshairSends.push(text);');
await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__crosshairNet=[]; window.__crosshairSends=[];
  window.__crosshairDoc={version:4,updatedAt:null,values:${JSON.stringify(DEFAULT_SETTINGS)}};
  const originalFetch=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
    const u=new URL(typeof input==="string"?input:input.url,location.href);
    window.__crosshairNet.push({url:u.pathname,method:init?.method||"GET"});
    if(u.pathname==="/api/settings"){
      if(init?.method==="PUT")window.__crosshairDoc={version:4,updatedAt:Date.now()*1000,values:JSON.parse(init.body).values};
      return new Response(JSON.stringify(window.__crosshairDoc),{status:200,headers:{"Content-Type":"application/json"}});
    }
    if(u.pathname.startsWith("/api/"))return new Response(JSON.stringify({error:"ダミー隔離環境・データなし"}),{status:503,headers:{"Content-Type":"application/json"}});
    return originalFetch(input,init);
  };
  ${feed}
  addEventListener("DOMContentLoaded",()=>{
    const badge=document.createElement("div");badge.id="dummy-badge";
    badge.textContent="ダミー接続 · 実保存データ固定再生 · 上流接続なし";
    badge.style.cssText="position:fixed;top:0;right:4px;background:#222;color:#fff;font:11px monospace;z-index:9999;pointer-events:none";
    document.body.append(badge);console.info(badge.textContent);
    document.addEventListener("visibilitychange",()=>window.__visibilityEvents=(window.__visibilityEvents||0)+1);
  });
` });
async function evaluate(expression: string) { return cdp.evaluate(expression); }
const debug = () => evaluate("window.__heatmapDebug");
async function wait(expression: string) {
  for (let n = 0; n < 160; n++) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw Error(`wait_failed:${expression}`);
}
const rect = (id: string) => evaluate(`(()=>{let r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
  return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
async function move(x: number, y: number) {
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await delay(70);
}
async function click(x: number, y: number, count = 1) {
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: count });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: count });
  await delay(150);
}
async function shot(name: string) {
  const image = await cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
}
async function checkValue(name: string) {
  const d = await debug(), c = d.crosshair, h = await rect("heatmap");
  assert.equal(c.visible, true, name);
  assert.equal(c.price, ((Math.round(d.viewport.centerPriceTicks + d.viewport.priceSpanTicks / 2 -
    c.y / h.height * d.viewport.priceSpanTicks)) / 4).toFixed(2), name);
  const us = Math.floor(Math.round(d.viewport.startUs + c.x / h.width * d.viewport.durationSec * 1e6) / 1e6) * 1e6;
  assert.equal(c.timeUs, us, name);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: d.settings.values.timeZone, month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(us / 1000));
  const p = (key: string) => parts.find(x => x.type === key)!.value;
  assert.equal(c.time, `${p("month")}/${p("day")} ${p("hour")}:${p("minute")}:${p("second")}`);
  result.scenes.push({ name, crosshair: c, viewport: d.viewport, follow: d.follow, big: d.settings.values.bigOrdersVisible });
}
async function openSettings() {
  await evaluate(`document.querySelector('[data-testid="button-settings"]').click()`);
  await wait(`document.querySelector("dialog").open && !document.querySelector("#su-timeZone").disabled`);
  assert.equal((await debug()).crosshair.visible, false);
}
async function saveSettings(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) await evaluate(`(()=>{
    const e=document.getElementById("su-"+${JSON.stringify(key)});e.value=${JSON.stringify(value)};
    e.dispatchEvent(new Event("input",{bubbles:true}));})()`);
  await evaluate(`document.querySelector('[data-testid="button-settings-save"]').click()`);
  await wait(`!document.querySelector("dialog").open`);
  await delay(250);
}
try {
  await cdp.call("Page.navigate", { url: "http://127.0.0.1/?mode=replay&from=1793021940&speed=1&debug=1" });
  await wait("window.__frozenFeedReady && window.__heatmapDebug?.cachedColumns>0 && !window.__heatmapDebug.loadingRanges");
  await delay(1300);
  await evaluate(`document.getElementById("debug-panel").style.display="none"`);
  const h = await rect("heatmap");
  const x = h.x + h.width * .37, y = h.y + h.height * .43;
  const initial = await debug();
  await move(x, y); await checkValue("enter known coordinate");
  assert.deepEqual((await debug()).viewport, initial.viewport); assert.equal((await debug()).follow, initial.follow);
  await shot("cursor-visible");
  const counters = (d: any) => [d.depthDrawCount, d.overlayDrawCount, d.currentBook.drawCount, d.bigOrders.drawCount,
    d.bigOrders.rebuildCount, d.rangeRequestCount];
  const before = await debug(), netBefore = await evaluate("[window.__crosshairNet.length,window.__crosshairSends.length]");
  await evaluate(`(()=>{const c=document.getElementById("heatmap"),r=c.getBoundingClientRect();
    for(let i=0;i<100;i++)c.dispatchEvent(new PointerEvent("pointermove",{pointerType:"mouse",clientX:r.x+100+i,clientY:r.y+100}));
  })()`);
  await delay(100);
  const after = await debug();
  assert.equal(after.crosshair.drawCount - before.crosshair.drawCount, 1);
  assert.deepEqual(counters(after), counters(before));
  assert.deepEqual(await evaluate("[window.__crosshairNet.length,window.__crosshairSends.length]"), netBefore);
  const idle = after.crosshair.drawCount; await delay(300);
  assert.equal((await debug()).crosshair.drawCount, idle);
  result.mouseOnly = { before: counters(before), after: counters(after), netBefore,
    netAfter: await evaluate("[window.__crosshairNet.length,window.__crosshairSends.length]"), burst: 100,
    cursorDraws: after.crosshair.drawCount - before.crosshair.drawCount, idleExtraDraws: 0 };
  // Empty right margin still reports its coordinate, with no snap to newest data.
  await move(h.x + h.width * .98, h.y + h.height * .5); await checkValue("empty right margin");
  assert.ok((await debug()).crosshair.timeUs > (await debug()).latestTimeUs);
  for (const [fx, fy] of [[.001, .001], [.999, .999]]) {
    await move(h.x + h.width * fx, h.y + h.height * fy); await checkValue("edge labels");
    const c = (await debug()).crosshair;
    for (const [id, label] of [["price-axis", c.priceLabel], ["time-axis", c.timeLabel]] as const) {
      const a = await rect(id), board = await evaluate(`(()=>{let r=document.querySelector(".board").getBoundingClientRect();return{x:r.x,y:r.y}})()`);
      assert.ok(label.x >= a.x - board.x - .01 && label.x + label.width <= a.x - board.x + a.width + .01);
      assert.ok(label.y >= a.y - board.y - .01 && label.y + label.height <= a.y - board.y + a.height + .01);
    }
  }
  for (const id of ["delta", "price-axis", "big-orders", "volume-profile", "time-axis"]) {
    await move(x, y);
    const r = await rect(id);
    if (r.width > 1) { await move(r.x + r.width / 2, r.y + r.height / 2); assert.equal((await debug()).crosshair.visible, false); }
  }
  await shot("cursor-hidden");
  await move(x, y);
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: -70 });
  await delay(180); await checkValue("time wheel with stationary pointer");
  const zoomed = await debug(); assert.notEqual(zoomed.viewport.durationSec, initial.viewport.durationSec);
  const axisZoom = await rect("price-axis"), ax = axisZoom.x + axisZoom.width / 2, ay = axisZoom.y + axisZoom.height / 2;
  await move(ax, ay);
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: ax, y: ay, button: "left", clickCount: 1 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: ax, y: ay + 30, button: "left", buttons: 1 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: ax, y: ay + 30, button: "left" });
  await move(x, y); await checkValue("price-axis drag zoom then re-enter");
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 30, y, button: "left", buttons: 1 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 30, y, button: "left" });
  await delay(250); await checkValue("drag pan"); assert.equal((await debug()).follow, false);
  await click(x, y, 2); await checkValue("body double click"); assert.equal((await debug()).follow, true);
  const pa = await rect("price-axis");
  await click(pa.x + pa.width / 2, pa.y + pa.height / 2, 2);
  assert.equal(await evaluate(`document.querySelector(".auto-price-label").hidden`), false);
  await move(x, y); await checkValue("price AUTO preserved");
  await openSettings(); await saveSettings({ timeZone: "America/Chicago", bigOrdersVisible: "true" });
  const hb = await rect("heatmap"); assert.ok(hb.width < h.width);
  await move(hb.x + hb.width * .4, hb.y + hb.height * .4); await checkValue("Chicago and big-orders visible");
  const rbig = await rect("big-orders");
  await move(rbig.x + rbig.width / 2, rbig.y + rbig.height / 2);
  assert.equal((await debug()).crosshair.visible, false);
  await move(hb.x + hb.width * .4, hb.y + hb.height * .4);
  await evaluate(`window.dispatchEvent(new Event("blur"))`);
  assert.equal((await debug()).crosshair.visible, false);
  await move(hb.x + hb.width * .5, hb.y + hb.height * .4);
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await delay(250); await checkValue("DPR2"); await shot("cursor-dpr2");
  // Real tab visibility event using a second target, then restore the original target.
  const extra = await chrome.page("about:blank");
  await extra.cdp.call("Page.bringToFront"); await delay(150);
  result.visibility = await evaluate("({hidden:document.hidden,events:window.__visibilityEvents||0,cursor:window.__heatmapDebug.crosshair.visible})");
  if (result.visibility.hidden) assert.equal(result.visibility.cursor, false);
  await chrome.closePage(extra); await cdp.call("Page.bringToFront");
  // Headless may keep every target visible: exercise the actual visibility handler deterministically as well.
  await evaluate(`(()=>{
    const c=document.getElementById("heatmap"),r=c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent("pointermove",{pointerType:"mouse",clientX:r.x+20,clientY:r.y+20}));
  })()`); await delay(70);
  await evaluate(`Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))`);
  assert.equal((await debug()).crosshair.visible, false);
  await evaluate(`delete document.hidden`);
  result.visibility.syntheticHandlerPassed = true;
  // Real saved subsequent columns drive follow without any mouse movement.
  await evaluate(`document.querySelector('[data-testid="button-view-reset"]').click()`);
  await delay(200);
  await move(hb.x + hb.width * .35, hb.y + hb.height * .5);
  const beforeFollow = await debug();
  await evaluate(`(()=>{let s=window.__crosshairSocket;
    s.data.metadata.toSec=1793021945;
    for(const c of s.data.columns.filter(c=>c.sec>=1793021940&&c.sec<1793021945))s.frame(1,0,[c]);})()`);
  await delay(250); await checkValue("saved replay column follow, stationary pointer");
  const afterFollow = await debug();
  result.replayFollow = { before: beforeFollow.viewport, after: afterFollow.viewport };
  assert.ok(afterFollow.viewport.startUs > beforeFollow.viewport.startUs);
  assert.equal(afterFollow.follow, true);
  // Touch does not create a persistent crosshair.
  await cdp.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: hb.x + 50, y: hb.y + 50 }] });
  await cdp.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(100); assert.equal((await debug()).crosshair.visible, false);
  // Separate live-mode fixture: the same saved subsequent columns, no actual upstream.
  await cdp.call("Page.navigate", { url: "http://127.0.0.1/?mode=live&debug=1" });
  await wait("window.__frozenFeedReady && window.__heatmapDebug?.cachedColumns>0 && !window.__heatmapDebug.loadingRanges");
  await delay(1200);
  const hl = await rect("heatmap");
  await move(hl.x + hl.width * .45, hl.y + hl.height * .45); await checkValue("dummy live mode initial");
  const liveBefore = await debug();
  assert.equal(liveBefore.viewport.durationSec, 3600);
  await evaluate(`(()=>{let s=window.__crosshairSocket;
    s.data.metadata.toSec=1793021945;
    for(const c of s.data.columns.filter(c=>c.sec>=1793021940&&c.sec<1793021945))s.frame(1,0,[c]);})()`);
  await delay(250); await checkValue("dummy live follow, stationary pointer");
  const liveAfter = await debug();
  assert.ok(liveAfter.viewport.startUs > liveBefore.viewport.startUs);
  assert.equal(liveAfter.follow, true);
  result.liveFollow = { before: liveBefore.viewport, after: liveAfter.viewport };
  // Switching screens clears immediately before unload, and no overlay mounts on long VP.
  await move(hl.x + 80, hl.y + 80);
  await evaluate(`window.__beforeNavCursor=null;document.addEventListener("click",e=>{
    if(e.target.closest('[data-testid="link-view-longvp"]'))window.__beforeNavCursor=window.__heatmapDebug.crosshair.visible;
  });document.querySelector('[data-testid="link-view-longvp"]').click();`);
  await wait(`new URL(location.href).searchParams.get("view")==="longvp" && !document.getElementById("crosshair")`);
  await shot("longvp-no-cursor");
  result.noOverlayOnLongVp = true;
  result.networkRequests = await evaluate("window.__crosshairNet");
  result.passed = true;
} catch (error) {
  result.failure = String(error); throw error;
} finally {
  result.browserClosed = await chrome.close();
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(`${out}/browser-check.json`, JSON.stringify(result, null, 2));
}
console.log("CROSSHAIR_BROWSER_PASSED");
