/** Replay saved snapshots through existing pure normalization/aggregation/binary functions. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {normalizeBook} from "../server/src/ingest/normalize.ts";
import {ColumnAggregator} from "../server/src/aggregate/columns.ts";
import {columnFileRange} from "../server/src/store/records.ts";
import {encodeColumns,decodeColumns} from "../server/src/store/binary.ts";
const dir=path.resolve("data/research-v2/gc-alignment-02");
const inputs=JSON.parse(fs.readFileSync(path.join(dir,"inputs.json")));
const results=[],rejects={};
const metrics={issue:(name)=>{rejects[name]=(rejects[name]??0)+1;},count:()=>{},bookRejections:{}};
for(const r of inputs.filter(r=>r.name.includes("/columns/"))) {
  const day=r.name.match(/2026-\d\d-\d\d/)[0],hh=path.basename(r.file).slice(0,2);
  const from=Date.parse(day+"T"+hh+":00:00Z")/1000;
  let checked=0;
  for await(const c of columnFileRange(r.file,from,from+3600)) {
    if(c.tsSec%60!==0&&checked>=2)continue;
    const ts=c.source==="live"?c.tsSec:c.tsSec*1e6;
    const message={symbol:"GC",ts,bids:c.bids.map(x=>[x.price/10,x.size]),asks:c.asks.map(x=>[x.price/10,x.size])};
    const normalized=normalizeBook(message,c.tsSec*1e6,c.source,metrics,()=>false,"GC");
    assert.ok(normalized,"saved snapshot re-normalization rejected");
    let out;const agg=new ColumnAggregator(column=>out=column);agg.accept(normalized);agg.finish();
    assert.deepEqual(out,c);assert.deepEqual(decodeColumns(encodeColumns([out]))[0],c);checked++;
    if(checked>=5)break;
  }
  results.push({file:r.file,checked});
}
const result={snapshots:results.reduce((n,r)=>n+r.checked,0),hours:results.length,results,rejects,
  caveat:"Saved snapshot re-encoding test, not proof of equality to missing original upstream frames; LocalStore is inspected, never instantiated."};
fs.writeFileSync(path.join(dir,"path-verification.json"),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({snapshots:result.snapshots,hours:results.length,rejects}));
