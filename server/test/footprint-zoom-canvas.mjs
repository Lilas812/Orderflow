/** Isolated real Canvas sampling; fixed saved input, no upstream. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { browser, waitFor, delay } from "./footprint-cdp.mjs";
import { tradeFileRows } from "../src/store/records.ts";
const root = "data/footprint-zoom", origin = "http://127.0.0.1:18885";
const heatOnly = process.argv.includes("--heatmap-only");
const output = `${root}/${heatOnly ? "canvas-heatmap-result" : "canvas-result"}.json`;
await fs.mkdir(root, { recursive: true });
const replay = await (await fetch(origin + "/__replay")).json();
const centers = {};
for (const symbol of ["NQ", "GC"]) {
  let distance = Infinity;
  for (const input of replay.inputs.filter(f => f.file.includes(`/trades/${symbol}/`))) {
    for await (const t of tradeFileRows(input.file)) {
      const d = Math.abs(t.tsUs - (replay.from + 1500) * 1e6);
      if (d < distance) { centers[symbol] = t.price; distance = d; }
    }
  }
}
const b = await browser({ headed: true, extraArgs: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] }), results = [];
const checks = heatOnly ? JSON.parse(await fs.readFile(output, "utf8")).checks : {};
const q = (v, p) => [...v].sort((a, z) => a - z)[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)] ?? null;
const instrumentation = `(()=>{
window.__zoomPaint=[]; let active=null;
for(const type of [CanvasRenderingContext2D,WebGLRenderingContext,WebGL2RenderingContext]){
 for(const key of ['fillRect','stroke','fillText','drawImage','putImageData','drawArrays']){
  const f=type.prototype[key]; if(!f)continue;
  type.prototype[key]=function(...args){if(active)active.ids.add(this.canvas.id);return f.apply(this,args)};
 }
}
const raf=requestAnimationFrame.bind(window);
window.requestAnimationFrame=f=>raf(t=>{const old=active,a={at:performance.now(),ids:new Set()};active=a;
 try{return f(t)}finally{active=old;if(a.ids.size)window.__zoomPaint.push({at:a.at,ms:performance.now()-a.at,ids:[...a.ids]})}});
})()`;
async function page(symbol, mode, tf = 5, rowH = 16, width = 1200, height = 900) {
  const p = await b.page();
  await p.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const fp = mode === "footprint";
  await p.call("Page.addScriptToEvaluateOnNewDocument", { source: `
    Date.now=()=>${replay.end * 1000};
    sessionStorage.setItem("heatmap.instrument",${JSON.stringify(symbol)});
    sessionStorage.setItem("footprint.timeframe","5");
    sessionStorage.setItem("view.footprint.${symbol}",JSON.stringify({endSec:${replay.from + 1800},barW:92,rowH:${rowH},centerPrice:0,follow:false,displayTf:${tf}}));
    sessionStorage.setItem("view.heatmap.${symbol}",JSON.stringify({follow:false,viewport:{startUs:${(replay.from + 1200) * 1e6},durationSec:600,centerPriceTicks:${centers[symbol]},priceSpanTicks:${tf}}}));
    ${instrumentation}` });
  await p.call("Page.navigate", { url: `${origin}/?debug=1${fp ? "&view=footprint" : "&renderer=" + mode}` });
  await waitFor(async () => p.evaluate(fp
    ? `!!window.__footprintDebug?.bars.some(x=>x.bar)`
    : `!!(window.__heatmapDebug?.cachedColumns && window.__heatmapDebug?.depthDrawCount && window.__heatmapDebug?.cachedTrades && !window.__heatmapDebug?.loadingRanges)`), 20000);
  await delay(1200);
  return p;
}
const snapshot = (p, fp) => p.evaluate(fp ? "window.__footprintDebug" : "window.__heatmapDebug");
function verifyRows(d) {
  for (const b of d.bars.filter(x => x.bar)) {
    const m = new Map();
    for (let i = 0; i < b.bar.prices.length; i++) {
      const price = Math.floor(b.bar.prices[i] / d.rowTicks) * d.rowTicks;
      const v = m.get(price) ?? { price, buy: 0, sell: 0, undirected: 0 };
      v.buy += b.bar.buy[i]; v.sell += b.bar.sell[i]; v.undirected += b.bar.undirected?.[i] ?? 0;
      m.set(price, v);
    }
    assert.deepEqual([...m.values()], b.rows.rows);
    const sum = b.rows.rows.reduce((n, r) => n + r.buy + r.sell + r.undirected, 0);
    assert.equal(sum, b.bar.volume);
  }
}
try {
  for (const symbol of ["NQ", "GC"]) {
    const cases = [
      ["fp5-1", "footprint", 5, 16, 1], ["fp60-1", "footprint", 60, 16, 1],
      ["fp300-1", "footprint", 300, 16, 1], ["fp5-4", "footprint", 5, 3, 4],
      ["fp5-20", "footprint", 5, .6, 20], ["fp5-8000", "footprint", 5, 1e-8, null],
      ["heatmap1600-canvas", "canvas", 1600], ["heatmap8000-canvas", "canvas", 8000],
      ["heatmap1600-webgl", "webgl", 1600], ["heatmap8000-webgl", "webgl", 8000],
    ];
    for (const [name, mode, tf, row, expectedGroup] of cases) {
      const fp = mode === "footprint";
      if (heatOnly && fp) continue;
      const p = await page(symbol, mode, tf, row);
      try {
        const d = await snapshot(p, fp);
        if (fp) {
          assert.equal(d.selectedTimeframe, 5); assert.equal(d.timeframe, tf);
          if (expectedGroup) assert.equal(d.rowTicks, expectedGroup);
          assert.ok(d.rowTicks * d.view.rowH >= 12 - 1e-8);
          assert.ok((d.view.barW - 9) / 2 >= 28 - 1e-8);
          verifyRows(d);
        } else { assert.equal(d.viewport.priceSpanTicks, tf); assert.equal(d.viewport.centerPriceTicks, centers[symbol]); }
        await p.screenshot(`${root}/${symbol}-${name}-full.png`);
        const rect = await p.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(fp ? "#fp-canvas" : "#heatmap")})?.getBoundingClientRect();return r&&{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
        if (!rect) throw Error("canvas_selector_not_found");
        const x = rect.x + rect.width * .43, y = rect.y + rect.height * .4;
        await p.call("Performance.enable");
        const metrics = async () => Object.fromEntries((await p.call("Performance.getMetrics")).metrics.map(x => [x.name, x.value]));
        const before = await metrics();
        const marker = await p.evaluate("(window.__zoomPaint.length=0,performance.now())");
        for (let i = 0; i < 40; i++) {
          const dx = i % 2 ? -4 : 4;
          await p.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await p.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
          await p.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + dx, y, button: "left", buttons: 1 });
          await p.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y, button: "left", buttons: 0, clickCount: 1 });
          await delay(80);
        }
        const after = await metrics(), paint = await p.evaluate("window.__zoomPaint"), final = await snapshot(p, fp);
        const frameProfile = fp ? [] : await p.evaluate(`window.__heatmapFrameStats.filter(f=>f.at>=${marker} && f.depth)`);
        const samples = fp ? paint.filter(f => f.ids.includes("fp-canvas")).map(f => f.ms) : frameProfile.map(f => f.totalMs);
        assert.ok(samples.length >= 20, `too_few_paints ${symbol} ${name} ${samples.length}`);
        const r = { symbol, name, width: 1200, height: 900, dpr: 1, samples: samples.length,
          p50Ms: q(samples, .5), p95Ms: q(samples, .95), maxMs: Math.max(...samples),
          taskCpuMs: (after.TaskDuration - before.TaskDuration) * 1000, heapBytes: after.JSHeapUsedSize,
          layout: fp ? final.layout : null, view: fp ? final.view : final.viewport,
          rowTicks: fp ? final.rowTicks : null, samplesMs: samples, frameProfile,
          rendererText: fp ? null : await p.evaluate("document.querySelector('#debug-panel')?.textContent ?? ''"),
          centers, cachedTrades: fp ? null : final.cachedTrades, cachedColumns: fp ? null : final.cachedColumns, currentPrice: fp ? null : final.currentPrice,
          canvasIds: [...new Set(paint.flatMap(f => f.ids))] };
        results.push(r); console.log(JSON.stringify({ symbol, name, samples: r.samples, p95Ms: r.p95Ms }));
        await fs.writeFile(output, JSON.stringify({ replay, browser: b.info, results, checks }, null, 2));
      } finally { await p.close(); }
    }
  }
  if (!heatOnly) {
  // Actual viewport resize, not a screenshot resize. Same owned browser and replay.
  const mobile = await page("GC", "footprint", 5, 1e-8, 390, 500);
  const d = await snapshot(mobile, true);
  assert.ok(d.layout.plotH < 480);
  assert.ok(d.rowTicks > 200);
  assert.ok(d.rowTicks * d.view.rowH >= 12);
  assert.equal(Math.round(d.layout.plotH / d.view.rowH), 8000);
  checks.mobile = { inner: await mobile.evaluate("[innerWidth,innerHeight]"), layout: d.layout, rowTicks: d.rowTicks, rowH: d.view.rowH };
  await mobile.screenshot(`${root}/GC-mobile-8000-full.png`);
  await mobile.close();
  const p = await page("NQ", "footprint", 5, 3);
  const a = await snapshot(p, true);
  const originX = 250, originY = 250, r = await p.evaluate("(()=>{const r=document.querySelector('#fp-canvas').getBoundingClientRect();return {x:r.x,y:r.y}})()");
  await p.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x + originX, y: r.y + originY });
  await delay(80);
  const cursor = await p.evaluate("window.__footprintDebug.cursor");
  assert.equal(cursor.priceEnd - cursor.price + 1, a.rowTicks);
  checks.cursor = { price: cursor.price, priceEnd: cursor.priceEnd, buy: cursor.buy, sell: cursor.sell, rowTicks: a.rowTicks };
  await p.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x + 220, y: r.y + 260, id: 11 }, { x: r.x + 580, y: r.y + 260, id: 22 }] });
  await p.call("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: r.x + 300, y: r.y + 260, id: 11 }, { x: r.x + 550, y: r.y + 260, id: 22 }] });
  await delay(80);
  const during = await snapshot(p, true);
  await p.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(80);
  const released = await snapshot(p, true);
  checks.pinch = { before: a.view, during: during.view, released: released.view, resetOnRelease: released.view.rowH !== during.view.rowH };
  assert.deepEqual(released.view, during.view, "pinch_release_must_not_double_tap_reset");
  const anchor = (v, x) => v.endSec - ((a.layout.plotW - x) / v.barW) * (v.displayTf ?? 5);
  assert.ok(Math.abs(anchor(a.view, 400) - anchor(during.view, 425)) < .001);
  const other = await b.page(); await other.front(); await delay(200);
  const hidden = await p.evaluate("({hidden:document.hidden,counters:window.__footprintCounters})");
  await delay(5600);
  const hiddenAfter = await p.evaluate("({hidden:document.hidden,counters:window.__footprintCounters})");
  assert.equal(hidden.hidden, true); assert.equal(hiddenAfter.hidden, true);
  assert.equal(hiddenAfter.counters.draws, hidden.counters.draws);
  assert.equal(hiddenAfter.counters.barBuilds, hidden.counters.barBuilds);
  await p.front(); await delay(150);
  checks.hidden = { before: hidden, after: hiddenAfter, restored: await p.evaluate("({hidden:document.hidden,counters:window.__footprintCounters})") };
  await p.close(); await other.close();
  }
} finally {
  checks.browserClose = await b.close();
  checks.peersAfter = (await (await fetch(origin + "/__replay")).json()).peers;
  await fs.writeFile(output, JSON.stringify({ replay, browser: b.info, results, checks }, null, 2));
}
