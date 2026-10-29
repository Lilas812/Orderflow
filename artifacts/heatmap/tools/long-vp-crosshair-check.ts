import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { browser, delay } from "../../../server/tools/perf/cdp.ts";
import { DEFAULT_SETTINGS } from "../src/data/settings.ts";
import { defaults } from "../src/long-vp/settings-schema.ts";
import { dayStartSec, dayEndSec } from "../src/long-vp/time.ts";

const out = "data/crosshair";
await fs.mkdir(out, { recursive: true });
const days = ["2026-10-26", "2026-10-27", "2026-10-28"].map((date, index) => {
  const start = dayStartSec(date), contract = index < 2 ? "NQZ26" : "NQH27";
  const base = index < 2 ? 117200 : 117300;
  return { version: 1, tradingDate: date, startSec: start, endSec: dayEndSec(date),
    contracts: [{ contract, fromSec: start, toSec: dayEndSec(date) }],
    bars1m: Array.from({ length: 120 }, (_, n) => [start + 14 * 3600 + n * 60, base + n % 16,
      base + n % 16 + 4, base + n % 16 - 4, base + n % 16 + 1, n % 3 ? 10 : 2, n % 3 ? 4 : 20, 0]),
    vp30m: Array.from({ length: 4 }, (_, n) => [start + 14 * 3600 + n * 1800, base + n * 4, 100, 60, 0]),
    gaps: [[start + 3 * 3600, start + 4 * 3600]], complete: true, builtAtUs: 1 };
});
const rolls = [{ from: "NQZ26", to: "NQH27", atSec: dayStartSec("2026-10-28"), diffTicks: 80, method: "dummy-test" }];
const c = await browser(9237);
const result: any = { scenes: [], errors: [], realWebSockets: [] };
const page = await c.page("about:blank", "artifacts/heatmap/dist/public"), cdp = page.cdp;
await cdp.call("Runtime.enable"); await cdp.call("Network.enable");
cdp.on("Runtime.exceptionThrown", e => result.errors.push(e.exceptionDetails));
cdp.on("Network.webSocketCreated", e => result.realWebSockets.push(e.url));
await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__lvRequests=[];window.__dummyWs=0;
  window.WebSocket=class extends EventTarget{static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=0;
    constructor(){super();window.__dummyWs++}close(){this.readyState=3}send(){}};
  let settings={version:1,updatedAt:null,values:${JSON.stringify(defaults)}};
  const days=${JSON.stringify(days)},rolls=${JSON.stringify(rolls)},nativeFetch=fetch.bind(window);
  window.fetch=async(input,init)=>{
    const u=new URL(typeof input==="string"?input:input.url,location.href);
    if(!u.pathname.startsWith("/api/"))return nativeFetch(input,init);
    window.__lvRequests.push({url:u.pathname+u.search,method:init?.method||"GET"});
    let body,status=200;
    if(u.pathname==="/api/settings")body={version:4,updatedAt:null,values:${JSON.stringify({ ...DEFAULT_SETTINGS, timeZone: "America/Chicago" })}};
    else if(u.pathname==="/api/settings/longvp"){
      if(init?.method==="PUT")settings={version:1,updatedAt:Date.now()*1000,values:JSON.parse(init.body).values};
      body=settings;
    }else if(u.pathname==="/api/longvp/days")body=days.filter(d=>d.tradingDate>=u.searchParams.get("from")&&d.tradingDate<=u.searchParams.get("to"));
    else if(u.pathname==="/api/longvp/rolls")body=rolls;
    else{status=503;body={error:"ダミー環境・当日データなし"}}
    return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
  };
  addEventListener("DOMContentLoaded",()=>{
    const b=document.createElement("div");b.textContent="ダミー LONG VPデータ · 限月差+80tick · 上流/保存先への通信なし";
    b.style.cssText="position:fixed;top:0;right:4px;z-index:9999;background:#222;color:white;font:11px monospace;pointer-events:none";document.body.append(b);
    console.info(b.textContent);
  });
