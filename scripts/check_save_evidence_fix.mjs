/** Actual MBO trade inputs, converted to the documented GC history field shape.
 * Isolated decoder replay only: NOT a TICK STREAM fetch and NOT a product repair. */
import fs from "node:fs";
import readline from "node:readline";
import {historyTrades} from "../server/src/history/decode.ts";
import {Metrics} from "../server/src/ingest/metrics.ts";
import {containsSecond} from "../server/src/store/coverage.ts";
const root=process.argv[2]??"data/research-v2/save-evidence-fix-audit";
const coverage=JSON.parse(fs.readFileSync(root+"/GC-coverage.json")).tick;
const hours=new Set([8,11,12,13,14]),start=Date.parse("2026-10-30T08:00:00Z")/1000;
const source=fs.createReadStream("data/research-v2/mbo-01/rebuilt/GCZ26/2026-10-30/mbo-trades.jsonl");
const reader=readline.createInterface({input:source,crlfDelay:Infinity}),metrics=new Metrics(()=>{});
let batch=[],seq=0;
const result={description:"Actual purchased MBO T records in five covered GC hour slices, normalized to history API shape; not feed completeness proof",
  selectedRows:0,oldSideFilterRows:0,oldSideFilterVolume:0,newRows:0,newVolume:0,unknownRows:0,unknownVolume:0};
function flush(){
  const trades=historyTrades(batch,start,start+7*3600,metrics,()=>++seq,"GC");
  result.newRows+=trades.length;
  for(const t of trades){result.newVolume+=t.size;if(t.side==="unknown"){result.unknownRows++;result.unknownVolume+=t.size;}}
  batch=[];
}
try{
  for await(const line of reader){
    if(!line)continue;const t=JSON.parse(line),sec=Math.floor(t.tsUs/1e6);
    if(!hours.has(new Date(t.tsUs/1000).getUTCHours())||!containsSecond(coverage,sec))continue;
    if(!["B","A","N"].includes(t.side))throw Error("unexpected_source_side");
    result.selectedRows++;
    if(t.side!=="N"){result.oldSideFilterRows++;result.oldSideFilterVolume+=t.size;}
    batch.push({ts:t.tsUs,price:t.price/10,size:t.size,side:t.side==="B"?"buy":t.side==="A"?"sell":"N",contract:"GCZ6"});
    if(batch.length===1024)flush();
  }
  if(batch.length)flush();
}finally{reader.close();source.destroy();}
if(result.newRows!==result.selectedRows||result.newVolume!==result.oldSideFilterVolume+result.unknownVolume)
  throw Error("decoder_quantity_mismatch");
fs.writeFileSync(root+"/decoder-replay.json",JSON.stringify({...result,metrics:metrics.counts},null,2)+"\n");
console.log(JSON.stringify(result));
