import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { browser, delay } from "../../../server/tools/perf/cdp.ts";
import { DEFAULT_SETTINGS } from "../src/data/settings.ts";
import { defaults } from "../src/long-vp/settings-schema.ts";
import { dayStartSec, dayEndSec } from "../src/long-vp/time.ts";

const out = "data/gc-implementation";
await fs.mkdir(out, { recursive: true });
const dates = ["2026-10-26", "2026-10-27", "2026-10-28"];
const days = Object.fromEntries(["NQ", "GC"].map(symbol => [symbol, dates.map((date, i) => {
  const start = dayStartSec(date), base = symbol === "GC" ? 40283 : 117200;
  return { version: 1, tradingDate: date, startSec: start, endSec: dayEndSec(date),
    contracts: [{ contract: symbol === "GC" ? (i === 2 ? "UNKNOWN" : "GCZ6") : "NQZ6",
      fromSec: start, toSec: dayEndSec(date) }],
    bars1m: Array.from({ length: 120 }, (_, n) => [start + 14 * 3600 + n * 60, base + n % 16,
      base + n % 16 + 4, base + n % 16 - 4, base + n % 16 + 1, 10, 4, 0]),
    vp30m: Array.from({ length: 4 }, (_, n) => [start + 14 * 3600 + n * 1800, base + n * 4, 100, 60, 0]),
    gaps: [], complete: true, builtAtUs: 1 };
})]));
const feed = (await fs.readFile("server/tools/perf/frozen-feed.js", "utf8"))
  .replace('mode: "replay"', 'mode: "live"')
  .replace('symbol: "NQ", tickSize: 0.25', 'symbol: sessionStorage.getItem("heatmap.instrument") || "NQ", tickSize: sessionStorage.getItem("heatmap.instrument")==="GC" ? .1 : .25')
  .replace("return { metadata, columns, trades };", `
    const symbol=sessionStorage.getItem("heatmap.instrument")||"NQ";
    if(symbol==="GC"){
      const shift=trades[0].price-40283;
      for(const c of columns){const v=new DataView(c.bytes.buffer,c.bytes.byteOffset,c.bytes.byteLength);
        for(let p=9;p<c.bytes.byteLength;p+=8)v.setInt32(p,v.getInt32(p,true)-shift,true)}
      for(const t of trades)t.price-=shift;
    }
    const levels=new Map();
    for(const t of trades){let row=levels.get(t.price);if(!row){row=[t.price,0,0];levels.set(t.price,row)}row[t.side==="buy"?1:2]+=t.size}
    window.__frozenVp={type:"vp",sessionStartSec:metadata.fromSec,upToSec:metadata.toSec,loading:false,levels:[...levels.values()]};
    window.__gcFixtureSymbol=symbol;
    return { metadata, columns, trades };`);
