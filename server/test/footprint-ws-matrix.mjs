import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { browser, delay, waitFor } from "./footprint-cdp.mjs";
const base = "http://127.0.0.1:18780", dir = "data/footprint-completion";
const b = await browser({ headed: true }), out = { dummy: true, cases: [] };
let previous;
try { previous = JSON.parse(await fs.readFile(`${dir}/ws-matrix.json`, "utf8")); } catch {}
const ctl = async p => (await fetch(`${base}/__fixture/${p}`)).json();
try {
  const { started } = await ctl("status");
  for (const symbol of ["NQ", "GC"]) {
    const accepted = previous?.cases.find(x => x.name === `real-Pipeline-Hub-new-front-${symbol}`);
    if (accepted) { out.cases.push({ ...accepted, reused: true }); continue; }
    const p = await b.page(`${base}/__fixture/blank`); await delay(100);
    await p.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await p.evaluate(`sessionStorage.setItem('heatmap.instrument','${symbol}');sessionStorage.setItem('view.footprint.${symbol}',JSON.stringify({endSec:${started},barW:92,rowH:16,centerPrice:${symbol === "GC" ? 27000 : 84000},follow:false}))`);
    await p.call("Page.navigate", { url: `${base}/?view=footprint&debug=1` });
    await waitFor(() => p.evaluate("window.__footprintDebug?.bars.some(x=>x.bar)").catch(() => false));
    await ctl("step"); await ctl("late"); await delay(1500);
    const d = await p.evaluate("__footprintDebug");
    assert.equal(d.state.connection, "connected"); assert.equal(d.state.lastError, "");
    const from = Math.min(...d.bars.map(x => x.startSec)), to = Math.max(...d.bars.map(x => x.startSec)) + d.timeframe;
    const { rows } = await ctl(`data?symbol=${symbol}&from=${from}&to=${to}`);
    let checked = 0;
    for (const { startSec, bar } of d.bars) {
      const part = rows.filter(t => t.tsUs >= startSec * 1e6 && t.tsUs < (startSec + d.timeframe) * 1e6 && t.contract === d.contract);
      assert.equal(bar?.volume ?? 0, part.reduce((n, t) => n + t.size, 0));
      assert.equal(bar?.count ?? 0, part.length); checked++;
    }
    out.cases.push({ name: `real-Pipeline-Hub-new-front-${symbol}`, checked, state: d.state, trades: await p.evaluate("__footprintCounters.trades") });
    await p.screenshot(`${dir}/pipeline-${symbol}.png`); await p.close();
  }
  // The pre-FOOTPRINT app's existing LONG VP, not a mock new view.
  const old = await b.page(`${base}/?fixtureFront=before&view=longvp&debug=1`); await old.front();
  await waitFor(() => old.evaluate("window.__longVpDebug?.view.priceHigh>80000").catch(() => false));
  await delay(500);
  out.cases.push({ name: "old-front-new-server-longvp", debug: await old.evaluate("__longVpDebug"),
    body: await old.evaluate("document.body.innerText") });
  await old.screenshot(`${dir}/old-front-longvp.png`); await old.close();
  const incompatible = await b.page("http://127.0.0.1:18778/?view=footprint&debug=1");
  await incompatible.front();
  await waitFor(() => incompatible.evaluate("window.__footprintDebug?.state.lastError==='invalid_hello'").catch(() => false));
  await delay(250);
  out.cases.push({ name: "new-front-old-server-visible-error", state: await incompatible.evaluate("__footprintDebug.state"),
    body: await incompatible.evaluate("document.body.innerText") });
  await incompatible.screenshot(`${dir}/old-server-incompatible.png`); await incompatible.close();
  out.pipeline = await ctl("status");
  assert.ok(out.pipeline.pipelineReader); assert.ok(out.pipeline.pipelineProof.reads >= 4);
  assert.equal(out.pipeline.pipelineProof.reads, out.pipeline.pipelineProof.closes);
} catch (e) { out.failure = e.stack; throw e; }
finally {
  out.cleanup = await b.close();
  out.final = await ctl("status");
  await fs.writeFile(`${dir}/ws-matrix.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ cases: out.cases.map(x => x.name), pipeline: out.final.pipelineProof, failure: out.failure, cleanup: out.cleanup }));
}
