/** Pure report extraction; never opens a browser or connects to the data provider. */
import fs from "node:fs/promises";
const root="data/gpu-heatmap";
const median=(a:number[])=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)]!;
const range=(a:number[],digits=1)=>a.length?`${median(a).toFixed(digits)} [${Math.min(...a).toFixed(digits)}–${Math.max(...a).toFixed(digits)}]`:"—";
const MiB=1024**2, rows:any[]=[];
for(const renderer of ["canvas","webgl"]){
  let runs:any[]=[];try{runs=JSON.parse(await fs.readFile(`${root}/matrix-${renderer}/runs.json`,"utf8"));}catch{}
  for(const run of runs){
    const result=JSON.parse(await fs.readFile(`${run.out}/real-ws.json`,"utf8"))[0];
    rows.push({...run,result});
  }
}
console.log("|経路|銘柄|DPR|回数|Canvas更新p95 ms|受信→命令発行p95 ms|CPU秒/60秒|JS heap MiB¹|RSS合計MiB¹|GLテクスチャ見積MiB|WS KiB|");
console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for(const symbol of ["NQ","GC"])for(const dpr of [1,2,3])for(const renderer of ["canvas","webgl"]){
  const group=rows.filter(x=>x.symbol===symbol&&x.dpr===dpr&&x.renderer===renderer);
  const values=(f:(x:any)=>number)=>group.map(x=>f(x.result)).filter(Number.isFinite);
  console.log(`|${renderer}|${symbol}|${dpr}|${group.length}|${range(values(x=>x.canvasUpdate.p95))}|${range(values(x=>x.receiveToPaint.p95))}|${range(values(x=>x.browserCPUSeconds*60/x.wallSec),2)}|${range(values(x=>Math.max(x.sampledPeakHeap??0,x.after.heap)/MiB))}|${range(values(x=>Math.max(x.browserSampledPeakRSS??0,x.browserRSSAfter??0)/MiB))}|${renderer==="webgl"?range(values(x=>x.after.gpu?.estimatedBytes/MiB)):"—"}|${range(values(x=>x.wsWireBytes/1024))}|`);
}
const intervals=(seconds:number[])=>{
  const result:{from:string;to:string;seconds:number}[]=[];
  for(const s of [...seconds].sort((a,b)=>a-b)){
    const last=result.at(-1);
    if(last&&Date.parse(last.to)/1000===s){last.to=new Date((s+1)*1000).toISOString();last.seconds++;}
    else result.push({from:new Date(s*1000).toISOString(),to:new Date((s+1)*1000).toISOString(),seconds:1});
  }
  return result;
};
const manifest=JSON.parse(await fs.readFile(`${root}/production-input/manifest.json`,"utf8"));
const window=JSON.parse(await fs.readFile(`${root}/production-input/measurement.json`,"utf8"));
const gaps:Record<string,unknown>={};
for(const symbol of ["GC","NQ"]){
  const m=manifest.symbols[symbol],uncovered=new Set<number>(m.uncoveredSeconds);
  gaps[symbol]={physical:intervals(m.missingSeconds),coverage:intervals(m.uncoveredSeconds),
    physicalMissingButCoveragePresent:intervals(m.missingSeconds.filter((s:number)=>!uncovered.has(s))),
    measuredMinuteMissing:m.missingSeconds.filter((s:number)=>s>=manifest.chosen.start+window.offset&&s<manifest.chosen.start+window.offset+60)};
}
await fs.writeFile(`${root}/gaps.json`,JSON.stringify(gaps,null,2));
await fs.writeFile(`${root}/comparison.json`,JSON.stringify(rows.map(x=>({
  renderer:x.renderer,round:x.round,symbol:x.symbol,dpr:x.dpr,code:x.code,
  inputHash:x.inputHash,front:x.front,canvas:x.result.canvasUpdate,
  latency:x.result.receiveToPaint,cpuSeconds:x.result.browserCPUSeconds,wallSec:x.result.wallSec,
  sourceCount:x.result.injected,sourceQuantity:x.result.injectedQuantity,batches:x.result.injectedBatches,
  gpu:x.result.after.gpu,heap:x.result.sampledPeakHeap,rss:x.result.browserSampledPeakRSS,
  wireBytes:x.result.wsWireBytes,browserClosed:x.result.browserClosed,
  serverClosed:x.result.serverClosed,hub:x.result.finalHubStatus
})),null,2));
console.log("\nGAP COUNTS",JSON.stringify(Object.fromEntries(Object.entries(gaps).map(([symbol,m]:[string,any])=>[symbol,{
  intervals:m.physical.length,missing:m.physical.reduce((n:number,v:any)=>n+v.seconds,0),
  measuredMinute:m.measuredMinuteMissing.length,extra:m.physicalMissingButCoveragePresent
}]))));
console.log("\nINPUT/EXIT",JSON.stringify(rows.map(x=>({renderer:x.renderer,round:x.round,symbol:x.symbol,dpr:x.dpr,
  batches:x.result.injectedBatches,trades:x.result.injected,quantity:x.result.injectedQuantity,
  browserClosed:x.result.browserClosed,serverClosed:x.result.serverClosed,hub:x.result.finalHubStatus}))));
