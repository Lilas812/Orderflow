/** Local-only streaming aggregation of generation-pinned application copies and MBO output. */
import fs from "node:fs";
import path from "node:path";
import {createGunzip} from "node:zlib";
import {createHash} from "node:crypto";
import {createInterface} from "node:readline";
import {paired,searchLag,frequency} from "./gc_alignment_metrics.mjs";

const root=path.resolve("data/research-v2/gc-alignment-02");
const manifest=JSON.parse(fs.readFileSync(path.join(root,"inputs.json")));
const start=Date.parse("2026-10-29")/1000,end=Date.parse("2026-11-04")/1000,len=end-start;
const AB=new Int32Array(len),AA=new Int32Array(len),MB=new Int32Array(len),MA=new Int32Array(len);
const source=new Uint8Array(len),appMid=new Float64Array(len),refMid=new Float64Array(len);
const hashes=[],hist={};
const histogram=(name,v)=>{hist[name]??={};hist[name][v]=(hist[name][v]??0)+1;};
async function hash(file) {
  const h=createHash("sha256");for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest("hex");
}
async function columns(file,fn) {
  const raw=fs.createReadStream(file),stream=raw.pipe(createGunzip());raw.on("error",e=>stream.destroy(e));
  let buffer=Buffer.alloc(0),previous=-1;
  try {
    for await(const chunk of stream) {
      buffer=buffer.length?Buffer.concat([buffer,chunk]):chunk;
      let p=0;
      while(buffer.length-p>=9) {
        const ts=buffer.readUInt32LE(p),s=buffer[p+4],nb=buffer.readUInt16LE(p+5),na=buffer.readUInt16LE(p+7);
        const bytes=9+8*(nb+na);if(buffer.length-p<bytes)break;
        if(ts<=previous||s>1)throw Error("invalid_column_order_or_source");previous=ts;
        if(nb&&na)fn(ts,buffer.readInt32LE(p+9),buffer.readInt32LE(p+9+nb*8),s,buffer.subarray(p,p+bytes),nb,na);
        p+=bytes;
      }
      buffer=buffer.subarray(p);
    }
    if(buffer.length)throw Error("truncated_column");
  }finally{raw.destroy();stream.destroy();}
}
for(const r of manifest.filter(r=>r.name.includes("/columns/"))) {
  if(await hash(r.file)!==r.sha256)throw Error("app_input_hash_changed");
  hashes.push({file:r.file,sha256:r.sha256,generation:r.generation});
  await columns(r.file,(t,b,a,s,bytes,nb,na)=>{
    const i=t-start;if(i<0||i>=len)throw Error("app_out_of_range");if(AB[i])throw Error("duplicate_second");
    AB[i]=b;AA[i]=a;source[i]=s+1;
    histogram("appBidSize",bytes.readUInt32LE(13));histogram("appAskSize",bytes.readUInt32LE(13+nb*8));
  });
}
const days=[...new Set(manifest.filter(r=>r.name.includes("/columns/")).map(r=>r.name.match(/2026-\d\d-\d\d/)[0]))].sort();
for(const day of days) {
  const base=path.resolve("data/research-v2/mbo-01/rebuilt/GCZ26",day);
  if(!fs.existsSync(base))throw Error("missing_mbo_day");
  for(const file of fs.readdirSync(base).filter(x=>x.endsWith(".bin.gz")).sort()) {
    const full=path.join(base,file);
    hashes.push({file:path.relative(process.cwd(),full),sha256:await hash(full)});
    await columns(full,(t,b,a)=>{const i=t-start;if(i>=0&&i<len){MB[i]=b;MA[i]=a;}});
  }
  console.log(JSON.stringify({loaded:day}));
}
for(let i=0;i<len;i++){if(AB[i])appMid[i]=(AB[i]+AA[i])/2;if(MB[i])refMid[i]=(MB[i]+MA[i])/2;}
const table=[],byDay={},all=[],bySource={};
const newRow=()=>({appSeconds:0,referenceSeconds:0,pairs:0,bidMatches:0,askMatches:0,bothMatches:0,
  swappedBothMatches:0,swappedAbsoluteDifference:0,normalAbsoluteDifference:0,appSpread:0,referenceSpread:0});
