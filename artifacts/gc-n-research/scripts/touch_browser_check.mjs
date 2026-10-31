// Real touch input over CDP; no product server or upstream connections.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { buildOverview } from '../src/lib/overview.ts';
const binary=process.argv[2];
if(!binary) throw Error('Pass Chromium executable');
const profile=await mkdtemp(join(tmpdir(),'gc-touch-'));
const browser=spawn(binary,['--headless','--no-sandbox','--disable-dev-shm-usage',
  '--remote-debugging-port=19379',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const watchdog=setTimeout(()=>browser.kill('SIGKILL'),90000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,seq=0;const pending=new Map(),checks=[];
function send(method,params={}){return new Promise((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
});}
async function evaluate(expression){
  const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const el=id=>`document.querySelector('[data-testid="${id}"]')`;
async function wait(expr){for(let i=0;i<160;i++){if(await evaluate(expr))return;await sleep(100);}throw Error(expr);}
async function rect(id){
  await evaluate(`${el(id)}.scrollIntoView({block:'center'})`);await sleep(100);
  return evaluate(`(()=>{const r=${el(id)}.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
}
async function touch(type,points){
  await send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:3,radiusY:3,force:1}))});
  await sleep(60);
}
const range=id=>evaluate(`${el(id)}.textContent`);
const click=id=>evaluate(`${el(id)}.click()`);
async function gesture(id,rangeId){
  const r=await rect(id);
  assert(r.w<=402,'phone chart, including its price axis, must fit the viewport');
  const left=id==='canvas-overview'
    ? Math.max(90,Math.min(220,Math.round(r.w*.16)))+8
    : Math.max(150,Math.min(300,Math.round(r.w*.22)))+8;
  const x=r.x+(left+r.w-64)/2,y=r.y+r.h*.5;
  const before=await range(rangeId);
  await touch('touchStart',[[1,x,y-40],[2,x,y+40]]);
  await touch('touchMove',[[1,x,y-90],[2,x,y+90]]);
  const zoom=await range(rangeId);
  assert.notEqual(zoom,before,'pinch must change actual rendered range');
  if(rangeId==='text-chart-view'){
    const span=text=>{const dates=text.match(/\d{4}-\d\d-\d\d \d\d:\d\d/g);return Date.parse(dates[1].replace(' ','T')+'Z')-Date.parse(dates[0].replace(' ','T')+'Z');};
    assert(span(zoom)<span(before)*.5,'spreading fingers must actually reduce the time span');
  }else{
    const density=text=>Number(text.match(/([\d.]+)px\/分/)[1]);
    assert(density(zoom)>density(before),'daily candle scale must increase');
  }
  // Release finger 2, keep finger 1: no jump, then single-finger pan.
  // CDP touchEnd lists the points being released, not the remaining points.
  await touch('touchEnd',[[2,x,y+90]]);
  assert.equal(await range(rangeId),zoom,'2→1 must not jump');
  await touch('touchMove',[[1,x-12,y-75]]);
  const panned=await range(rangeId);
  if(panned===zoom)console.log('Native event trace',await evaluate('window.__touchTrace'));
  assert.notEqual(panned,zoom,'remaining finger pans');
  await touch('touchCancel',[]);
  const cancelled=await range(rangeId);
  await touch('touchStart',[[3,x,y]]);
  await touch('touchEnd',[]);
  assert.equal(await range(rangeId),cancelled,'cancel leaves no stale gesture');
  await touch('touchStart',[[4,x,y-90],[5,x,y+90]]);
  await touch('touchMove',[[4,x,y-40],[5,x,y+40]]);
  assert.notEqual(await range(rangeId),cancelled,'closing fingers zooms back out');
  await touch('touchEnd',[]);
  checks.push(`${id}: native pinch in/out, 2→1 pan, cancel, fresh tap`);
}
try{
  let ready=false;
  for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:19379/json/version');ready=true;break;}catch{await sleep(100);}}
  assert(ready);
  const pages=await(await fetch('http://127.0.0.1:19379/json')).json();
  ws=new WebSocket(pages[0].webSocketDebuggerUrl);await once(ws,'open');
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:402,height:874,deviceScaleFactor:2,mobile:true});
  await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"window.__touchTrace=[];for(const t of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])document.addEventListener(t,e=>window.__touchTrace.push({type:e.type,id:e.pointerId,x:e.clientX,y:e.clientY}),true);"});
  await send('Page.navigate',{url:'http://127.0.0.1:80/gc-n-research/overview'});
  await wait(`${el('canvas-overview')}?.width>0`);
  await gesture('canvas-overview','text-chart-view');
  assert.equal(await evaluate(`!!${el('panel-line-details')}`),false,'pinch does not select a line');
  await click('button-fit');await sleep(100);
  const r=await rect('canvas-overview');
  const dir=new URL('../public/research-data/',import.meta.url);
  const sessions=await Promise.all((await readdir(dir)).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(async f=>JSON.parse(await readFile(new URL(f,dir)))));
  const m=buildOverview(sessions,{from:'2026-10-01',to:'2026-10-31',chartMinutes:5,overlay:'visible',summary:'visible',
    summarySession:'2026-10-30',topN:3,minQty:1,bucketTicks:1,retention:'all',rule:{reactionTicks:20,windowMinutes:15,toleranceTicks:1}});
  const prices=m.candles.flatMap(c=>[c.lowTicks,c.highTicks]).concat(m.lines.map(l=>l.priceTicks));
  const lo=Math.min(...prices),hi=Math.max(...prices),pad=Math.max(4,(hi-lo)*.04);
  const x0=Math.max(90,Math.min(220,Math.round(r.w*.16)))+8;
  const x=r.x+x0+(r.w-64-x0)*.2;
  const y=r.y+r.h-30-(m.lines[0].priceTicks-(lo-pad))/(hi-lo+pad*2)*(r.h-38);
  await touch('touchStart',[[7,x,y]]);await touch('touchEnd',[]);
  await wait(`!!${el('panel-line-details')}`);
  checks.push('One-finger line tap opens source details after a pinch/cancel sequence');
  await click('button-fit');
  const initial=await range('text-chart-view');
  await click('button-time-zoom-in');await sleep(100);
  assert.notEqual(await range('text-chart-view'),initial);
  checks.push('Existing zoom button still works');
  await rect('canvas-overview');
  const shot=await send('Page.captureScreenshot',{format:'jpeg',quality:88});
  await writeFile('artifacts/gc-n-research/evidence/touch-mobile.jpg',Buffer.from(shot.data,'base64'));
  await click('link-daily');
  await wait(`${el('canvas-research-chart')}?.width>0 && !${el('text-view-range')}?.textContent.includes('—')`);
  await gesture('canvas-research-chart','text-view-range');
  console.log(JSON.stringify({viewport:'402×874 DPR2',checks},null,2));
  await writeFile('artifacts/gc-n-research/evidence/touch-browser-check.json',JSON.stringify({viewport:'402×874 DPR2',checks},null,2));
}finally{
  const exit=once(browser,'exit');
  try{
    const v=await(await fetch('http://127.0.0.1:19379/json/version')).json();
    const control=new WebSocket(v.webSocketDebuggerUrl);await once(control,'open');
    control.send(JSON.stringify({id:999,method:'Browser.close'}));
  }catch{browser.kill('SIGTERM');}
  ws?.close();await exit;clearTimeout(watchdog);
  console.log(JSON.stringify({browserPid:browser.pid,browserExited:true}));
}
