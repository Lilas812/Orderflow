/** Supplemental saved-copy browser checks; does not repeat the 60x600 benchmark. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { browser, waitFor, delay } from "./footprint-cdp.mjs";
const origin = process.env.REPLAY_ORIGIN ?? "http://127.0.0.1:18886";
const dir = "docs/evidence/footprint-replay";
const info = await (await fetch(`${origin}/__replay`)).json();
const result = { checks: [] };
const b = await browser();
const state = "window.__handoff?.states.at(-1)";
try {
  for (const symbol of ["NQ", "GC"]) {
    const p = await b.page();
    await p.call("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      sessionStorage.setItem('heatmap.instrument', '${symbol}');
      const key='replay.shared.v1.${symbol}';
      if(!sessionStorage.getItem('handoff.seed')){
        sessionStorage.setItem('handoff.seed','1');
        sessionStorage.setItem(key, JSON.stringify({symbol:'${symbol}',positionUs:${(info.end-100)*1e6},
          fromSec:${info.end-100},toSec:${info.end},state:'paused',speed:2}));
      }
      window.__handoff={restored:JSON.parse(sessionStorage.getItem(key)),states:[],hello:null};
      const Native=window.WebSocket;
      window.WebSocket=class extends Native {constructor(...args){super(...args);
        this.addEventListener('message',e=>{if(typeof e.data!=='string')return;const m=JSON.parse(e.data);
          if(m.type==='hello')window.__handoff.hello=m;
          if(m.type==='replayState')window.__handoff.states.push(m);});}};
    })()` });
    await p.call("Page.navigate", { url: `${origin}/?view=footprint&debug=1&renderer=canvas` });
    await p.front();
    await waitFor(() => p.evaluate(`${state}?.state==='paused' && window.__footprintDebug?.bars.some(b=>b.bar?.volume>0)`), 20000);
    await p.screenshot(`${dir}/${symbol}-footprint-restored.png`);
    const n = await p.evaluate("window.__footprintDebug.cache.trades");
    await p.evaluate(`(() => { const c=document.querySelector('#fp-canvas');
      const r=c.getBoundingClientRect();c.dispatchEvent(new WheelEvent('wheel',{clientX:r.x+350,clientY:r.y+250,deltaY:2000,bubbles:true,cancelable:true}));
      c.dispatchEvent(new WheelEvent('wheel',{clientX:r.x+350,clientY:r.y+250,deltaY:2000,shiftKey:true,bubbles:true,cancelable:true})); })()`);
    await waitFor(() => p.evaluate("window.__footprintDebug.timeframe>5 && window.__footprintDebug.rowTicks>1"), 10000);
    const grouped = await p.evaluate("({timeframe:window.__footprintDebug.timeframe,rowTicks:window.__footprintDebug.rowTicks,trades:window.__footprintDebug.cache.trades})");
    // Zooming out legitimately loads older visible history; it must not drop already-held rows.
    assert(grouped.trades >= n);
    await p.screenshot(`${dir}/${symbol}-footprint-replay-grouped.png`);
    await p.evaluate("document.querySelector('[data-action=\"play\"]').click()");
    await waitFor(() => p.evaluate(`${state}?.state==='playing'`), 10000);
    const handoffs = [];
    for (const view of ["heatmap", "footprint"]) {
      await p.evaluate(`(() => {const a=document.querySelector('[data-testid="link-view-${view}"]');const u=new URL(a.href);
        u.searchParams.set('debug','1');u.searchParams.set('renderer','canvas');a.href=u;a.click();})()`);
      await waitFor(() => p.evaluate(`${state}?.state==='playing'`), 20000);
      const v = await p.evaluate("({saved:window.__handoff.restored,hello:window.__handoff.hello})");
      assert.equal(v.hello.replayHeadUs, v.saved.positionUs);
      assert.equal(await p.evaluate(`${state}.speed`), 2);
      handoffs.push({ view, positionUs: v.hello.replayHeadUs, state: v.saved.state });
    }
    await p.evaluate("document.querySelector('[data-action=\"live\"]').click()");
    await waitFor(() => p.evaluate("window.__handoff.hello?.mode==='live'"), 15000);
    assert.equal(await p.evaluate(`sessionStorage.getItem('replay.shared.v1.${symbol}')`), null);
    await p.evaluate(`document.querySelector('[data-testid="link-view-heatmap"]').click()`);
    await waitFor(() => p.evaluate("window.__handoff.hello?.mode==='live'"), 20000);
    result.checks.push({ symbol, grouping: { ...grouped, tradesBefore: n }, playingHandoffs: handoffs, liveOnBothScreens: true });
    await p.close();
    await waitFor(async () => (await (await fetch(`${origin}/__replay`)).json()).peers.every(([,n]) => n === 0), 10000);
  }
} finally {
  result.browser = await b.close();
  await delay(100);
  result.browserPidAbsent = await fs.stat(`/proc/${result.browser.pid}`).then(()=>false,()=>true);
  result.peers = (await (await fetch(`${origin}/__replay`)).json()).peers;
  await fs.writeFile(`${dir}/handoff.json`, JSON.stringify(result,null,2)+"\n");
}
console.log(JSON.stringify(result,null,2));
