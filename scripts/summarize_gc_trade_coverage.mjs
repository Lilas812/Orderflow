import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";
import path from "node:path";
import {covered,sideOf} from "./gc_trade_coverage_metrics.mjs";
const root="data/research-v2/gc-trade-coverage-03",a=JSON.parse(fs.readFileSync(root+"/analysis.json"));
const header=["utc","coverage_seconds","app_count","mbo_count","app_volume","mbo_volume","missing_price_volume","extra_price_volume","app_buy","mbo_buy","app_sell","mbo_sell","mbo_unknown","delta_error"];
const rows=a.hourly.map(h=>[h.utc,h.coverageSeconds,h.app.covered.count,h.reference.covered.count,
  h.app.covered.size,h.reference.covered.size,h.priceCells.missing,h.priceCells.extra,
  h.app.covered.buy,h.reference.covered.buy,h.app.covered.sell,h.reference.covered.sell,
  h.reference.covered.unknown,h.app.covered.buy-h.app.covered.sell-h.reference.covered.buy+h.reference.covered.sell]);
fs.writeFileSync(root+"/hourly.csv",[header,...rows].map(r=>r.join(",")).join("\n")+"\n");
const groups={5:new Map(),60:new Map()},runs=[];
let run;
const r=readline.createInterface({input:fs.createReadStream(root+"/seconds.csv"),crlfDelay:Infinity});
for await(const line of r){
  if(line.startsWith("utc,"))continue;
  const p=line.split(","),sec=Date.parse(p[0])/1000,is=+p[1];
  if(is&&!+p[2]){
    if(!run||run.end!==sec){if(run)runs.push(run);run={start:sec,end:sec,count:0,referenceSize:0};}
    run.end=sec+1;run.count++;run.referenceSize+=+p[5];
  }else if(run){runs.push(run);run=null;}
  for(const width of [5,60]){
    const key=Math.floor(sec/width)*width,g=groups[width].get(key)??{count:0,coverage:0,app:0,ref:0,deltaError:0};
    g.count++;g.coverage+=is;g.app+=+p[4];g.ref+=+p[5];g.deltaError+=+p[13];groups[width].set(key,g);
  }
}
if(run)runs.push(run);
const quant=(v,p)=>{v=[...v].sort((a,b)=>a-b);return v.length?v[Math.ceil(v.length*p)-1]:null;};
const bars={};
for(const width of [5,60]){
  const complete=[...groups[width].values()].filter(g=>g.count===width&&g.coverage===width&&g.ref>0);
  const v=complete.map(g=>Math.abs(g.app-g.ref)),d=complete.map(g=>Math.abs(g.deltaError));
  bars[width]={completeCoveredActiveBars:complete.length,volumeDifferent:complete.filter(g=>g.app!==g.ref).length,
    deltaDifferent:complete.filter(g=>g.deltaError!==0).length,
    volumeAbsoluteError:{p50:quant(v,.5),p95:quant(v,.95),max:Math.max(...v)},
    deltaAbsoluteError:{p50:quant(d,.5),p95:quant(d,.95),max:Math.max(...d)}};
}
const requests=[{day:"2026-11-01",sec:Date.parse("2026-11-01T23:00:01Z")/1000,price:38895},
  {day:"2026-11-02",sec:Date.parse("2026-11-02T14:56:19Z")/1000,price:39746},
  {day:"2026-11-03",sec:Date.parse("2026-11-03T14:26:35Z")/1000,price:39543}];
async function* jsonlines(file,gzip){
  const raw=fs.createReadStream(file),input=gzip?raw.pipe(zlib.createGunzip()):raw;
  const rr=readline.createInterface({input,crlfDelay:Infinity});
  try{for await(const l of rr)if(l)yield JSON.parse(l);}finally{rr.close();input.destroy();raw.destroy();}
}
const inputs=JSON.parse(fs.readFileSync(root+"/trade-inputs.json"));
for(const e of requests){
  const f=inputs.find(f=>f.name.includes(e.day+"/"+new Date(e.sec*1000).toISOString().slice(11,13)+"."));
  e.app=[];e.reference=[];
  for await(const t of jsonlines(f.file,true))if(Math.floor(t.tsUs/1e6)===e.sec&&t.price===e.price)e.app.push(t);
  for await(const t of jsonlines(path.join("data/research-v2/mbo-01/rebuilt/GCZ26",e.day,"mbo-trades.jsonl"),false))
    if(Math.floor(t.tsUs/1e6)===e.sec&&t.price===e.price)e.reference.push(t);
}
const ranges=JSON.parse(fs.readFileSync(root+"/coverage.json")).tick;
const emptyHours=new Set(a.hourly.filter(h=>!h.app.all.count&&h.reference.covered.size)
  .map(h=>Date.parse(h.utc)/1000));
const emptyStrata={size:{},side:{},multiplicity:{}};
let group=[];
function flushEmpty(){
  if(!group.length)return;
  const n=group.length,label=n===1?"1":n<5?"2-4":n<10?"5-9":"10+";
  for(const t of group){
    const sec=Math.floor(t.tsUs/1e6);
    if(!emptyHours.has(Math.floor(sec/3600)*3600)||!covered(ranges,sec))continue;
    const size=t.size===1?"1":t.size<=4?"2-4":t.size<=9?"5-9":t.size<=49?"10-49":"50+";
    for(const [name,k]of [["size",size],["side",sideOf(t.side)],["multiplicity",label]]){
      const v=emptyStrata[name][k]??={count:0,size:0};v.count++;v.size+=t.size;
    }
  }
  group=[];
}
for(const day of [...new Set([...emptyHours].map(h=>new Date(h*1000).toISOString().slice(0,10)))]){
  for await(const t of jsonlines(path.join("data/research-v2/mbo-01/rebuilt/GCZ26",day,"mbo-trades.jsonl"),false)){
    if(group.length&&group[0].tsUs!==t.tsUs)flushEmpty();group.push(t);
  }
  flushEmpty();
}
const outsideEmptyStrata={};
for(const [name,buckets]of Object.entries(a.strata)){
  outsideEmptyStrata[name]={};
  for(const [k,v]of Object.entries(buckets)){
    const e=emptyStrata[name][k]??{count:0,size:0};
    outsideEmptyStrata[name][k]={referenceCount:v.referenceCount-e.count,referenceSize:v.referenceSize-e.size,
      inDeficitCellsCount:v.inDeficitCellsCount-e.count,inDeficitCellsSize:v.inDeficitCellsSize-e.size};
  }
}
const result={bars,outsideEmptyStrata,largestCoveredZeroAppRuns:runs.filter(r=>r.referenceSize).sort((a,b)=>b.referenceSize-a.referenceSize).slice(0,12),examples:requests};
fs.writeFileSync(root+"/supplement.json",JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result));
