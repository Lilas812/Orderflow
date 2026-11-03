/** Final targeted checks: nonempty grouped cursor, actual reload, partial VP overlay. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { browser, waitFor, delay } from "./footprint-cdp.mjs";
const origin = "http://127.0.0.1:18885", root = "data/footprint-zoom";
const replay = await (await fetch(origin + "/__replay")).json();
const measured = JSON.parse(await fs.readFile(`${root}/canvas-heatmap-result.json`, "utf8"));
const b = await browser({ headed: true }), checks = [];
const snap = p => p.evaluate("window.__footprintDebug");
async function cursor(p) {
  const d = await snap(p);
  const rect = await p.evaluate("(()=>{const r=document.querySelector('#fp-canvas').getBoundingClientRect();return{x:r.x,y:r.y}})()");
  const match = d.bars.flatMap(b => !b.bar ? [] : b.rows.rows.map(row => ({
    row, bar: b.bar, poc: b.rows.poc,
    x: d.layout.plotW - (d.view.endSec - b.startSec) / d.timeframe * d.view.barW + 6 + (d.view.barW - 9) / 4,
    y: d.layout.plotH / 2 - (row.price + (d.rowTicks - 1) / 2 - d.view.centerPrice) * d.view.rowH,
  }))).find(r => r.x > 10 && r.x < d.layout.plotW - 10 && r.y > 40 && r.y < d.layout.plotH - 20 && r.row.buy + r.row.sell + r.row.undirected > 0);
  assert.ok(match, "visible_nonempty_row");
  await p.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + match.x, y: rect.y + match.y });
  await delay(100);
  const actual = (await snap(p)).cursor;
  assert.deepEqual([actual.price, actual.priceEnd, actual.buy, actual.sell, actual.undirected],
    [match.row.price, match.row.price + d.rowTicks - 1, match.row.buy, match.row.sell, match.row.undirected]);
  return { rowTicks: d.rowTicks, actual, expected: match, info: await p.evaluate("document.querySelector('#fp-info').textContent") };
}
try {
  for (const symbol of ["NQ", "GC"]) {
    const p = await b.page();
    await p.call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    const center = measured.results.find(r => r.symbol === symbol).centers[symbol];
    const { identifier } = await p.call("Page.addScriptToEvaluateOnNewDocument", { source: `
      Date.now=()=>${replay.end * 1000};
      sessionStorage.setItem("heatmap.instrument","${symbol}");
      sessionStorage.setItem("footprint.timeframe","5");
      sessionStorage.setItem("view.footprint.${symbol}",JSON.stringify({endSec:${replay.from + 1800},barW:92,rowH:3,centerPrice:${center},follow:false,displayTf:5}));
      sessionStorage.setItem("view.heatmap.${symbol}",JSON.stringify({follow:false,viewport:{startUs:${(replay.from + 1200) * 1e6},durationSec:600,centerPriceTicks:${center},priceSpanTicks:8000}}));` });
    await p.call("Page.navigate", { url: origin + "/?view=footprint&debug=1" });
    await waitFor(() => p.evaluate("window.__footprintDebug?.bars.some(b=>b.bar)"));
    await delay(1100);
    const four = await cursor(p); assert.equal(four.rowTicks, 4);
    await p.screenshot(`${root}/${symbol}-cursor4-final.png`);
    const rect = await p.evaluate("(()=>{const r=document.querySelector('#fp-canvas').getBoundingClientRect();return{x:r.x+200,y:r.y+300}})()");
    await p.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x, y: rect.y, deltaX: 0, deltaY: -500 * Math.log(.2), modifiers: 8 });
    await delay(100);
    const twenty = await cursor(p); assert.equal(twenty.rowTicks, 20);
    await p.screenshot(`${root}/${symbol}-cursor20-final.png`);
    await p.evaluate("document.querySelector('[data-tf=\"15\"]').click()");
    await p.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.x, y: rect.y, deltaX: 0, deltaY: -500 * Math.log(.05) });
    await delay(200);
    const before = await snap(p);
    assert.equal(before.selectedTimeframe, 15); assert.equal(before.timeframe, 300); assert.equal(before.view.follow, false);
    await p.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await p.call("Page.addScriptToEvaluateOnNewDocument", { source: `Date.now=()=>${replay.end * 1000};` });
    await p.call("Page.reload");
    await waitFor(() => p.evaluate("window.__footprintDebug?.bars.some(b=>b.bar)"));
    await delay(1100);
    const after = await snap(p);
    assert.equal(after.selectedTimeframe, 15); assert.equal(after.timeframe, 300);
    assert.deepEqual(after.view, before.view);
    checks.push({ symbol, four, twenty, reload: { before: before.view, after: after.view, selected: after.selectedTimeframe, effective: after.timeframe } });
    await p.call("Page.navigate", { url: origin + "/?debug=1&renderer=canvas" });
    await waitFor(() => p.evaluate("window.__heatmapDebug?.cachedTrades > 0 && window.__heatmapDebug?.currentPrice !== null && !window.__heatmapDebug?.loadingRanges"));
    await delay(1100);
    const heat = await p.evaluate("window.__heatmapDebug");
    assert.equal(heat.viewport.priceSpanTicks, 8000);
    assert.equal(heat.viewport.centerPriceTicks, center);
    await p.evaluate("document.querySelector('#debug-panel').hidden=true");
    await p.screenshot(`${root}/${symbol}-heatmap8000-overlays-final.png`);
    checks.at(-1).heatmap = heat;
    await p.close();
  }
} finally {
  const close = await b.close();
  const peers = (await (await fetch(origin + "/__replay")).json()).peers;
  await fs.writeFile(`${root}/final-result.json`, JSON.stringify({ checks, close, peers }, null, 2));
}
