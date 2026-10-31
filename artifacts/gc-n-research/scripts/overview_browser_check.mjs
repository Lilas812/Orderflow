// Real Canvas / React checks over native CDP, only the research preview.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { buildOverview } from '../src/lib/overview.ts';

const directory=new URL('../public/research-data/',import.meta.url);
const sessions=await Promise.all((await readdir(directory)).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map(async f=>JSON.parse(await readFile(new URL(f,directory)))));
const config={from:'2026-10-01',to:'2026-10-31',chartMinutes:5,overlay:'visible',
  summary:'visible',summarySession:'2026-10-30',topN:3,minQty:1,bucketTicks:1,
  retention:'all',rule:{reactionTicks:20,windowMinutes:15,toleranceTicks:1}};
const expected=buildOverview(sessions,config);
const first=expected.lines[0];
const checks=[];
const binary=process.argv[2];
if(!binary)throw Error('Pass Chromium executable path');
const profile=await mkdtemp(join(tmpdir(),'gc-month-qa-'));
const browser=spawn(binary,['--headless','--no-sandbox','--disable-dev-shm-usage',
  '--remote-debugging-port=19379',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const watchdog=setTimeout(()=>browser.kill('SIGKILL'),90000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0;
const pending=new Map();
function send(method,params={}){
  return new Promise((resolve,reject)=>{
    const n=++id;pending.set(n,{resolve,reject});
    ws.send(JSON.stringify({id:n,method,params}));
  });
}
async function evaluate(expression){
  const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const el=id=>`document.querySelector('[data-testid="${id}"]')`;
async function wait(expr){
  for(let i=0;i<120;i++){if(await evaluate(expr))return;await sleep(100);}
  throw Error('Wait failed: '+expr);
}
async function click(id){await evaluate(`${el(id)}.click()`);await sleep(180);}
async function input(id,value){
  await evaluate(`(()=>{const e=${el(id)};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(180);
}
async function screenshot(name){
  const shot=await send('Page.captureScreenshot',{format:'jpeg',quality:88});
  await writeFile(`artifacts/gc-n-research/evidence/${name}.jpg`,Buffer.from(shot.data,'base64'));
}
try {
  let version;
  for(let i=0;i<100;i++){try{version=await(await fetch('http://127.0.0.1:19379/json/version')).json();break;}catch{await sleep(100);}}
  assert(version,'Browser did not start');
  const pages=await(await fetch('http://127.0.0.1:19379/json')).json();
  ws=new WebSocket(pages[0].webSocketDebuggerUrl);await once(ws,'open');
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);
    if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1050,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:'http://127.0.0.1:80/gc-n-research/overview'});
  await wait(`${el('canvas-overview')}?.width>0 && document.querySelectorAll('[data-testid^="row-line-"]').length===${expected.lines.length}`);
  assert.equal(await evaluate(`${el('input-from')}.value`),'2026-10-01');
  assert.equal(await evaluate(`${el('input-to')}.value`),'2026-10-31');
  assert.match(await evaluate(`${el('text-chart-view')}.textContent`),/2026-09-30 17:00 CT.*2026-10-31 17:00 CT/);
  await screenshot('month-overview-final');
  checks.push(`Initial October fits entire calendar month; ${expected.lines.length} source-specific extended lines`);

  // Actual mouse hit-test using the chart's documented shared price transform.
  let lo=Math.min(...expected.candles.map(c=>c.lowTicks),...expected.lines.map(l=>l.priceTicks));
  let hi=Math.max(...expected.candles.map(c=>c.highTicks),...expected.lines.map(l=>l.priceTicks+l.bucketTicks-1));
  const pad=Math.max(4,(hi-lo)*.04);lo-=pad;hi+=pad;
  const point=await evaluate(`(()=>{const r=${el('canvas-overview')}.getBoundingClientRect();const pw=Math.min(220,Math.max(90,Math.round(r.width*.16)));return {x:r.x+pw+8+(${first.startMs+7200000}-${expected.timeStartMs})/(${expected.timeEndMs-expected.timeStartMs})*(r.width-64-pw-8),y:r.y+r.height-30-(${first.priceTicks}-(${lo}))/(${hi-lo})*(r.height-30-8)};})()`);
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  await wait(`!!${el('panel-line-details')}`);
  assert.match(await evaluate(`${el('panel-line-details')}.textContent`),new RegExp(first.sourceSession));
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid^="row-event-"]').length`),first.events.length);
  checks.push(`Canvas line click exposes origin, quantity and ${first.events.length} independently matched event rows`);
  await screenshot('month-line-details');

  await click('button-retention-1');
  await click(`row-line-${first.id}`);
  const one=buildOverview(sessions,{...config,retention:1}).lines.find(l=>l.id===first.id);
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid^="row-event-"]').length`),one.events.length);
  await click('button-retention-all');
  await input('input-reaction-ticks','40');
  const revised=buildOverview(sessions,{...config,rule:{...config.rule,reactionTicks:40}}).lines.find(l=>l.id===first.id);
  await click(`row-line-${first.id}`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid^="row-event-"]').length`),revised.events.length);
  checks.push('Retention and reaction-rule edits update real detail events without duplicate windows');
  await input('input-reaction-ticks','20');

  await click('button-preset-5');
  assert.equal(await evaluate(`${el('input-from')}.value`),'2026-10-26');
  assert.equal(await evaluate(`${el('input-to')}.value`),'2026-10-30');
  await click('button-preset-month');
  await click('button-time-zoom-in');
  const zoomed=await evaluate(`${el('text-chart-view')}.textContent`);
  assert(!zoomed.includes('2026-09-30 17:00 CT'));
  await click('button-time-left');
  assert.notEqual(await evaluate(`${el('text-chart-view')}.textContent`),zoomed);
  await click('button-fit');
  checks.push('Five-session preset, full month, time zoom, pan and fit controls operate');

  await input('input-min-qty','100000');
  await wait(`document.querySelectorAll('[data-testid^="row-line-"]').length===0`);
  await input('input-min-qty','1');
  await wait(`document.querySelectorAll('[data-testid^="row-line-"]').length===${expected.lines.length}`);
  await input('input-reaction-ticks','1');
  await wait(`document.body.textContent.includes('反応幅はタッチ許容幅より大きく')`);
  await input('input-reaction-ticks','20');
  checks.push('Threshold filter and invalid rule state are explicit and recoverable');
  assert.match(await evaluate(`document.body.textContent`),/N\/\(A\+B\)/);
  assert.match(await evaluate(`document.body.textContent`),/N\/\(A\+B\+N\)/);
  await click('link-daily');
  await wait(`${el('text-current-session')}?.textContent==='2026-10-16'`);
  assert.equal(await evaluate(`${el('text-level-qty-1')}.textContent`),'22');
  await click('link-overview');
  await wait(`!!${el('canvas-overview')}`);
  checks.push('Both denominators labeled; existing daily view and roundtrip navigation preserved');
  await send('Emulation.setDeviceMetricsOverride',{width:402,height:874,deviceScaleFactor:2,mobile:true});
  await sleep(300);
  assert(await evaluate(`${el('canvas-overview')}.getBoundingClientRect().height>=460`));
  await screenshot('month-mobile');
  checks.push('Mobile DPR2 Canvas retains nonzero 460px+ height');
  const output={checks,month:{lines:expected.lines.length,candles:expected.candles.length,
    touches:expected.lines.reduce((n,l)=>n+l.stats.touches,0)}};
  await writeFile('artifacts/gc-n-research/evidence/month-browser-check.json',JSON.stringify(output,null,2));
  console.log(JSON.stringify(output,null,2));
} finally {
  const exit=once(browser,'exit');
  try {
    const v=await(await fetch('http://127.0.0.1:19379/json/version')).json();
    const control=new WebSocket(v.webSocketDebuggerUrl);await once(control,'open');
    control.send(JSON.stringify({id:999,method:'Browser.close'}));
  }catch{browser.kill('SIGTERM');}
  ws?.close();await exit;clearTimeout(watchdog);
  console.log(JSON.stringify({browserPid:browser.pid,browserExited:true,signal:browser.signalCode}));
}