function add(r,i) {
  r.appSeconds+=AB[i]?1:0;r.referenceSeconds+=MB[i]?1:0;
  if(!AB[i]||!MB[i])return;
  r.pairs++;r.bidMatches+=AB[i]===MB[i]?1:0;r.askMatches+=AA[i]===MA[i]?1:0;
  r.bothMatches+=(AB[i]===MB[i]&&AA[i]===MA[i])?1:0;
  r.swappedBothMatches+=(AB[i]===MA[i]&&AA[i]===MB[i])?1:0;
  r.normalAbsoluteDifference+=Math.abs(AB[i]-MB[i])+Math.abs(AA[i]-MA[i]);
  r.swappedAbsoluteDifference+=Math.abs(AB[i]-MA[i])+Math.abs(AA[i]-MB[i]);
  r.appSpread+=AA[i]-AB[i];r.referenceSpread+=MA[i]-MB[i];
}
for(let h=start;h<end;h+=3600) {
  const label=new Date(h*1000).toISOString(),d=label.slice(0,10),indices=[],common=[];
  const r={utcHour:label,...newRow()};const daily=byDay[d]??={...newRow(),indices:[]};
  for(let i=h-start;i<h-start+3600;i++) {
    add(r,i);add(daily,i);
    if(AB[i]){indices.push(i);daily.indices.push(i);all.push(i);}
    if(AB[i]&&MB[i]) {
      common.push(i);const s=source[i]===1?"live":"history";bySource[s]??=newRow();add(bySource[s],i);
      histogram("bidOffsetTicks",AB[i]-MB[i]);histogram("askOffsetTicks",AA[i]-MA[i]);
      if(AB[i]-MB[i]===AA[i]-MA[i])histogram("jointOffsetTicks",AB[i]-MB[i]);
      histogram("midOffsetHalfTicks",(AB[i]+AA[i])-(MB[i]+MA[i]));
      histogram("appSpread",AA[i]-AB[i]);histogram("referenceSpread",MA[i]-MB[i]);
    }
  }
  if(r.appSeconds) {
    r.appFrequency=frequency(AB,AA,common);r.referenceFrequencySameSeconds=frequency(MB,MA,common);
    r.midpoint=paired(appMid,refMid,indices,0);table.push(r);
  }
}
for(const [day,row]of Object.entries(byDay)) {
  if(!row.appSeconds){delete byDay[day];continue;}
  row.lag=searchLag(appMid,refMid,row.indices);delete row.indices;
  console.log(JSON.stringify({day,pairs:row.pairs,both:row.bothMatches,bestLag:row.lag.best?.shift}));
}
const lag=searchLag(appMid,refMid,all);
const common=all.filter(i=>MB[i]);
const result={scope:"GC/GCZ26; app files lack board contract identity",startUtc:new Date(start*1000).toISOString(),
  endUtcExclusive:new Date(end*1000).toISOString(),hourly:table,daily:byDay,bySource,lag,histograms:hist,
  frequency:{app:frequency(AB,AA,common),referenceSameSeconds:frequency(MB,MA,common)},
  midpointAtZero:paired(appMid,refMid,common,0),hashes};
fs.writeFileSync(path.join(root,"board-analysis.json"),JSON.stringify(result,null,2)+"\n");
// Keep reusable compact BBO only, not expanded depth. Missing seconds are never filled.
fs.writeFileSync(path.join(root,"bbo.csv"),"tsSec,appBid,appAsk,source,referenceBid,referenceAsk\n"+
  all.map(i=>[i+start,AB[i],AA[i],source[i]===1?"live":"history",MB[i]||"",MA[i]||""].join(",")).join("\n")+"\n");

