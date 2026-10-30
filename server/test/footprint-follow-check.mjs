import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { browser, delay, waitFor } from "./footprint-cdp.mjs";
const b = await browser({ headed: true }), out = { dummy: true };
try {
  const a = await b.page("http://127.0.0.1:18777/?view=footprint&debug=1");
  await waitFor(() => a.evaluate("window.__footprintCounters?.connection==='connected'").catch(() => false));
  await delay(1200);
  out.before = await a.evaluate("__footprintCounters");
  assert.equal(out.before.view.follow, true);
  const c = await b.page("about:blank"); await c.front();
  await waitFor(() => a.evaluate("document.hidden"));
  const begin = await a.evaluate("__footprintCounters");
  await fetch("http://127.0.0.1:18777/__fixture/step"); await delay(5200);
  out.hidden = await a.evaluate("__footprintCounters");
  assert.equal(out.hidden.draws, begin.draws); assert.equal(out.hidden.barBuilds, begin.barBuilds);
  assert.ok(out.hidden.trades > begin.trades);
  // Reading full debug also must not build bars behind the observer's back.
  await a.evaluate("void window.__footprintDebug;void window.__footprintDebug");
  assert.equal((await a.evaluate("__footprintCounters")).barBuilds, begin.barBuilds);
  await a.front(); await delay(1200);
  out.after = await a.evaluate("__footprintCounters");
  assert.equal(out.after.view.follow, true); assert.ok(out.after.view.endSec > out.before.view.endSec);
  assert.equal(out.after.view.barW, out.before.view.barW); assert.equal(out.after.view.rowH, out.before.view.rowH);
  await a.evaluate("document.querySelector('[data-testid=link-view-heatmap]').click()");
  await waitFor(() => a.evaluate("!!document.querySelector('#heatmap')").catch(() => false));
  await a.evaluate("(()=>{const l=document.querySelector('[data-testid=link-view-footprint]');l.search+='&debug=1';l.click()})()");
  await waitFor(() => a.evaluate("window.__footprintCounters?.connection==='connected'").catch(() => false)); await delay(1200);
  out.navigation = await a.evaluate("__footprintCounters");
  assert.equal(out.navigation.view.follow, true);
  assert.equal(out.navigation.view.barW, out.before.view.barW); assert.equal(out.navigation.view.rowH, out.before.view.rowH);
  await a.close(); await c.close();
} catch (e) { out.failure = e.stack; throw e; }
finally {
  out.cleanup = await b.close();
  out.connections = (await (await fetch("http://127.0.0.1:18777/__fixture/status")).json()).connections;
  await fs.writeFile("data/footprint-completion/follow.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
}
