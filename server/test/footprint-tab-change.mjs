import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { browser, delay, waitFor } from "./footprint-cdp.mjs";
const base = "http://127.0.0.1:18781", b = await browser({ headed: true }), out = { dummy: true };
const count = p => p.evaluate("__footprintCounters");
try {
  const a = await b.page(`${base}/?view=footprint&debug=1`);
  await waitFor(() => a.evaluate("window.__footprintCounters?.connection==='connected'").catch(() => false));
  const c = await b.page(`${base}/?view=footprint&debug=1`); await c.front();
  await waitFor(() => c.evaluate("!!window.__footprintCounters").catch(() => false));
  const oldGeneration = (await count(c)).generation;
  await c.evaluate("const s=document.querySelector('[data-testid=instrument-select]');s.value='GC';s.dispatchEvent(new Event('change',{bubbles:true}))");
  // A fixture's current 5s viewport may contain no trades as its tape ages.
  // Verify the new GC connection, not the availability of a current bar.
  await waitFor(() => c.evaluate(`window.__footprintCounters?.connection==='connected'&&__footprintCounters.generation!==${JSON.stringify(oldGeneration)}&&document.querySelector('[data-testid=instrument-select]').value==='GC'`).catch(() => false));
  await c.evaluate("[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='1m').click()");
  await delay(500); out.gcBefore = await count(c);
  assert.equal(out.gcBefore.timeframe, 60);
  await a.front();
  await a.evaluate("[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='15s').click()");
  await delay(500); out.nqChanged = await count(a); assert.equal(out.nqChanged.timeframe, 15);
  out.gcWhileOtherChanged = await count(c); assert.equal(out.gcWhileOtherChanged.timeframe, 60);
  assert.equal(await c.evaluate("sessionStorage.getItem('heatmap.instrument')"), "GC");
  await a.call("Page.reload", { ignoreCache: true });
  await waitFor(() => a.evaluate("window.__footprintCounters?.timeframe===15 && __footprintCounters.connection==='connected'").catch(() => false));
  await delay(900); out.nqReload = await count(a);
  await c.front(); await c.call("Page.reload", { ignoreCache: true });
  await waitFor(() => c.evaluate("window.__footprintCounters?.timeframe===60 && __footprintCounters.connection==='connected'").catch(() => false));
  await delay(900); out.gcReload = await count(c);
  out.storageRaw = [await a.evaluate("sessionStorage.getItem('heatmap.instrument')"), await c.evaluate("sessionStorage.getItem('heatmap.instrument')")];
  out.symbols = [await a.evaluate("document.querySelector('[data-testid=instrument-select]').value"),
    await c.evaluate("document.querySelector('[data-testid=instrument-select]').value")];
  assert.deepEqual(out.symbols, ["NQ", "GC"]);
  out.status = await (await fetch(`${base}/__fixture/status`)).json();
  assert.equal(out.status.connections.reduce((n, x) => n + x.connected, 0), 2);
  await c.screenshot("data/footprint-completion/tab-gc-1m.png");
  await a.close(); await c.close();
} catch (e) { out.failure = e.stack; throw e; }
finally {
  out.cleanup = await b.close();
  out.final = await (await fetch(`${base}/__fixture/status`)).json();
  await fs.writeFile("data/footprint-completion/tab-change.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ failure: out.failure, symbols: out.symbols, tf: [out.nqReload?.timeframe, out.gcReload?.timeframe], connected: out.final.connections.map(x => x.connected), cleanup: out.cleanup }));
}
