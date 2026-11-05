/** Read-only inputs, bounded one-day reference maps, research output only. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import crypto from "node:crypto";
import {covered,sideOf,empty,add,compareCells} from "./gc_trade_coverage_metrics.mjs";
const root=path.resolve("data/research-v2/gc-trade-coverage-03");
const inputs=JSON.parse(fs.readFileSync(path.join(root,"trade-inputs.json")));
const ranges=JSON.parse(fs.readFileSync(path.join(root,"coverage.json"))).tick;
const copy=JSON.parse(fs.readFileSync(path.join(root,"copy-result.json")));
if(!copy.historicalTickRangesUnchanged)throw Error("unstable_historical_coverage");
const days=[...new Set(inputs.map(r=>r.name.match(/2026-\d\d-\d\d/)[0]))].sort();
async function hash(file){const h=crypto.createHash("sha256");for await(const b of fs.createReadStream(file))h.update(b);return h.digest("hex");}
async function* lines(file,gzip=false){
  const raw=fs.createReadStream(file),input=gzip?raw.pipe(zlib.createGunzip()):raw;
  const reader=readline.createInterface({input,crlfDelay:Infinity});
  let failure;input.on("error",e=>{failure=e;reader.close();});
  try{for await(const l of reader)if(l)yield JSON.parse(l);if(failure)throw failure;}
  finally{reader.close();input.destroy();raw.destroy();}
}
function bucket(){return {all:empty(),covered:empty(),uncovered:empty(),seconds:new Map(),cells:new Map(),dir:new Map()};}
function record(b,t){
  const sec=Math.floor(t.tsUs/1e6),is=covered(ranges,sec);
  add(b.all,t);add(is?b.covered:b.uncovered,t);
  let s=b.seconds.get(sec);if(!s)b.seconds.set(sec,s=empty());add(s,t);
  if(is)for(const [map,key]of [[b.cells,sec+":"+t.price],[b.dir,sec+":"+t.price+":"+sideOf(t.side)]]){
    let v=map.get(key);if(!v)map.set(key,v={count:0,size:0});v.count++;v.size+=t.size;
  }
}
function strip(b){const {seconds,cells,dir,...out}=b;return out;}
const output={copy,scope:"Same 74 UTC hour files as prior comparison; all covered seconds including zero-app-trade seconds",
  hourly:[],daily:[],examples:[],strata:{size:{},side:{},multiplicity:{}},hashes:[],profiles:[]};
const fd=fs.openSync(path.join(root,"seconds.csv"),"wx");
fs.writeSync(fd,"utc,covered,app_count,mbo_count,app_size,mbo_size,app_buy,mbo_buy,app_sell,mbo_sell,app_unknown,mbo_unknown,volume_delta,cvd_delta\n");
try {
for(const day of days){
  const refs=new Map(),files=inputs.filter(r=>r.name.includes(day)),hours=new Set(files.map(r=>Date.parse(day+"T"+path.basename(r.name).slice(0,2)+":00:00Z")/1000));
  const refFile=path.resolve("data/research-v2/mbo-01/rebuilt/GCZ26",day,"mbo-trades.jsonl");
  output.hashes.push({file:refFile,sha256:await hash(refFile)});
  for await(const t of lines(refFile)){
    const hour=Math.floor(t.tsUs/3.6e9)*3600;if(!hours.has(hour))continue;
    let b=refs.get(hour);if(!b)refs.set(hour,b=bucket());record(b,t);
  }
  const apps=new Map();
  for(const f of files){
    if(await hash(f.file)!==f.sha256)throw Error("trade_input_changed");
    output.hashes.push({file:f.file,sha256:f.sha256});
    const hour=Date.parse(day+"T"+path.basename(f.name).slice(0,2)+":00:00Z")/1000,b=bucket();
    for await(const t of lines(f.file,true)){
      if(Math.floor(t.tsUs/3.6e9)*3600!==hour)throw Error("hour_mismatch");
      record(b,t);
    }
    apps.set(hour,b);
  }
  for(const hour of [...hours].sort((a,b)=>a-b)){
    const a=apps.get(hour)??bucket(),b=refs.get(hour)??bucket();
    const row={utc:new Date(hour*1000).toISOString(),coverageSeconds:0,coveredActiveReferenceSeconds:0,
      coveredReferenceButNoAppSeconds:0,coveredReferenceButNoAppSize:0,coveredEqualVolumeSeconds:0,
      coveredDeficitSeconds:0,coveredExtraSeconds:0,app:strip(a),reference:strip(b),
      priceCells:compareCells(a.cells,b.cells),directionCells:compareCells(a.dir,b.dir)};
    for(let sec=hour;sec<hour+3600;sec++){
      const av=a.seconds.get(sec)??empty(),bv=b.seconds.get(sec)??empty(),is=covered(ranges,sec);
      if(is){row.coverageSeconds++;if(bv.count)row.coveredActiveReferenceSeconds++;
        if(bv.count&&!av.count){row.coveredReferenceButNoAppSeconds++;row.coveredReferenceButNoAppSize+=bv.size;}
        if(av.size===bv.size)row.coveredEqualVolumeSeconds++;
        else if(av.size<bv.size)row.coveredDeficitSeconds++;else row.coveredExtraSeconds++;
      }
      fs.writeSync(fd,[new Date(sec*1000).toISOString(),+is,av.count,bv.count,av.size,bv.size,
        av.buy,bv.buy,av.sell,bv.sell,av.unknown,bv.unknown,av.size-bv.size,
        av.buy-av.sell-bv.buy+bv.sell].join(",")+"\n");
    }
    const deficit=[...b.cells].filter(([k,v])=>(a.cells.get(k)?.size??0)<v.size)
      .sort((x,y)=>(y[1].size-(a.cells.get(y[0])?.size??0))-(x[1].size-(a.cells.get(x[0])?.size??0)));
    for(const [k,v]of deficit.slice(0,3)){
      const [sec,price]=k.split(":").map(Number);
      output.examples.push({utc:new Date(sec*1000).toISOString(),price:price/10,covered:true,
        app:a.cells.get(k)??{count:0,size:0},reference:v,missingSize:v.size-(a.cells.get(k)?.size??0)});
    }
    output.hourly.push(row);
  }
  const profiles=[];
  for(const source of [apps,refs]){
    const m=new Map();
    for(const b of source.values())for(const [key,v]of b.cells){
      const price=+key.split(":")[1],s=m.get(price)??{size:0,count:0};
      s.size+=v.size;s.count+=v.count;m.set(price,s);
    }
    profiles.push(m);
  }
  output.profiles.push({day,...compareCells(...profiles)});
  // Second streaming pass: characterize reference records in deficient price cells.
  // This does NOT identify which individual record was dropped when several share a cell.
  let group=[];
  function flush(){
    if(!group.length)return;
    const n=group.length,label=n===1?"1":n<5?"2-4":n<10?"5-9":"10+";
    for(const t of group){
      const sec=Math.floor(t.tsUs/1e6),hour=Math.floor(sec/3600)*3600;if(!hours.has(hour)||!covered(ranges,sec))continue;
      const key=sec+":"+t.price,aa=apps.get(hour)?.cells.get(key)?.size??0,bb=refs.get(hour)?.cells.get(key)?.size??0;
      const deficient=aa<bb,size=t.size===1?"1":t.size<=4?"2-4":t.size<=9?"5-9":t.size<=49?"10-49":"50+";
      for(const [name,k]of [["size",size],["side",sideOf(t.side)],["multiplicity",label]]){
        const s=output.strata[name][k]??= {referenceCount:0,referenceSize:0,inDeficitCellsCount:0,inDeficitCellsSize:0};
        s.referenceCount++;s.referenceSize+=t.size;if(deficient){s.inDeficitCellsCount++;s.inDeficitCellsSize+=t.size;}
      }
    }
    group=[];
  }
  for await(const t of lines(refFile)){if(group.length&&group[0].tsUs!==t.tsUs)flush();group.push(t);}flush();
  console.log(JSON.stringify({day,hours:hours.size}));
}
}finally{fs.closeSync(fd);}
function combine(rows){
  const out={hours:rows.length,coverageSeconds:0,coveredActiveReferenceSeconds:0,coveredReferenceButNoAppSeconds:0,
    coveredReferenceButNoAppSize:0,coveredEqualVolumeSeconds:0,coveredDeficitSeconds:0,coveredExtraSeconds:0,
    app:{all:empty(),covered:empty(),uncovered:empty()},reference:{all:empty(),covered:empty(),uncovered:empty()},
    priceCells:{overlap:0,missing:0,extra:0,countL1:0},directionCells:{overlap:0,missing:0,extra:0,countL1:0}};
  for(const r of rows){
    for(const k of Object.keys(out))if(typeof out[k]==="number"&&k!=="hours")out[k]+=r[k];
    for(const source of ["app","reference"])for(const scope of ["all","covered","uncovered"])
      for(const k of Object.keys(empty()))out[source][scope][k]+=r[source][scope][k];
    for(const type of ["priceCells","directionCells"])for(const k of Object.keys(out[type]))out[type][k]+=r[type][k];
  }
  return out;
}
for(const day of days)output.daily.push({day,...combine(output.hourly.filter(r=>r.utc.startsWith(day)))});
output.total=combine(output.hourly);
output.examples.sort((a,b)=>b.missingSize-a.missingSize);
output.secondsSha256=await hash(path.join(root,"seconds.csv"));
output.resources=process.resourceUsage();
fs.writeFileSync(path.join(root,"analysis.json"),JSON.stringify(output,null,2)+"\n");
console.log(JSON.stringify({complete:true,total:output.total,strata:output.strata,examples:output.examples.slice(0,8),maxRSSKiB:output.resources.maxRSS}));
