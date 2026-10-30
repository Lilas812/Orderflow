import fs from "node:fs/promises";
import { browser, delay, waitFor } from "./footprint-cdp.mjs";
const root = "http://127.0.0.1:18792", b = await browser({ headed: true }), result = {};
try {
  const status = await (await fetch(`${root}/__dummy/status`)).json();
  const from = status.now - 30;
  await fetch(`${root}/__dummy/tick?symbol=NQ&price=21002&size=3&side=buy`);
  const p = await b.page("about:blank", true);
  await p.call("Page.navigate", { url: `${root}/?debug=1&mode=replay&from=${from}&speed=1` }); await p.front();
  await waitFor(() => p.evaluate("window.__heatmapDaily?.available&&window.__heatmapDaily.total===50"), 15000);
  result.before = await p.evaluate("({daily:window.__heatmapDaily,chart:window.__heatmapDebug})");
  await fetch(`${root}/__dummy/tick?symbol=NQ&price=21003&size=7&side=buy`); await delay(400);
  result.after = await p.evaluate("({daily:window.__heatmapDaily,chart:window.__heatmapDebug})");
  result.live = await (await fetch(`${root}/__dummy/status`)).json();
  result.futureExcluded = result.after.daily.total === 50 && result.after.daily.cvd === 30
    && result.after.daily.upToUs < from * 1e6 && result.live.profiles[0][1].total === status.profiles[0][1].total + 10;
  if (!result.futureExcluded) throw Error("future_not_excluded");
  await p.screenshot("data/latest-indicators/replay.png");
  const gc = await b.page("about:blank", true);
  await gc.call("Page.navigate", { url: `${root}/?debug=1` }); await gc.front();
  await waitFor(() => gc.evaluate("!!document.querySelector('[data-testid=\"instrument-select\"]')"));
  await gc.evaluate(`(()=>{const s=document.querySelector('[data-testid="instrument-select"]');s.value='GC';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => gc.evaluate("document.querySelector('[data-testid=\"instrument-select\"]')?.value==='GC'&&window.__heatmapDaily?.available"));
  result.gcBefore = await gc.evaluate("window.__heatmapDaily");
  await fetch(`${root}/__dummy/tick?symbol=GC&price=2700.1&size=2&side=sell`);
  await waitFor(() => gc.evaluate(`window.__heatmapDaily.total===${result.gcBefore.total + 2}&&window.__heatmapDebug.currentPrice===27001`));
  result.gcAfter = await gc.evaluate("({daily:window.__heatmapDaily,chart:window.__heatmapDebug})");
  result.gcLive = result.gcAfter.daily.cvd === result.gcBefore.cvd - 2;
  if (!result.gcLive) throw Error("gc_live_quantity_failed");
  await gc.screenshot("data/latest-indicators/native-gc-live.png");
} catch (e) { result.error = String(e.stack ?? e); }
finally {
  result.cleanup = await b.close();
  try { process.kill(result.cleanup.pid, 0); result.cleanup.pidAbsent = false; } catch { result.cleanup.pidAbsent = true; }
  await delay(100); result.serverAfter = await (await fetch(`${root}/__dummy/status`)).json();
  await fs.writeFile("data/latest-indicators/replay-check.json", JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({error:result.error,futureExcluded:result.futureExcluded,gcLive:result.gcLive,cleanup:result.cleanup}));