const source = `
  window.__gcRequests=[];window.__gcLate=false;window.__gcSockets=[];
  const days=${JSON.stringify(days)};
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
    const u=new URL(typeof input==="string"?input:input.url,location.href);
    if(!u.pathname.startsWith("/api/"))return nativeFetch(input,init);
    window.__gcRequests.push(u.pathname+u.search);
    let body,status=200;
    if(u.pathname==="/api/settings")body={version:4,updatedAt:null,values:${JSON.stringify(DEFAULT_SETTINGS)}};
    else if(u.pathname==="/api/settings/longvp")body={version:1,updatedAt:null,values:${JSON.stringify(defaults)}};
    else if(u.pathname==="/api/longvp/days"){
      const symbol=u.searchParams.get("symbol")||"NQ";
      if(window.__gcLate)await new Promise(r=>setTimeout(r,650));
      body=days[symbol].filter(d=>d.tradingDate>=u.searchParams.get("from")&&d.tradingDate<=u.searchParams.get("to"));
      if(symbol==="GC"&&location.search.includes("unknown=1"))
        body=body.map(d=>({...d,contracts:d.contracts.map(c=>({...c,contract:"UNKNOWN"}))}));
      if(symbol==="GC"&&location.search.includes("oldcontract=1"))
        body=body.map(d=>({...d,contracts:d.contracts.map(c=>({...c,contract:"GCJ6"}))}));
    }else if(u.pathname==="/api/longvp/rolls")body=[];
    else{status=503;body={error:"ダミー隔離検証・当日データなし"}}
    return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json",
      "X-LongVP-Front-Contract":u.searchParams.get("symbol")==="GC"?"GCZ6":"NQZ6"}});
  };
  ${feed}
  const FixtureSocket=window.WebSocket;
  window.WebSocket=class extends FixtureSocket{constructor(url,...args){super(url,...args);window.__gcSockets.push(String(url))}};
  addEventListener("DOMContentLoaded",()=>{
    const badge=document.createElement("div");badge.textContent="隔離表示確認：ダミーGC／保存済みNQの固定再生・本番と上流に通信しません";
    badge.style.cssText="position:fixed;bottom:1px;left:48px;z-index:9999;background:#222;color:#fff;font:10px monospace;pointer-events:none";
    document.body.append(badge);
  });
`;
const c = await browser(9248);
const result: any = { scenes: [], errors: [], realWebSockets: [], providerRequests: [], isolated: true };
async function prepare() {
  const page = await c.page("about:blank", "artifacts/heatmap/dist/public"), cdp = page.cdp;
  await cdp.call("Runtime.enable"); await cdp.call("Network.enable");
  cdp.on("Runtime.exceptionThrown", e => result.errors.push(e.exceptionDetails));
  cdp.on("Network.webSocketCreated", e => result.realWebSockets.push(e.url));
  cdp.on("Network.requestWillBeSent", e => {
    if (/tick-stream\.xyz|replit\.app/.test(e.request.url)) result.providerRequests.push(e.request.url);
  });
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source });
  return cdp;
}
async function wait(cdp: any, expression: string) {
  for (let n = 0; n < 160; n++) {
    try { if (await cdp.evaluate(expression)) return; } catch {}
    await delay(100);
  }
  throw Error("wait failed: " + expression);
}
async function select(cdp: any, symbol: string) {
  await cdp.evaluate(`(()=>{const s=document.querySelector('[data-testid="instrument-select"]');s.value=${JSON.stringify(symbol)};s.dispatchEvent(new Event("change",{bubbles:true}))})()`).catch(() => {});
  await wait(cdp, `document.querySelector('[data-testid="instrument-select"]')?.value===${JSON.stringify(symbol)} && window.__gcFixtureSymbol===${JSON.stringify(symbol)} && window.__frozenFeedReady`);
}
async function cursor(cdp: any, key: string) {
  const r = await cdp.evaluate("(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return{x:r.x+r.width*.45,y:r.y+r.height*.3}})()");
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...r }); await delay(200);
  return cdp.evaluate(`window.${key}.${key === "__longVpDebug" ? "cursor" : "crosshair"}`);
}
async function screenshot(cdp: any, name: string) {
  const shot = await cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(`${out}/${name}.png`, Buffer.from(shot.data, "base64"));
}
try {
  const first = await prepare();
  await first.call("Page.navigate", { url: "http://127.0.0.1/?mode=live&debug=1" });
  await wait(first, "window.__frozenFeedReady && window.__heatmapDebug?.cachedColumns>0");
  assert.equal(await first.evaluate("document.querySelector('[data-testid=\"instrument-select\"]').value"), "NQ");
  result.scenes.push({ name: "NQ default", cursor: await cursor(first, "__heatmapDebug"),
    currentPrice: await first.evaluate("window.__heatmapDebug.currentPrice") });
  await screenshot(first, "nq-heatmap");
  await select(first, "GC");
  const gcCursor = await cursor(first, "__heatmapDebug");
  result.scenes.push({ name: "GC heatmap", cursor: gcCursor,
    currentPrice: await first.evaluate("window.__heatmapDebug.currentPrice"),
    ws: await first.evaluate("window.__gcSockets"), vp: await first.evaluate("window.__heatmapDebug.vp"),
    delta: await first.evaluate("window.__heatmapDebug.delta") });
  assert.match(JSON.stringify(gcCursor), /\\?\"price\\?\":\\?\"-?\d+\.\d\\?\"/);
  assert.ok((await first.evaluate("window.__heatmapDebug.currentPrice")) < 100000);
  assert.ok((await first.evaluate("window.__gcSockets[0]")).includes("symbol=GC"));
  await screenshot(first, "gc-heatmap");
  await first.call("Page.reload", { ignoreCache: true });
  await wait(first, "window.__frozenFeedReady && window.__gcFixtureSymbol==='GC'");
  result.reloadGC = true;
  const second = await prepare();
  await second.call("Page.navigate", { url: "http://127.0.0.1/?mode=live&debug=1" });
  await wait(second, "window.__frozenFeedReady");
  assert.equal(await second.evaluate("document.querySelector('[data-testid=\"instrument-select\"]').value"), "NQ");
  assert.equal(await first.evaluate("document.querySelector('[data-testid=\"instrument-select\"]').value"), "GC");
  result.independentTabs = true;
  await first.call("Page.bringToFront");
  await first.evaluate("document.querySelector('[data-testid=\"link-view-longvp\"]').click()").catch(() => {});
  await wait(first, "location.search.includes('view=longvp') && document.querySelector('[data-testid=\"instrument-select\"]')?.value==='GC'");
  await first.call("Page.navigate", { url: "http://127.0.0.1/?view=longvp&debug=1" });
  await wait(first, "window.__longVpDebug?.baseDraws>0 && window.__longVpDebug.view.priceHigh>40000");
  await delay(1500);
  result.scenes.push({ name: "GC long VP", cursor: await cursor(first, "__longVpDebug"),
    debug: await first.evaluate("window.__longVpDebug"), requests: await first.evaluate("window.__gcRequests") });
  assert.equal(result.scenes.at(-1).cursor.visible, true);
  assert.match(result.scenes.at(-1).cursor.label, /^\d+\.\d$/);
  await screenshot(first, "gc-long-vp");
  await first.call("Emulation.setDeviceMetricsOverride", { width: 420, height: 844, deviceScaleFactor: 1, mobile: false });
  await delay(400); await screenshot(first, "gc-mobile");
  result.mobile = await first.evaluate("(()=>{const h=document.querySelector('.masthead');return{width:h.clientWidth,content:h.scrollWidth}})()");
  assert.ok(result.mobile.content <= result.mobile.width);
  await first.call("Page.navigate", { url: "http://127.0.0.1/?view=longvp&debug=1&oldcontract=1" });
  await wait(first, "window.__longVpDebug?.baseDraws>0 && window.__longVpDebug.cvdAxis.high>1");
  assert.equal(await first.evaluate("window.__longVpDebug.view.priceHigh"), 100);
  assert.ok(await first.evaluate("document.body.textContent.includes('調整不能')"));
  result.metadataDoesNotInventRoll = true;
  await first.call("Page.navigate", { url: "http://127.0.0.1/?view=longvp&debug=1&unknown=1" });
  await wait(first, "window.__longVpDebug?.baseDraws>0 && document.body.textContent.includes('限月不明')");
  assert.ok((await first.evaluate("window.__longVpDebug.cvdAxis.high")) > 1);
  result.unknownContractCvdVisible = true;
  await screenshot(first, "gc-unknown-contract");
  // Start a delayed old-symbol range, then switch the document/instrument.
  await first.evaluate("window.__gcLate=true;void fetch('/api/longvp/days?symbol=GC&from=2026-10-26&to=2026-10-28')");
  await first.evaluate("(()=>{const s=document.querySelector('[data-testid=\"instrument-select\"]');s.value='NQ';s.dispatchEvent(new Event('change',{bubbles:true}))})()").catch(() => {});
  await wait(first, "document.querySelector('[data-testid=\"instrument-select\"]')?.value==='NQ' && window.__longVpDebug?.view.priceHigh>100000");
  await delay(1000);
  assert.equal(await second.evaluate("sessionStorage.getItem('heatmap.instrument')"), null);
  const requests = await first.evaluate("window.__gcRequests");
  assert.ok(requests.filter((u: string) => u.startsWith("/api/longvp/")).every((u: string) => u.includes("symbol=NQ")));
  result.lateResponseIsolated = true;
  result.scenes.push({ name: "NQ long VP after delayed GC response", debug: await first.evaluate("window.__longVpDebug") });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.realWebSockets, []); assert.deepEqual(result.providerRequests, []);
  result.pass = true;
} finally {
  result.browserClose = await c.close();
  await fs.writeFile(`${out}/browser.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
