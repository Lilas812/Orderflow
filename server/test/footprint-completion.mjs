// Remaining acceptance only; requires the dummy fixture on 18777/18778.
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { browser, delay, waitFor } from "./footprint-cdp.mjs";
const dir = "data/footprint-completion";
await fs.mkdir(dir, { recursive: true });
const fixture = async path => (await fetch(`http://127.0.0.1:18777/__fixture/${path}`)).json();
const status = await fixture("reset"), started = status.started;
const b = await browser({ headed: true }), evidence = { dummy: true, started, browser: b.info, cases: [] };
let previous;
try { previous = JSON.parse(await fs.readFile(`${dir}/acceptance.json`, "utf8")); } catch {}
const url = "http://127.0.0.1:18777/?view=footprint&debug=1";
const counters = p => p.evaluate("window.__footprintCounters");
const debug = p => p.evaluate("window.__footprintDebug");
const pixel = p => p.evaluate(`(()=>{const c=document.querySelector('#fp-canvas'),x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let h=2166136261;for(let i=0;i<x.length;i++)h=Math.imul(h^x[i],16777619);return(h>>>0).toString(16)})()`);
async function ready(p) {
  await p.front();
  await waitFor(async () => {
    const d = await debug(p).catch(() => null);
    return d?.state.connection === "connected" && d.bars.some(x => x.bar) && d.requests.some(x => x.state === "done") && !d.requests.some(x => x.state === "pending");
  });
  await delay(1100);
}
async function seed(p, symbol = "NQ", tf = 5) {
  await p.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // Seed on a same-origin document with no app/pagehide save handler.
  await p.call("Page.navigate", { url: "http://127.0.0.1:18777/__fixture/blank" });
  await waitFor(() => p.evaluate("location.pathname==='/__fixture/blank'").catch(() => false));
  await p.evaluate(`sessionStorage.setItem('heatmap.instrument',${JSON.stringify(symbol)});sessionStorage.setItem('footprint.timeframe',${JSON.stringify(String(tf))});sessionStorage.setItem('view.footprint.${symbol}',JSON.stringify({endSec:${started + 5},barW:92,rowH:16,centerPrice:${symbol === "GC" ? 27000 : 84000},follow:false}))`);
  await p.call("Page.navigate", { url }); await ready(p);
}
async function compare(p, symbol) {
  const d = await debug(p), lo = Math.min(...d.bars.map(x => x.startSec)), hi = Math.max(...d.bars.map(x => x.startSec)) + d.timeframe;
  const { rows } = await (await fetch(`http://127.0.0.1:18777/__fixture/data?symbol=${symbol}&from=${lo}&to=${hi}`)).json();
  let checked = 0;
  for (const { startSec, bar } of d.bars) {
    const part = rows.filter(t => t.tsUs >= startSec * 1e6 && t.tsUs < (startSec + d.timeframe) * 1e6 && (t.contract || "UNKNOWN") === d.contract);
    if (!part.length) { assert.equal(bar, null); continue; }
    const total = part.reduce((n, t) => n + t.size, 0), delta = part.reduce((n, t) => n + (t.side === "buy" ? t.size : -t.size), 0);
    assert.equal(bar.volume, total); assert.equal(bar.delta, delta); assert.equal(bar.count, part.length); checked++;
    const base = symbol === "GC" ? 27000 : 84000;
    for (let i = 0; i < bar.prices.length; i++) {
      const price = bar.prices[i]; assert.ok(Math.abs(price - base) <= 3);
      assert.equal(bar.buy[i], part.filter(t => t.price === price && t.side === "buy").reduce((n, t) => n + t.size, 0));
      assert.equal(bar.sell[i], part.filter(t => t.price === price && t.side === "sell").reduce((n, t) => n + t.size, 0));
    }
  }
  return { checked, rows: rows.length, contract: d.contract, quantityMismatches: 0 };
}
try {
  const a = await b.page(); await seed(a);
  const c = await b.page(); await seed(c, "GC", 60);
  const acceptedBackground = previous?.cases.find(x => x.name === "native-background");
  if (acceptedBackground) {
    evidence.cases.push({ ...acceptedBackground, reused: true });
    await fixture("step"); await fixture("step"); await fixture("late");
  } else {
  await a.front(); await delay(1200);
  const before = await counters(a), hashBefore = await pixel(a);
  await a.screenshot(`${dir}/background-before.png`);
  await c.front(); await waitFor(() => a.evaluate("document.hidden"));
  const hiddenBefore = await counters(a);
  await fixture("step"); await fixture("step"); await fixture("late");
  await delay(2300);
  const hiddenAfter = await counters(a);
  assert.equal(hiddenBefore.hidden, true); assert.equal(hiddenAfter.hidden, true);
  assert.equal(hiddenAfter.draws, hiddenBefore.draws); assert.equal(hiddenAfter.barBuilds, hiddenBefore.barBuilds);
  assert.ok(hiddenAfter.trades > hiddenBefore.trades);
  await a.front(); await delay(1300);
  const after = await counters(a), hashAfter = await pixel(a);
  assert.deepEqual(after.view, before.view); assert.ok(after.draws > hiddenAfter.draws);
  assert.notEqual(hashBefore, hashAfter);
  const quantities = await compare(a, "NQ");
  await a.screenshot(`${dir}/background-after.png`);
  evidence.cases.push({ name: "native-background", before, hiddenBefore, hiddenAfter, after, hashBefore, hashAfter, quantities });
  }

  // A document navigation unmounts the old view, rather than CSS-hiding it.
  const acceptedNavigation = previous?.cases.find(x => x.name === "application-navigation");
  if (acceptedNavigation) evidence.cases.push({ ...acceptedNavigation, reused: true });
  else {
  let cleared = 0;
  b.listeners.add(m => { if (m.sessionId === a.sessionId && m.method === "Runtime.executionContextsCleared") cleared++; });
  const saved = (await counters(a)).view;
  await a.evaluate("(()=>{const l=document.querySelector('[data-testid=link-view-heatmap]');l.search='?debug=1';l.click()})()");
  await waitFor(() => a.evaluate("!!window.__heatmapDebug").catch(() => false));
  const heat = await a.evaluate("({connection:window.__heatmapDebug.connection,draw:window.__heatmapDebug.depthDrawCount})");
  const mid = await fixture("status"); await fixture("step"); await fixture("step"); await delay(1200);
  assert.equal(await a.evaluate("typeof window.__footprintCounters"), "undefined");
  assert.ok(cleared > 0);
  const shared = await fixture("status"); assert.equal(shared.liveTrades - mid.liveTrades, 4);
  await a.evaluate("(()=>{const l=document.querySelector('[data-testid=link-view-footprint]');l.search+='&debug=1';l.click()})()"); await ready(a);
  assert.deepEqual((await counters(a)).view, saved);
  evidence.cases.push({ name: "application-navigation", destroyedContexts: cleared, oldFootprintCounterAbsent: true, heat, sharedInputDelta: 4,
    restored: await counters(a), quantities: await compare(a, "NQ") });
  }

  await c.front(); await ready(c);
  const gcBefore = await debug(c);
  await a.evaluate(`sessionStorage.setItem('view.footprint.GC',JSON.stringify({endSec:${started + 5},barW:92,rowH:16,centerPrice:27000,follow:false}))`);
  await a.front(); await fixture("delay?ms=1600");
  await a.call("Page.reload", { ignoreCache: true }); await delay(350);
  await a.evaluate("document.querySelector('[data-testid=instrument-select]').value='GC';document.querySelector('[data-testid=instrument-select]').dispatchEvent(new Event('change',{bubbles:true}))");
  await delay(350); await fixture("delay?ms=0"); await ready(a);
  assert.equal((await debug(a)).contract, "GCZ26"); await compare(a, "GC");
  // Changing A must not change the GC/1m tab's storage or timeframe.
  await c.front(); await delay(1200);
  assert.equal((await debug(c)).timeframe, gcBefore.timeframe);
  assert.equal(await c.evaluate("sessionStorage.getItem('heatmap.instrument')"), "GC");
  await a.front();
  await a.evaluate("document.querySelector('[data-testid=instrument-select]').value='NQ';document.querySelector('[data-testid=instrument-select]').dispatchEvent(new Event('change',{bubbles:true}))");
  await ready(a);
  const reloads = [];
  for (let i = 0; i < 2; i++) {
    await a.call("Page.reload", { ignoreCache: true }); await ready(a);
    const qa = await compare(a, "NQ"); const s = await fixture("status");
    assert.equal(s.connections.reduce((n, x) => n + x.connected, 0), 2);
    reloads.push({ quantity: qa, state: await counters(a), activeConnections: 2 });
  }
  await c.front(); await c.call("Page.reload", { ignoreCache: true }); await ready(c);
  assert.equal((await debug(c)).timeframe, 60); assert.equal((await debug(c)).contract, "GCZ26");
  const end = await fixture("status");
  evidence.cases.push({ name: "tabs-reload-delayed", reloads, gc: await counters(c), gcQuantities: await compare(c, "GC"), receipts: end.receipts });
  await c.screenshot(`${dir}/gc-reload.png`);

  const legacy = await b.page("http://127.0.0.1:18778/?view=footprint&debug=1");
  await legacy.front();
  await waitFor(() => legacy.evaluate("window.__footprintDebug?.state.lastError==='invalid_hello'").catch(() => false));
  evidence.cases.push({ name: "new-front-old-server", state: await debug(legacy),
    message: await legacy.evaluate("document.querySelector('#fp-status').textContent") });
  await legacy.screenshot(`${dir}/old-server-incompatible.png`); await legacy.close();
  await a.close(); await c.close(); await delay(400);
} catch (e) { evidence.failure = e.stack; throw e; }
finally {
  evidence.cleanup = await b.close();
  evidence.finalStatus = await fixture("status");
  await fs.writeFile(`${dir}/acceptance.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ cases: evidence.cases.map(x => x.name), failure: evidence.failure, cleanup: evidence.cleanup,
    connections: evidence.finalStatus.connections.map(x => x.connected) }));
}
