/** Real saved-copy handlers + actual Canvas, never upstream/cloud/settings I/O. */
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { browser, waitFor, delay } from "./footprint-cdp.mjs";
import WebSocket from "ws";
const origin = "http://127.0.0.1:18885", dir = "data/replay-ui";
await fs.mkdir(dir,{recursive:true});
const initial = await (await fetch(origin+"/__replay")).json();
assert(initial.peers.every(([,n])=>n===0),"another verification client is still connected");
const results = { input:initial, conditions:[], wireChecks:{}, cleanup:{} };
const q95 = a => a.length ? a.slice().sort((x,y)=>x-y)[Math.ceil(a.length*.95)-1] : null;
const wsOpen = async symbol => {
  const s = new WebSocket(`ws://127.0.0.1:18885/api/ws?mode=replay&controls=1&paused=1&speed=60&from=${initial.from}&symbol=${symbol}`);
  const messages=[];s.on("message",(d,b)=>{if(!b)messages.push(JSON.parse(d));});
  await new Promise((r,j)=>{s.once("open",r);s.once("error",j);});
  return {s,messages};
};
const peers=[];
if (process.argv.includes("--reuse-wire-checks")) results.wireChecks=JSON.parse(await fs.readFile(`${dir}/measurement.json`,"utf8")).wireChecks;
else {
try {
  const a=await wsOpen("NQ");peers.push(a.s);
  const b=await wsOpen("GC");peers.push(b.s);
  await waitFor(()=>a.messages.some(v=>v.state==="paused")&&b.messages.some(v=>v.state==="paused"));
  const third=await wsOpen("NQ");peers.push(third.s);
  await waitFor(()=>third.messages.some(v=>v.code==="replay_limit"));
  results.wireChecks.globalThirdRejected=third.messages.find(v=>v.code==="replay_limit");
  const count=a.messages.length;await delay(400);
  assert.equal(a.messages.length,count);results.wireChecks.pausedAutomaticMessages=0;
} finally {for(const s of peers)s.close();await waitFor(async()=>{const v=await(await fetch(origin+"/__replay")).json();return v.peers.every(([,n])=>n===0);});}
}
const b=await browser();
try {
  for(const symbol of ["NQ","GC"]){
    const p=await b.page();
    await p.call("Page.addScriptToEvaluateOnNewDocument",{source:`{
      sessionStorage.setItem("heatmap.instrument",${JSON.stringify(symbol)});
      const Original=WebSocket;
      window.__replayEvidence={states:[],trades:[],errors:[],generations:[],head:0,receivedBytes:0};
      window.WebSocket=class extends Original{constructor(...args){super(...args);window.__replayEvidenceSocket=this;
        this.addEventListener("message",e=>{
          if(this!==window.__replayEvidenceSocket)return;
          const d=window.__replayEvidence;
          if(typeof e.data==="string"){d.receivedBytes+=new TextEncoder().encode(e.data).length;const v=JSON.parse(e.data);
            if(v.type==="hello")d.hello=v;
            if(v.type==="hello"&&v.replayControlled){d.generations.push(v.replayGeneration);d.trades=[];d.states=[];}
            if(v.type==="replayState")d.states.push(v);
            if(v.type==="trades"&&v.replayGeneration)d.trades.push(...v.trades);
            if(v.type==="error")d.errors.push(v);
          }else if(e.data instanceof ArrayBuffer)d.receivedBytes+=e.data.byteLength;
        });
      }};
    }`});
    await p.call("Page.navigate",{url:`${origin}/?symbol=${symbol}&renderer=canvas&debug=1`});
    await p.front();
    await waitFor(()=>p.evaluate("!!window.__heatmapDebug && !!window.__replayEvidence.hello?.savedRange && !!document.querySelector('[aria-label=\"リプレイ\"]')"),30000);
    const start=initial.end-600, jst=new Date((start+9*3600)*1000).toISOString().slice(0,19);
    await p.evaluate(`document.querySelector('[aria-label="リプレイ"]').click();document.querySelector('[aria-label="リプレイ日時"]').value=${JSON.stringify(jst)};document.querySelector('.replay-bar form').requestSubmit()`);
    await waitFor(()=>p.evaluate("window.__replayEvidence.states.at(-1)?.state==='paused'"),30000);
    await p.screenshot(`${dir}/${symbol}-selected.png`);
    if (symbol==="GC" && !process.argv.includes("--reuse-ui-checks")) {
      const state=()=>p.evaluate("window.__replayEvidence.states.at(-1)");
      const before=(await state()).positionUs;
      await p.evaluate("document.querySelector('[aria-label=\"リプレイ速度\"]').value='2';document.querySelector('[aria-label=\"リプレイ速度\"]').dispatchEvent(new Event('change'));document.querySelector('[data-action=\"play\"]').click()");
      await waitFor(async()=>(await state()).state==="playing");await delay(900);
      await p.screenshot(`${dir}/GC-normal-playing.png`);
      await p.evaluate("document.querySelector('[data-action=\"play\"]').click()");
      await waitFor(async()=>(await state()).state==="paused");
      assert((await state()).positionUs>before);
      await p.screenshot(`${dir}/GC-paused.png`);
      const exactSteps=[];
      for(const seconds of [1,10,60]){
        const fromHead=(await state()).positionUs;
        await p.evaluate(`document.querySelector('[aria-label="コマ送り幅"]').value='${seconds}';document.querySelector('[aria-label="コマ送り幅"]').dispatchEvent(new Event('change'));document.querySelector('[data-action="step"]').click()`);
        await waitFor(async()=>(await state()).positionUs===fromHead+seconds*1e6);
        exactSteps.push({seconds,fromHead,toHead:(await state()).positionUs});
        await p.screenshot(`${dir}/GC-step-${seconds}.png`);
      }
      const frozen=(await state()).positionUs;
      for(const n of [1,2,5,10,30,60]){
        await p.evaluate(`document.querySelector('[aria-label="リプレイ速度"]').value='${n}';document.querySelector('[aria-label="リプレイ速度"]').dispatchEvent(new Event('change'))`);
        await waitFor(async()=>(await state()).speed===n);assert.equal((await state()).positionUs,frozen);
      }
      const seek=async(sec,name)=>{
        const old=(await state()).replayGeneration,value=new Date((sec+9*3600)*1000).toISOString().slice(0,19);
        await p.evaluate(`document.querySelector('[aria-label="リプレイ日時"]').value=${JSON.stringify(value)};document.querySelector('.replay-bar form').requestSubmit()`);
        await waitFor(async()=>{const s=await state();return s.replayGeneration>old&&s.state==="paused";});
        assert.equal((await state()).positionUs,sec*1e6);await p.screenshot(`${dir}/GC-${name}.png`);
      };
      await seek(start+180,"forward");await seek(start,"backward");
      const old=(await state()).replayGeneration;
      await p.evaluate("document.querySelector('[data-action=\"pick\"]').click()");
      const point=await p.evaluate(`(()=>{const c=document.querySelector('#heatmap'),r=c.getBoundingClientRect(),v=window.__heatmapDebug.viewport;return{x:r.left+((${start+.1}*1e6-v.startUs)/(v.durationSec*1e6))*r.width,y:r.top+r.height*.5}})()`);
      await p.call("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});
      assert.equal(await p.evaluate("document.querySelector('.replay-pick-line').hidden"),false);
      await p.screenshot(`${dir}/GC-pick-marker.png`);
      await p.call("Input.dispatchMouseEvent",{type:"mousePressed",x:point.x,y:point.y,button:"left",clickCount:1});
      await p.call("Input.dispatchMouseEvent",{type:"mouseReleased",x:point.x,y:point.y,button:"left",clickCount:1});
      await waitFor(async()=>{const s=await state();return s.replayGeneration>old&&s.state==="paused";});
      assert.equal(await p.evaluate("document.querySelector('.replay-pick-line').hidden&&!document.querySelector('#heatmap').classList.contains('replay-selecting')"),true);
      assert.equal((await state()).positionUs,start*1e6);
      results.wireChecks.gcJourney={exactSteps,allSpeedsFrozen:true,backwardForwardSeek:true,pointerSeekNewGeneration:true,oldMarkerHidden:true};
      await p.screenshot(`${dir}/GC-pointer-jump.png`);
    }
    await p.evaluate("document.querySelector('[aria-label=\"リプレイ速度\"]').value='60';document.querySelector('[aria-label=\"リプレイ速度\"]').dispatchEvent(new Event('change'))");
    await delay(100);
    const warmFrames=await p.evaluate("window.__heatmapFrameStats.length"), beforeBytes=await p.evaluate("window.__replayEvidence.receivedBytes");
    await fetch(origin+"/__replay?reset=1");
    const at=Date.now();
    await p.evaluate("document.querySelector('[data-action=\"play\"]').click()");
    await waitFor(()=>p.evaluate("window.__replayEvidence.states.at(-1)?.state==='playing'"),15000);
    await p.screenshot(`${dir}/${symbol}-playing.png`);
    await waitFor(()=>p.evaluate("window.__replayEvidence.states.at(-1)?.state==='ended'"),45000);
    const wallMs=Date.now()-at;
    await delay(100);
    const metrics=(await(await fetch(origin+"/__replay")).json()).metrics;
    assert(metrics.txWireBytes>0,"compressed socket byte counter must be nonzero");
    const evidence=await p.evaluate(`({
      frames:window.__heatmapFrameStats.slice(${warmFrames}),
      receivedBytes:window.__replayEvidence.receivedBytes-${beforeBytes},
      state:window.__replayEvidence.states.at(-1),
      count:window.__replayEvidence.trades.length,
      quantity:window.__replayEvidence.trades.reduce((n,t)=>n+t.size,0),
      trades:window.__replayEvidence.trades,
      errors:window.__replayEvidence.errors,
      debug:{replayHeadUs:window.__heatmapDebug.replayHeadUs,follow:window.__heatmapDebug.follow,
        latestTimeUs:window.__heatmapDebug.latestTimeUs}
    })`);
    assert.equal(evidence.state.positionUs,initial.end*1e6);assert.equal(evidence.state.state,"ended");assert.equal(evidence.errors.length,0);
    evidence.hash=createHash("sha256").update(evidence.trades.map(t=>JSON.stringify(t)).sort().join("\n")).digest("hex");
    delete evidence.trades;
    const expected=initial.symbols.find(s=>s.symbol===symbol).last600;
    assert.equal(evidence.count,expected.count);assert.equal(evidence.quantity,expected.quantity);assert.equal(evidence.hash,expected.hash);
    await p.screenshot(`${dir}/${symbol}-end.png`);
    results.conditions.push({symbol,fromSec:start,toSec:initial.end,virtualSeconds:600,speed:60,
      viewport:{width:1280,height:800,dpr:1},renderer:"canvas",wallMs,metrics,
      canvas:{frames:evidence.frames.length,depthFrames:evidence.frames.filter(f=>f.depth).length,
        p95Ms:q95(evidence.frames.filter(f=>f.depth).map(f=>f.totalMs)),allLayersP95Ms:q95(evidence.frames.map(f=>f.totalMs)),
        maxMs:Math.max(...evidence.frames.map(f=>f.totalMs))},
      evidence});
    if(symbol==="GC"){
      const generation=await p.evaluate("window.__replayEvidence.states.at(-1).replayGeneration");
      await p.evaluate(`document.querySelector('[aria-label="リプレイ日時"]').value=${JSON.stringify(jst)};document.querySelector('.replay-bar form').requestSubmit()`);
      await waitFor(()=>p.evaluate(`window.__replayEvidence.states.at(-1)?.replayGeneration>${generation}&&window.__replayEvidence.states.at(-1)?.state==='paused'`));
      assert.equal(await p.evaluate("document.querySelector('#market-state')?.textContent?.includes('ENDED')??document.querySelector('.market-state')?.textContent?.includes('ENDED')"),false);
      results.wireChecks.seekAfterEnd=true;await p.screenshot(`${dir}/GC-seek-after-end.png`);
    }
    await p.evaluate("document.querySelector('[data-action=\"live\"]').click()");
    await waitFor(()=>p.evaluate("document.querySelector('.replay-bar').hidden"),15000);
    await p.screenshot(`${dir}/${symbol}-live.png`);
    await p.close();
    await waitFor(async()=>{const v=await(await fetch(origin+"/__replay")).json();return v.peers.every(([,n])=>n===0);});
  }
} finally {
  results.cleanup.browser=await b.close();
  results.cleanup.osPidAbsent=!await fs.stat(`/proc/${results.cleanup.browser.pid}`).then(()=>true,()=>false);
  results.cleanup.peers=(await(await fetch(origin+"/__replay")).json()).peers;
  await fs.writeFile(`${dir}/measurement.json`,JSON.stringify(results,null,2));
}
console.log(JSON.stringify({conditions:results.conditions.map(({evidence,...c})=>({...c,count:evidence.count,quantity:evidence.quantity})),cleanup:results.cleanup},null,2));
