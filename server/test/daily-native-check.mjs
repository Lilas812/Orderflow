/** Focused native-tab visibility/paint counters, not another whole UI test pass. */
import fs from "node:fs/promises";
import { browser, delay, waitFor } from "./footprint-cdp.mjs";
const root = "http://127.0.0.1:18789", out = "data/latest-indicators";
const b = await browser({ headed: true }), report = {};
const snap = p => p.evaluate(`(()=>{
 const hash=id=>{const c=document.getElementById(id),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
 let h=2166136261;for(let i=0;i<p.length;i+=7)h=Math.imul(h^p[i],16777619);return h>>>0;};
 return {hidden:document.hidden, daily:window.__heatmapDaily, chart:window.__heatmapDebug,
 hashes:{cvd:hash('daily-cvd'),vwap:hash('daily-vwap'),price:hash('trade-overlay')}};})()`);
const frames = p => p.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
const status = async () => (await fetch(`${root}/__dummy/status`)).json();
const call = async q => (await fetch(`${root}/__dummy/${q}`)).json();
try {
  const initial = await status(), total = initial.profiles.find(x => x[0] === "NQ")[1].total;
  await call("delay?ms=1200");
  const nq = await b.page("about:blank", true); await nq.call("Page.navigate", { url: `${root}/?debug=1` }); await nq.front();
  await waitFor(() => nq.evaluate("!!window.__heatmapDebug&&window.__heatmapDebug.connection==='connected'"));
  report.raceBefore = await snap(nq);
  await call("tick?symbol=NQ&price=21003&size=4&side=buy");
  await waitFor(() => nq.evaluate(`window.__heatmapDaily?.total===${total + 4}&&window.__heatmapDebug?.currentPrice===84012`), 20000);
  await frames(nq); report.raceAfter = await snap(nq);
  report.beforeHistoryComplete = report.raceAfter.chart.loadingRanges > 0;
  if (!report.beforeHistoryComplete) throw Error("race_adoption_not_proven_before_history_complete");
  await waitFor(() => nq.evaluate("window.__heatmapDebug.loadingRanges===0"), 25000);
  await call("delay?ms=0");
  // Actual browse/zoom operation, not a debugger mutation.
  await nq.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 250, deltaX: -90, deltaY: -60 });
  await nq.call("Input.dispatchMouseEvent", { type: "mousePressed", x: 300, y: 250, button: "left", buttons: 1, clickCount: 1 });
  await nq.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 420, y: 250, buttons: 1 });
  await nq.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 420, y: 250, button: "left", buttons: 0, clickCount: 1 });
  await frames(nq);
  report.beforeHide = await snap(nq);
  const gc = await b.page("about:blank", true);
  await gc.call("Page.navigate", { url: `${root}/?symbol=GC&debug=1` }); await gc.front();
  await waitFor(() => gc.evaluate("!!document.querySelector('[data-testid=\"instrument-select\"]')"));
  await gc.evaluate(`(()=>{const s=document.querySelector('[data-testid="instrument-select"]'); if(s.value!=='GC'){s.value='GC';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await waitFor(() => gc.evaluate("document.querySelector('[data-testid=\"instrument-select\"]')?.value==='GC'"));
  await waitFor(() => gc.evaluate("window.__heatmapDaily?.available&&window.__heatmapDebug.loadingRanges===0"));
  await frames(gc); await delay(150);
  report.hiddenBefore = await snap(nq); report.gcBefore = await snap(gc);
  if (!report.hiddenBefore.hidden) throw Error("native_tab_not_hidden");
  await call("tick?symbol=NQ&price=21003.25&size=5&side=buy");
  await call("late?symbol=NQ"); await delay(700);
  report.hiddenAfter = await snap(nq); report.gcAfter = await snap(gc);
  report.hiddenDrawsStopped = report.hiddenAfter.daily.metrics.drawCount === report.hiddenBefore.daily.metrics.drawCount
    && report.hiddenAfter.chart.overlayDrawCount === report.hiddenBefore.chart.overlayDrawCount;
  if (!report.hiddenDrawsStopped) throw Error("hidden_draw_count_changed");
  if (report.gcAfter.daily.total !== report.gcBefore.daily.total) throw Error("symbol_mixed");
  await nq.front(); await frames(nq);
  await waitFor(() => nq.evaluate(`window.__heatmapDaily.total===${total + 16}`));
  report.resumed = await snap(nq);
  report.viewportPreserved = JSON.stringify(report.beforeHide.chart.viewport) === JSON.stringify(report.resumed.chart.viewport)
    && report.beforeHide.chart.follow === report.resumed.chart.follow;
  report.pixelChanged = report.hiddenBefore.hashes.cvd !== report.resumed.hashes.cvd;
  if (!report.viewportPreserved || !report.pixelChanged) throw Error("resume_viewport_or_pixels_failed");
  await nq.screenshot(`${out}/native-nq.png`);
  await gc.front(); await frames(gc); await gc.screenshot(`${out}/native-gc.png`);
} catch (e) { report.error = String(e.stack ?? e); }
finally {
  await call("delay?ms=0");
  report.cleanup = await b.close();
  try { process.kill(report.cleanup.pid, 0); report.cleanup.pidAbsent = false; } catch { report.cleanup.pidAbsent = true; }
  await delay(100); report.serverAfter = await status();
  await fs.writeFile(`${out}/native-check.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ error: report.error, beforeHistoryComplete: report.beforeHistoryComplete,
  hiddenDrawsStopped: report.hiddenDrawsStopped, viewportPreserved: report.viewportPreserved,
  pixelChanged: report.pixelChanged, replayFutureExcluded: report.replayFutureExcluded, cleanup: report.cleanup }));
