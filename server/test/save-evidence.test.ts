import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Backfill } from "../src/history/backfill.ts";
import { historyTrades } from "../src/history/decode.ts";
import { observedRanges } from "../src/history/evidence.ts";
import { LocalStore } from "../src/store/local.ts";
import { Receiver } from "../src/ingest/receiver.ts";
import { Metrics } from "../src/ingest/metrics.ts";
import { VolumeProfile } from "../src/vp/state.ts";
import { LongAggregate } from "../src/long-vp/aggregate.ts";
import { readTradeRange } from "../src/vp/trade-history.ts";
import type { MarketSymbol } from "../../lib/market/instruments.ts";

const hour=Date.parse("2026-10-30T08:00:00Z")/1000,L=hour+60;
const noop=()=>{},metrics=()=>new Metrics(noop);
function book(sec:number,symbol:MarketSymbol){
  const tick=symbol==="GC"?.1:.25;
  return ["bid","ask"].flatMap(side=>Array.from({length:400},(_,i)=>({
    ts:sec*1e6,side,level:i+1,price:4000+(side==="bid"?-i:i+1)*tick,size:1,flag:0 })));
}
test("observed coverage merges rollback/duplicates but never bridges a quiet/missing second",()=>{
  assert.deepEqual(observedRanges([12,10,10,11,15]),[[10,13],[15,16]]);
  assert.deepEqual(observedRanges([]),[]);
});
for(const symbol of ["NQ","GC"] as const)for(const mode of ["empty","partial","invalid","prepared"] as const){
  test(`${symbol}: ${mode} backfill records only accepted seconds and survives reopening`,async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"save-evidence-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const store=new LocalStore(root,()=> (L+1000)*1000,undefined,symbol);await store.initialize();
    for(const kind of ["book","tick"] as const)store.markCovered(kind,L-10800,hour);
    let seq=0;
    const source={symbol,get:async(kind:"book"|"tick")=>{
      if(mode==="empty")return {rows:[],truncated:false};
      const rows=kind==="book"?book(hour+2,symbol):[
        {ts:(hour+2)*1e6,price:4000,size:2,side:"N"},
        {ts:(hour+5)*1e6,price:4000,size:1,side:"buy"}];
      if(mode==="invalid")return {rows:rows.map(r=>({...r,price:4000.01})),truncated:false};
      if(mode==="prepared")return {rows:[],truncated:false,prepared:{inputRows:rows.length,counts:{},examples:{},
        columns:kind==="book"?[{tsSec:hour+2,source:"history" as const,bids:[{price:4000,size:1}],asks:[{price:4001,size:1}]}]:[],
        trades:kind==="tick"?[{tsUs:(hour+2)*1e6,recvUs:(hour+2)*1e6,seq:0,price:4000,size:2,side:"unknown" as const}]:[]}};
      return {rows,truncated:false};
    }};
    const job=new Backfill(source,store,metrics(),()=>++seq,noop,{now:()=> (L+1000)*1000,wait:async()=>{}});
    job.start(L);await job.settled();assert.equal(job.status.state,"complete");
    const adopted=mode==="partial"||mode==="prepared";
    for(const kind of ["book","tick"] as const){
      assert.equal(store.covered(kind,hour),false);assert.equal(store.covered(kind,hour+2),adopted);
      assert.equal(store.covered(kind,hour+3),false);assert.equal(store.covered(kind,hour+59),false);
    }
    assert.equal(store.covered("tick",hour+5),mode==="partial");
    assert.equal((await store.readTrades(hour,L)).length,mode==="partial"?2:mode==="prepared"?1:0);
    const reopened=new LocalStore(root,()=> (L+1000)*1000,undefined,symbol);await reopened.initialize();
    assert.equal(reopened.covered("book",hour+2),adopted);
    assert.equal(reopened.covered("tick",hour+3),false);
    if(!adopted)assert.ok(job.status.noData.length||job.status.gaps.length);
  });
}
for(const symbol of ["NQ","GC"] as const){
  test(`${symbol}: live/history N normalizes to unknown and preserves totals without delta/CVD allocation`,()=>{
    const receiver=new Receiver(noop,{},symbol);
    for(const side of ["N","unknown","buy","sell","garbage"])receiver.receive(JSON.stringify({
      type:"tick",symbol,ts:hour,price:4000,size:3,side,...(symbol==="GC"?{contract:"GCZ6"}:{})
    }),hour*1e6,noop);
    const live=receiver.trades.latest();
    assert.deepEqual(live.map(t=>t.side),["unknown","unknown","buy","sell"]);
    assert.equal(receiver.metrics.counts.rejectedTrade,1);
    let seq=0;
    const history=historyTrades(["N","unknown","buy","sell"].map(side=>({
      ts:hour*1e6,price:4000,size:3,side })),hour,L,metrics(),()=>++seq,symbol);
    assert.deepEqual(history.map(t=>t.side),live.map(t=>t.side));
    const vp=new VolumeProfile(hour),long=new LongAggregate();
    for(const row of history){vp.add(row);long.add(row,symbol==="GC"?"GCZ6":"NQZ6");}
    assert.equal(vp.summary().total,12);assert.equal(vp.summary().undirected,6);
    assert.equal(vp.summary().buy-vp.summary().sell,0);
    const bar=[...long.minutes.values()][0];assert.equal(bar.buy+bar.sell+(bar.undirected??0),12);
    assert.equal(bar.buy-bar.sell,0);
  });
}
test("VP empty insertion leaves no file/coverage; partial N is persisted once without covering its neighbors",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"save-evidence-vp-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new LocalStore(root,()=> (L+1000)*1000);await store.initialize();
  await store.insertUncoveredTradeRange(hour,L,[]);assert.deepEqual(await store.recordedTickCoverage(),[]);
  await assert.rejects(fs.access(path.join(root,"trades/NQ/2026-10-30/08.jsonl.gz")));
  const row={tsUs:(hour+3)*1e6,recvUs:(hour+3)*1e6,seq:1,price:16000,size:7,side:"unknown" as const};
  await store.insertUncoveredTradeRange(hour,L,[row]);await store.insertUncoveredTradeRange(hour,L,[row]);
  assert.deepEqual(await store.recordedTickCoverage(),[[hour+3,hour+4]]);
  assert.deepEqual(await store.readTrades(hour,L),[row]);
});
test("VP reader does not adopt empty/quiet response as coverage or silently mark loading range complete",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"save-evidence-reader-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new LocalStore(root);await store.initialize();
  const state=await readTradeRange({store,source:{get:async()=>({rows:[],truncated:false})},metrics:metrics(),
    nextSeq:()=>1,start:hour,end:L,signal:new AbortController().signal,visit:()=>assert.fail("no trades")});
  assert.equal(state.apiSeconds,0);assert.equal(state.noData.length,1);
  assert.deepEqual(await store.recordedTickCoverage(),[]);
});