async function* lines(file,gz) {
  const raw=fs.createReadStream(file),input=gz?raw.pipe(createGunzip()):raw;
  raw.on("error",e=>input.destroy(e));const reader=createInterface({input,crlfDelay:Infinity});
  let failure;input.on("error",e=>{failure=e;reader.close();});
  try{for await(const line of reader)if(line)yield JSON.parse(line);if(failure)throw failure;}
  finally{reader.close();input.destroy();raw.destroy();}
}
const tradeRows=[],contracts={},examples=[];
function stats(){return {count:0,size:0,buy:0,sell:0,unknown:0,cells:new Map(),second:new Map()};}
function tradeAdd(s,t) {
  const sec=Math.floor(t.tsUs/1e6),key=sec+":"+t.price;
  let v=s.cells.get(key);if(!v)s.cells.set(key,v={count:0,size:0});v.count++;v.size+=t.size;
  v=s.second.get(sec);if(!v)s.second.set(sec,v={size:0,pv:0});v.size+=t.size;v.pv+=t.price*t.size;
  s.count++;s.size+=t.size;s[t.side==="B"||t.side==="buy"?"buy":t.side==="A"||t.side==="sell"?"sell":"unknown"]+=t.size;
}
for(const day of days) {
  const mbo=new Map();
  for await(const t of lines(path.resolve("data/research-v2/mbo-01/rebuilt/GCZ26",day,"mbo-trades.jsonl"),false)) {
    const hour=Math.floor(t.tsUs/3.6e9);let s=mbo.get(hour);if(!s)mbo.set(hour,s=stats());tradeAdd(s,t);
  }
  for(const input of manifest.filter(r=>r.name.includes("/trades/")&&r.name.includes(day))) {
    if(await hash(input.file)!==input.sha256)throw Error("app_trade_hash_changed");
    hashes.push({file:input.file,sha256:input.sha256,generation:input.generation});
    const app=stats(),hh=+path.basename(input.file).slice(0,2),hour=Date.parse(day+"T"+String(hh).padStart(2,"0")+":00:00Z")/3.6e6;
    for await(const t of lines(input.file,true)) {
      if(Math.floor(t.tsUs/3.6e9)!==hour)throw Error("trade_hour_out_of_range");
      const c=t.contract??"unknown";contracts[c]=(contracts[c]??0)+1;tradeAdd(app,t);
    }
    const ref=mbo.get(hour)??stats();let matchedCells=0,countIntersection=0,sizeIntersection=0,mismatchCells=0;
    let sameSizeCells=0,appCells=0,appCountGreaterSameSize=0,activeSecondReferenceSize=0;
    let midN=0,midAbs=0,spreadN=0,outsideApp=0,outsideRef=0,appShiftSize=[];
    for(const key of new Set([...app.cells.keys(),...ref.cells.keys()])) {
      const a=app.cells.get(key)??{count:0,size:0},b=ref.cells.get(key)??{count:0,size:0};
      if(a.count===b.count&&a.size===b.size)matchedCells++;else mismatchCells++;
      if(a.size===b.size)sameSizeCells++;
      if(a.count){appCells++;if(a.size===b.size&&a.count>b.count)appCountGreaterSameSize++;}
      countIntersection+=Math.min(a.count,b.count);sizeIntersection+=Math.min(a.size,b.size);
      if(a.count!==b.count&&examples.length<10)examples.push({key,app:a,reference:b});
    }
    for(const [sec,a]of app.second) {
      const b=ref.second.get(sec);
      activeSecondReferenceSize+=b?.size??0;
      if(b){midN++;midAbs+=Math.abs(a.pv/a.size-b.pv/b.size);}
    }
    for(const [key,a]of app.cells) {
      const [sec,p]=key.split(":").map(Number),i=sec-start;
      if(i>=0&&i<len&&AB[i]&&MB[i]) {
        spreadN+=a.count;if(p<AB[i]||p>AA[i])outsideApp+=a.count;if(p<MB[i]||p>MA[i])outsideRef+=a.count;
      }
    }
    for(let delta=-5;delta<=5;delta++) {
      let intersection=0;
      for(const [key,a]of app.cells) {
        const [sec,p]=key.split(":"),target=+sec+delta;
        const adjacentHour=mbo.get(Math.floor(target/3600));
        intersection+=Math.min(a.size,adjacentHour?.cells.get(target+":"+p)?.size??0);
      }
      appShiftSize.push({delta,intersection});
    }
    const {cells:ac,second:as,...a}=app,{cells:bc,second:bs,...b}=ref;
    tradeRows.push({utcHour:new Date(hour*3.6e6).toISOString(),app:a,reference:b,matchedCells,mismatchCells,
      sameSizeCells,appCells,appCountGreaterSameSize,activeSecondReferenceSize,
      countIntersection,sizeIntersection,commonVwapSeconds:midN,vwapMAETicks:midN?midAbs/midN:null,
      priceOutsideSameSecondEndQuotes:{count:spreadN,app:outsideApp,reference:outsideRef,caveat:"trade vs end-of-second BBO; not proof of execution outside quotes"},
      appShiftSize});
  }
  console.log(JSON.stringify({tradeDay:day,hours:tradeRows.filter(r=>r.utcHour.startsWith(day)).length}));
}
fs.writeFileSync(path.join(root,"trade-analysis.json"),JSON.stringify({hourly:tradeRows,contracts,examples,
  comparison:"per UTC second / integer tick price, counts and sizes separately; legitimate identical trades not deduplicated",
  caveat:"intersection of aggregated sizes is not proof of trade identity or a completeness measure"},null,2)+"\n");
fs.writeFileSync(path.join(root,"used-hashes.json"),JSON.stringify(hashes,null,2)+"\n");
console.log(JSON.stringify({complete:true,boardHours:table.length,tradeHours:tradeRows.length,maxRSSKiB:process.resourceUsage().maxRSS}));
