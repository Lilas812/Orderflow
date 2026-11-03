import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const browser=spawn(process.argv[2],['--headless','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-port=19381',`--user-data-dir=${await mkdtemp(join(tmpdir(),'gc-render-'))}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,n=0;const pending=new Map();
const timer=setTimeout(()=>browser.kill('SIGKILL'),120000);
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const results=[];
try{
  for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:19381/json/version');break;}catch{await sleep(100);}}
  const pages=await(await fetch('http://127.0.0.1:19381/json')).json();
  ws=new WebSocket(pages[0].webSocketDebuggerUrl);await once(ws,'open');
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  await send('Page.enable');await send('Performance.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:2,mobile:false});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__render={fills:0,resizes:0,byCanvas:{},drawMs:[]};
    const f=CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect=function(...a){window.__render.fills++;const k=this.canvas.dataset.testid||'other';window.__render.byCanvas[k]=(window.__render.byCanvas[k]||0)+1;return f.apply(this,a)};
    const transform=CanvasRenderingContext2D.prototype.setTransform;
    CanvasRenderingContext2D.prototype.setTransform=function(...a){
      const t=performance.now(),stats=window.__render,k=this.canvas.dataset.testid||'other';
      queueMicrotask(()=>stats.drawMs.push({canvas:k,ms:performance.now()-t}));
      return transform.apply(this,a);
    };
    for(const key of ['width','height']){
      const d=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
      Object.defineProperty(HTMLCanvasElement.prototype,key,{...d,set(v){window.__render.resizes++;d.set.call(this,v)}});
    }`});
  for(const [path,id,zoom] of [['overview','canvas-overview','button-time-zoom-in'],['','canvas-research-chart','button-time-zoom-in']]){
    await send('Page.navigate',{url:`http://127.0.0.1:80/gc-n-research/${path}`});
    for(let i=0;i<200;i++){if(await evaluate(`document.querySelector('[data-testid="${id}"]')?.width>0`))break;await sleep(100);}
    await sleep(350);
    const metrics=async()=>Object.fromEntries((await send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    await evaluate(`document.querySelector('[data-testid="${id}"]').scrollIntoView({block:'center'})`);
    await sleep(350);
    const before=await metrics();
    const measured=await evaluate(`(async()=>{
      const cv=document.querySelector('[data-testid="${id}"]');
      const r=cv.getBoundingClientRect(),samples=[];
      window.__render={fills:0,resizes:0,byCanvas:{},drawMs:[]};
      for(let i=0;i<60;i++){
        const t=performance.now();
        for(let j=0;j<8;j++) cv.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:r.x+r.width*.65+j,clientY:r.y+100+i%100}));
        await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);samples.push(performance.now()-t);
      }
      const hover={...window.__render};
      window.__render={fills:0,resizes:0,byCanvas:{},drawMs:[]};
      for(let i=0;i<8;i++){document.querySelector('[data-testid="${zoom}"]').click();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);}
      const zoom={...window.__render};
      samples.sort((a,b)=>a-b);
      const summary=stats=>{
        const values=stats.drawMs.map(x=>x.ms).sort((a,b)=>a-b);
        return {...stats,drawMs:undefined,drawPasses:values.length,drawCpuP95Ms:values[Math.floor(values.length*.95)]};
      };
      return {hover:summary(hover),zoom:summary(zoom),interactionTwoFramesP50:samples[30],interactionTwoFramesP95:samples[57]};
    })()`);
    const after=await metrics();
    console.log(path||'daily',measured);
    if(process.argv[3]==='after'){
      assert.equal(measured.hover.resizes,0);
      assert.equal(measured.zoom.resizes,0);
      assert.equal(measured.hover.byCanvas[id]||0,0,'hover must not repaint the chart');
      assert(measured.hover.fills<=125,'hover should only fill overlay labels');
      assert.equal(measured.hover.drawPasses,60,'480 pointer events coalesce into 60 overlay draws');
      const check=await evaluate(`(async()=>{
        const cv=document.querySelector('[data-testid="${id}"]'),base=cv.toDataURL();
        for(let i=0;i<100;i++)cv.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:400+i,clientY:250}));
        await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
        const same=base===cv.toDataURL();
        return {hoverPreservesBasePixels:same};
      })()`);
      assert(check.hoverPreservesBasePixels);
      measured.checks=check;
      for(const dpr of [1,3,2]){
        await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:dpr,mobile:false});
        await sleep(120);
        assert(await evaluate(`(()=>{const base=document.querySelector('[data-testid="${id}"]'),over=base.nextElementSibling,r=base.getBoundingClientRect();return base.width===Math.round(r.width*${dpr})&&over.width===base.width&&over.height===base.height})()`),'DPR change must resize both layers');
      }
    }
    results.push({path:path||'daily',viewport:'1280x900 DPR2',...measured,cpuTaskMs:(after.TaskDuration-before.TaskDuration)*1000,heapBytes:after.JSHeapUsedSize});
  }
  await writeFile(`artifacts/gc-n-research/evidence/render-${process.argv[3]||'before'}.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
}finally{
  ws?.close();browser.kill('SIGTERM');await once(browser,'exit');clearTimeout(timer);
  console.log('Owned browser exited');
}