` });
const ev = (s: string) => cdp.evaluate(s), debug = () => ev("window.__longVpDebug");
async function wait(s: string) { for (let i = 0; i < 150; i++) { if (await ev(s)) return; await delay(100); } throw Error(`timeout:${s}`); }
async function move(x: number, y: number) { await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await delay(70); }
async function shot(name: string) { const s = await cdp.call("Page.captureScreenshot", { format: "png" }); await fs.writeFile(`${out}/${name}.png`, Buffer.from(s.data, "base64")); }
async function position() { return ev(`(()=>{let r=document.getElementById("lv-canvas").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`); }
async function value(name: string) {
  const d = await debug(), v = d.cursor, L = d.layout;
  assert.equal(v.visible, true);
  const n = v.band === "price" ? Math.round(d.view.priceHigh - v.y / L.priceH * (d.view.priceHigh - d.view.priceLow))
    : Math.round(d.cvdAxis.high - (v.y - d.cvdAxis.top) / d.cvdAxis.height * (d.cvdAxis.high - d.cvdAxis.low));
  assert.equal(v.label, v.band === "price" ? (n / 4).toFixed(2) : String(n));
  assert.equal(v.sec, Math.floor(d.view.startSec + v.x / L.plotW * (d.view.endSec - d.view.startSec)));
  result.scenes.push({ name, ...d });
}
async function settings(values: Record<string, string | boolean>) {
  await ev(`document.getElementById("lv-settings").click()`);
  assert.equal((await debug()).cursor.visible, false);
  await wait(`document.querySelector("dialog").open&&!document.getElementById("lv-su-showWeeklyCvd").disabled`);
  for (const [k, v] of Object.entries(values)) await ev(`(()=>{let e=document.getElementById("lv-su-"+${JSON.stringify(k)});
    ${typeof v === "boolean" ? `e.checked=${v};` : `e.value=${JSON.stringify(v)};`}e.dispatchEvent(new Event(${JSON.stringify(typeof v === "boolean" ? "change" : "input")},{bubbles:true}));})()`);
  await ev(`document.querySelector('[data-testid="button-longvp-settings-save"]').click()`);
  await wait(`!document.querySelector("dialog").open`); await delay(200);
}
try {
  await cdp.call("Page.navigate", { url: "http://127.0.0.1/?view=longvp&debug=1" });
  await wait("window.__longVpDebug?.view.priceLow>117200 && document.querySelector('#lv-legend').textContent.includes('cached')");
  await delay(600);
  let r = await position(), d = await debug();
  assert.ok(d.view.priceLow > 117250, "old-contract bars adjusted +80 once");
  await move(r.x + d.layout.plotW * .5, r.y + d.layout.priceH * .5);
  await value("adjusted price chart"); await shot("longvp-price-visible");
  await move(r.x + d.layout.plotW * .5, r.y + d.layout.cvdTop + d.layout.cvdH * .5);
  await value("weekly CVD"); await shot("longvp-cvd-visible");
  const before = await debug(), net = await ev("window.__lvRequests.length");
  await ev(`(()=>{let e=document.getElementById("lv-canvas"),r=e.getBoundingClientRect();for(let n=0;n<100;n++)
    e.dispatchEvent(new PointerEvent("pointermove",{pointerType:"mouse",clientX:r.x+100+n,clientY:r.y+150}));})()`);
  await delay(100); const after = await debug();
  assert.deepEqual([after.baseDraws, after.seriesBuilds, after.profileBuilds], [before.baseDraws, before.seriesBuilds, before.profileBuilds]);
  assert.equal(await ev("window.__lvRequests.length"), net);
  assert.equal(after.cursor.drawCount - before.cursor.drawCount, 1);
  await delay(200); assert.equal((await debug()).cursor.drawCount, after.cursor.drawCount);
  result.mouseOnly = { before, after, requestsBefore: net, requestsAfter: await ev("window.__lvRequests.length"), idleExtraDraws: 0 };
  for (const [x, y] of [[d.layout.plotW + 20, 100], [200, d.layout.cvdTop], [200, d.layout.timeTop + 10]]) {
    await move(r.x + x, r.y + y); assert.equal((await debug()).cursor.visible, false);
  }
  await shot("longvp-cursor-hidden");
  await move(r.x + 200, r.y + 150);
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: r.x + 200, y: r.y + 150, deltaY: -100, deltaX: 0 });
  await delay(180); await value("time zoom stationary pointer");
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x + 200, y: r.y + 150, button: "left", clickCount: 1 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + 230, y: r.y + 165, button: "left", buttons: 1 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 230, y: r.y + 165, button: "left" });
  await delay(180); await value("pan price and time");
  d = await debug();
  await move(r.x + 300, r.y + d.layout.cvdTop);
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x + 300, y: r.y + d.layout.cvdTop, button: "left", clickCount: 1 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + 300, y: r.y + d.layout.cvdTop - 45, button: "left", buttons: 1 });
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x + 300, y: r.y + d.layout.cvdTop - 45, button: "left" });
  await delay(180); assert.notEqual((await debug()).layout.priceH, d.layout.priceH);
  await move(r.x + 300, r.y + 150); await value("divider resized");
  await settings({ showWeeklyCvd: false, priceStyle: "candles", vpPeriod: "week" });
  d = await debug(); assert.equal(d.layout.cvdH, 0);
  await move(r.x + 300, r.y + d.layout.priceH * .9); await value("CVD hidden, candles and weekly VP");
  assert.equal((await debug()).cursor.band, "price");
  await shot("longvp-cvd-hidden");
  await settings({ showWeeklyCvd: true, priceStyle: "line", vpPeriod: "day" });
  d = await debug();
  await move(r.x + 300, r.y + d.layout.cvdTop + 35); await value("CVD restored, line and daily VP");
  await ev(`window.dispatchEvent(new Event("blur"))`); assert.equal((await debug()).cursor.visible, false);
  await move(r.x + 301, r.y + 151);
  await ev(`Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));`);
  assert.equal((await debug()).cursor.visible, false); await ev(`delete document.hidden`);
  await move(r.x + 301, r.y + 151);
  await cdp.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x + 100, y: r.y + 100 }] });
  await cdp.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await delay(120);
  assert.equal((await debug()).cursor.visible, false);
  result.netBeforeSwitch = await ev("window.__lvRequests"); assert.equal(await ev("window.__dummyWs"), 0);
  await ev(`document.querySelector('[data-testid="link-view-heatmap"]').click()`);
  await wait("document.getElementById('heatmap') && !document.getElementById('lv-crosshair')");
  assert.equal((await ev("window.__heatmapDebug?.crosshair.visible")) ?? false, false);
  assert.deepEqual(result.realWebSockets, []); assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) { result.failure = String(error); throw error; }
finally { result.browserClosed = await c.close(); await fs.writeFile(`${out}/longvp-check.json`, JSON.stringify(result, null, 2)); }
console.log("LONGVP_CROSSHAIR_PASSED");
