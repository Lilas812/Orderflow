/** Remaining UI checks via owned native Chromium; never uses upstream or persistent settings. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { browser, delay } from "../tools/perf/cdp.ts";
const out = "data/heatmap-smoothing/remaining-ui";
await fs.mkdir(out, { recursive: true });
const chrome = await browser(9234);
const result: Record<string, any> = { synthetic: true, checks: [], screenshots: [] };
const check = (name: string, value: unknown) => { result.checks.push({ name, value }); };
try {
  const p = await chrome.page("http://127.0.0.1:18814/?debug=1");
  const ready = async (page = p) => {
    for (let i = 0; i < 100; i++) {
      if (await page.cdp.evaluate("!!window.__heatmapDebug && window.__heatmapDebug.cachedColumns>1000")) return;
      await delay(100);
    }
    throw Error("heatmap_not_ready");
  };
  const snap = () => p.cdp.evaluate("({debug:window.__heatmapDebug,hidden:document.hidden,legend:document.querySelector('[data-testid=smoothing-legend]')?.textContent,options:[...document.querySelectorAll('[data-testid^=input-smoothing]')].map(e=>[e.dataset.testid,e.value]),session:{...sessionStorage}})");
  const choose = async (time: string, price: string) => {
    await p.cdp.evaluate(`for(const [key,v]of [["time","${time}"],["price","${price}"]]){const e=document.querySelector('[data-testid=input-smoothing-'+key+']');e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));}`);
    await delay(250);
  };
  const switchSymbol = async (symbol: string) => {
    await p.cdp.evaluate(`const s=[...document.querySelectorAll("select")].find(e=>[...e.options].some(o=>o.value==="GC"));if(!s)throw Error("symbol_selector_missing");s.value="${symbol}";s.dispatchEvent(new Event("change",{bubbles:true}));`);
    await delay(200); await ready();
  };
  const shot = async (name: string) => {
    const s = await p.cdp.call("Page.captureScreenshot", { format: "png" });
    const file = `${out}/${name}.png`; await fs.writeFile(file, Buffer.from(s.data, "base64")); result.screenshots.push(file);
  };
  await ready(); await p.cdp.call("Page.bringToFront");
  if (process.argv.includes("--extra")) {
    await delay(500);
    await p.cdp.evaluate(`window.__quantityTexts=[];const orig=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__quantityTexts.push({canvas:this.canvas.id,text:String(text)});if(window.__quantityTexts.length>1000)window.__quantityTexts.shift();return orig.call(this,text,...args)}`);
    const axis = await p.cdp.evaluate("(()=>{let r=document.querySelector('#price-axis').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    const before = await snap();
    await p.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...axis, button: "left", clickCount: 1 });
    await p.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: axis.x, y: axis.y - 240, button: "left", buttons: 1 });
    await p.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: axis.x, y: axis.y - 240, button: "left", clickCount: 1 });
    await delay(300);
    const zoomed = await snap(); check("price-zoom", { before: before.debug.viewport, after: zoomed.debug.viewport });
    assert(zoomed.debug.viewport.priceSpanTicks < before.debug.viewport.priceSpanTicks);
    await fetch("http://127.0.0.1:18814/__dummy/column?symbol=NQ&size=73");
    await delay(500);
    const texts = await p.cdp.evaluate("window.__quantityTexts");
    check("unaveraged-current-book", { book: (await snap()).debug.currentBook, texts });
    assert(texts.some((t: any) => /book/.test(t.canvas) && t.text === "73"));
    await shot("current-book-raw-73");
    const saved = await snap();
    const navigate = async (screen: string) => {
      await p.cdp.evaluate(`const e=[...document.querySelectorAll('a,button')].find(e=>e.textContent.trim().toUpperCase()==="${screen}");if(!e)throw Error("screen_link_missing");e.click();`);
      await delay(700);
    };
    await navigate("FOOTPRINT");
    const switched = await p.cdp.evaluate("({url:location.href,heatmapPresent:!!document.querySelector('#heatmap'),footprint:!!window.__footprintDebug})");
    check("screen-switch", switched); assert.equal(switched.heatmapPresent, false);
    const apiBefore = await (await fetch("http://127.0.0.1:18814/__dummy/status")).json();
    await fetch("http://127.0.0.1:18814/__dummy/tick?symbol=NQ&price=21001.25&size=4");
    await delay(400);
    check("shared-source-while-footprint", await (await fetch("http://127.0.0.1:18814/__dummy/status")).json());
    await navigate("HEATMAP"); await ready(); await delay(500);
    const back = await snap(); check("screen-restored", { before: saved, after: back, apiBefore });
    assert.equal(back.debug.viewport.priceSpanTicks, saved.debug.viewport.priceSpanTicks);
    assert.equal(back.debug.follow, saved.debug.follow);
    assert.equal(back.debug.currentPrice, 84005);
    assert.match(back.legend, /平均.*自動/);
    await shot("screen-restored");
    result.status = "pass";
  } else {
  check("initial", await snap());
  assert.match((await snap()).legend, /平均.*自動/);
  await p.cdp.evaluate("document.querySelector('dialog')?.showModal()");
  await choose("max", "none");
  check("settings-max-none", await snap());
  await p.cdp.evaluate("document.querySelector('dialog[open]')?.close()");
  await shot("nq-max-none");
  await p.cdp.call("Page.reload"); await delay(200); await ready();
  assert.match((await snap()).legend, /最大.*なし/);
  check("reload-retains", await snap());
  await switchSymbol("GC");
  assert.match((await snap()).legend, /平均.*自動/);
  await choose("max", "auto"); check("GC-independent", await snap());
  await switchSymbol("NQ");
  assert.match((await snap()).legend, /最大.*なし/);
  const second = await chrome.page("http://127.0.0.1:18814/?debug=1"); await ready(second);
  const independent = await second.cdp.evaluate("({hidden:document.hidden,legend:document.querySelector('[data-testid=smoothing-legend]')?.textContent,session:{...sessionStorage}})");
  assert.match(independent.legend, /平均.*自動/);
  check("new-independent-tab-defaults", independent);
  await p.cdp.call("Page.bringToFront");
  await choose("mean", "auto");
  await shot("nq-mean-auto");
  const box = await p.cdp.evaluate("(()=>{let r=document.querySelector('#heatmap').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()");
  const depth = (await snap()).debug.depthDrawCount;
  for (let i = 0; i < 12; i++) await p.cdp.call("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: box.x + box.w / 2 + i * 3, y: box.y + box.h / 2 });
  await delay(200);
  const cursor = await snap(); check("cursor", cursor);
  assert.equal(cursor.debug.depthDrawCount, depth, "cursor must not rebuild depth");
  const beforePan = cursor.debug.viewport;
  await p.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + box.w / 2, y: box.y + box.h / 2, button: "left", clickCount: 1 });
  await p.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.w / 2 + 100, y: box.y + box.h / 2, button: "left", buttons: 1 });
  await p.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + box.w / 2 + 100, y: box.y + box.h / 2, button: "left", clickCount: 1 });
  await delay(300);
  const pan = await snap(); check("pan", pan); assert.notEqual(pan.debug.viewport.startUs, beforePan.startUs);
  await p.cdp.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x + box.w / 2, y: box.y + box.h / 2, deltaY: -200, deltaX: 0 });
  await delay(300); check("wheel", await snap());
  const stable = await snap();
  await second.cdp.call("Page.bringToFront"); await delay(200);
  const hidden = await snap();
  await fetch("http://127.0.0.1:18814/__dummy/tick?symbol=NQ&price=21001&size=3");
  const sec = Math.floor((stable.debug.viewport.startUs / 1e6) + stable.debug.viewport.durationSec / 2);
  await fetch(`http://127.0.0.1:18814/__dummy/column?symbol=NQ&sec=${sec}&size=73`);
  await delay(700);
  const hiddenAfter = await snap(); check("background-before", hidden); check("background-after", hiddenAfter);
  assert.equal(hidden.hidden, true);
  assert.equal(hiddenAfter.debug.depthDrawCount, hidden.debug.depthDrawCount);
  assert.equal(hiddenAfter.debug.currentPrice, 84004);
  await p.cdp.call("Page.bringToFront"); await delay(400);
  const restored = await snap(); check("background-restored", restored);
  assert.deepEqual(restored.debug.viewport, stable.debug.viewport); assert.equal(restored.debug.follow, stable.debug.follow);
  assert(restored.debug.depthDrawCount > hiddenAfter.debug.depthDrawCount);
  await shot("restored-late-correction");
  const api = await (await fetch("http://127.0.0.1:18814/__dummy/status")).json();
  assert.equal(api.settingsPuts, 0); check("no-settings-put", api);
  result.status = "pass";
  }
} catch (e) { result.status = "failed"; result.error = String(e); }
finally {
  result.closed = await chrome.close();
  await delay(200);
  result.finalServer = await (await fetch("http://127.0.0.1:18814/__dummy/status")).json();
  await fs.writeFile(`${out}/${process.argv.includes("--extra") ? "native-extra" : "native-ui"}.json`, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ status: result.status, error: result.error, checks: result.checks.map((c: any) => c.name), closed: result.closed }));
if (result.status !== "pass") process.exitCode = 1;
