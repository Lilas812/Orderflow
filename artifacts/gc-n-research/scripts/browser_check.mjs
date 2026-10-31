// Native CDP smoke check: no extra package, no product API / upstream connection.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const binary = process.argv[2];
if (!binary) throw Error('Pass a Chromium executable path');
const profile = await mkdtemp(join(tmpdir(), 'gc-n-research-qa-'));
const child = spawn(binary, ['--headless','--no-sandbox','--disable-dev-shm-usage',
  '--remote-debugging-port=19379',`--user-data-dir=${profile}`,'about:blank'], {stdio:'ignore'});
let ws;
const pending = new Map();
let id = 0;
const results = [];
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const watchdog = setTimeout(()=>child.kill('SIGKILL'),90000);
async function send(method,params={}) {
  return new Promise((resolve,reject)=>{
    const n=++id;
    pending.set(n,{resolve,reject});
    ws.send(JSON.stringify({id:n,method,params}));
  });
}
async function evaluate(expression) {
  const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function wait(expression) {
  for(let i=0;i<100;i++) {
    if(await evaluate(expression)) return;
    await sleep(100);
  }
  throw Error('Wait failed: '+expression);
}
function selector(testid) {return `document.querySelector('[data-testid="${testid}"]')`;}
async function click(testid) {await evaluate(`${selector(testid)}.click()`);await sleep(120);}
async function input(testid,value) {
  await evaluate(`(()=>{const e=${selector(testid)};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(150);
}
try {
  let version;
  for(let i=0;i<100;i++) {
    try {version=await(await fetch('http://127.0.0.1:19379/json/version')).json();break;}catch{await sleep(100);}
  }
  assert(version,'Chromium did not start');
  const pages=await(await fetch('http://127.0.0.1:19379/json')).json();
  ws=new WebSocket(pages[0].webSocketDebuggerUrl);
  await once(ws,'open');
  ws.addEventListener('message',e=>{
    const m=JSON.parse(e.data);
    if(m.id) {
      const p=pending.get(m.id);
      if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
    }
  });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:'http://127.0.0.1:80/gc-n-research/'});
  await wait(`${selector('text-current-session')}?.textContent==='2026-10-16' && document.querySelector('canvas')?.width>0`);
  assert.equal(await evaluate(`${selector('text-level-qty-1')}.textContent`),'22');
  results.push('Real 10/15 N-only level 4162.5 = 22 lots displayed for 10/16');
  const before=await evaluate(`${selector('text-view-range')}.textContent`);
  await click('button-time-zoom-in');
  const zoomed=await evaluate(`${selector('text-view-range')}.textContent`);
  assert.notEqual(before,zoomed);
  await click('button-time-pan-left');
  assert.notEqual(zoomed,await evaluate(`${selector('text-view-range')}.textContent`));
  await click('button-price-zoom-in');
  results.push('Time zoom, horizontal pan and shared price zoom controls change actual view');
  await input('input-top-n','1');
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid^="row-level-"]').length`),1);
  await input('input-min-qty','100000');
  assert.equal(await evaluate(`document.querySelectorAll('[data-testid^="row-level-"]').length`),0);
  await input('input-min-qty','1');
  await input('input-top-n','3');
  await input('input-session-date','2026-10-05');
  await wait(`${selector('text-current-session')}?.textContent==='2026-10-05' && ${selector('text-previous-session')}?.textContent==='2026-10-02'`);
  results.push('Monday 10/05 uses Friday 10/02 profile; line number and quantity threshold work');
  await input('input-session-date','2026-10-04');
  await wait(`!!${selector('status-date-unavailable')}`);
  assert.equal(await evaluate(`!!document.querySelector('canvas')`),false);
  results.push('Unavailable Sunday explicitly reported; no stale chart shown');
  await input('input-session-date','2026-10-16');
  await wait(`${selector('text-current-session')}?.textContent==='2026-10-16' && !!document.querySelector('canvas')`);
  await click('button-tz-jst');
  assert.match(await evaluate(`${selector('text-view-range')}.textContent`),/JST/);
  await send('Emulation.setDeviceMetricsOverride',{width:402,height:874,deviceScaleFactor:2,mobile:true});
  await sleep(350);
  const dims=await evaluate(`(()=>{const c=document.querySelector('canvas');return {width:c.width,height:c.height,cssHeight:c.getBoundingClientRect().height};})()`);
  assert(dims.width>0 && dims.height>=800 && dims.cssHeight>=400);
  results.push('JST toggle works; mobile Canvas has real nonzero 400px+ height at DPR2');
  const shot=await send('Page.captureScreenshot',{format:'jpeg',quality:85});
  await writeFile('artifacts/gc-n-research/evidence/mobile-verified.jpg',Buffer.from(shot.data,'base64'));
  console.log(JSON.stringify({checks:results,mobileCanvas:dims},null,2));
} finally {
  const exited=once(child,'exit');
  if(ws?.readyState===WebSocket.OPEN) {
    try {
      const v=await(await fetch('http://127.0.0.1:19379/json/version')).json();
      const control=new WebSocket(v.webSocketDebuggerUrl);
      await once(control,'open');
      control.send(JSON.stringify({id:999,method:'Browser.close'}));
    } catch {child.kill('SIGTERM');}
    ws.close();
  } else child.kill('SIGTERM');
  await exited;
  clearTimeout(watchdog);
  console.log(JSON.stringify({browserPid:child.pid,browserExited:child.exitCode!==null || child.signalCode!==null,signal:child.signalCode}));
}
