import { expect,it } from "vitest";
import { createMarketQualityState, currentMbpBook, currentQuality, readCurrentMbpLevel } from "@workspace/core/quality-timeline";
import { checksum } from "@workspace/storage/catalog";
import { F01_BOOK,F03_GAP_TWA,F04_TRADES } from "@workspace/fixtures";
import type { EventHeader, MarketEvent } from "@workspace/core/events";
import { restingQuantity } from "@workspace/core/events";
import { eventAt,recoveryAt,config,ns } from "./r16Fixtures";
import { PublishedState,SeenTransaction,oracleStep,sourceHashes,guardPrototypeOnce,type Step,type SeenMode } from "./r164SeenPrototype";
import { guardEvent,rebaseSequenceGuard } from "@workspace/core/sequence-guard";

const modes=["A","B","C"] as const;
const ev=(event:MarketEvent):Step=>({type:"EVENT",event});
function changed(event:MarketEvent,header:Partial<EventHeader>,body:object={}):MarketEvent{
  return {...structuredClone(event),...body,header:{...event.header,...header}} as MarketEvent;
}
function seed(count=1){
  let s=createMarketQualityState(config(),ns(0));
  for(let i=0;i<count;i++)s=oracleStep(s,ev(eventAt(i))).state;
  return PublishedState.fromOracle(s);
}
function compare(mode:SeenMode,steps:Step[],base=seed()){
  const original=base.checksum(),rawBefore=checksum(steps),tx=new SeenTransaction(mode,base);
  let old=base.inspect();
  for(const step of steps){
    const before=checksum(old),r=oracleStep(old,step),got=tx.apply(step);
    expect(got).toEqual({applied:r.applied,outcome:r.outcome,reason:r.reason});
    expect(checksum(old)).toBe(before);
    expect(tx.inspect()).toEqual(r.state);
    expect(checksum(tx.inspect())).toBe(checksum(r.state));
    old=r.state;expect(base.checksum()).toBe(original);
  }
  tx.commit();expect(tx.phase).toBe("COMMITTED_NOT_PUBLISHED");
  expect(base.checksum()).toBe(original);
  const next=tx.publish();
  expect(next.inspect()).toEqual(old);expect(next.checksum()).toBe(checksum(old));
  expect(checksum(steps)).toBe(rawBefore);
  return {next,tx};
}
const condition=(status:"GAP"|"RESYNCING",i:number):Step=>({
  type:"CONDITION",channel:"L2_MBP",status,atNs:ns(i),reason:`fixed MOCK ${status}`,
});
const trade=(i:number)=>changed(F04_TRADES.events[0],{...eventAt(i).header,channel:"TRADES"},{
  tradeId:`trade-${i}`,
});
const quote=(i:number):MarketEvent=>({kind:"L1_QUOTE",
  header:{...eventAt(i).header,channel:"L1"},bestBidTick:80000,bestAskTick:80001,bidQty:restingQuantity(0),askQty:null});
const gap=changed(eventAt(2),{sequence:"4"});
const badBook=changed(recoveryAt(4),{},{
  bids:[{priceTicks:80000,qty:40},{priceTicks:80000,qty:50}],
});
const cases:Record<string,()=>Step[]>={
  continuous:()=>[ev(eventAt(1)),ev(eventAt(2)),ev(eventAt(3))],
  duplicate:()=>[ev(eventAt(1)),ev(eventAt(1)),ev(eventAt(2))],
  conflict:()=>[ev(eventAt(1)),ev(changed(eventAt(1),{}, {qty:99})),ev(eventAt(2))],
  foreignSession:()=>[ev(changed(eventAt(1),{sessionId:"MOCK-OTHER"})),ev(eventAt(1))],
  foreignInstrument:()=>[ev(changed(eventAt(1),{canonicalInstrumentId:"CME:NQ:2026-06"})),ev(eventAt(1))],
  foreignSource:()=>[ev(changed(eventAt(1),{sourceId:"MOCK-OTHER"})),ev(eventAt(1))],
  channels:()=>[ev(gap),ev(trade(3)),ev(quote(3)),ev(eventAt(4))],
  sequenceGap:()=>[ev(gap),ev(eventAt(4)),ev(recoveryAt(5)),ev(eventAt(6))],
  reconnectNotRecovery:()=>[condition("GAP",1),condition("RESYNCING",2),ev(eventAt(3))],
  snapshotRecovery:()=>[condition("GAP",1),condition("RESYNCING",2),ev(recoveryAt(3)),ev(eventAt(4))],
  snapshotAlignment:()=>[condition("GAP",1),ev(changed(recoveryAt(2),{}, {snapshotCoversSequence:"1"})),ev(recoveryAt(3))],
  snapshotOld:()=>[ev(gap),ev(changed(recoveryAt(4),{sequence:"2"},{snapshotCoversSequence:"2"})),ev(recoveryAt(5))],
  snapshotDepth:()=>[condition("GAP",1),ev(changed(recoveryAt(2),{}, {depthScope:{type:"TOP_N",n:1}})),ev(recoveryAt(3))],
  snapshotDuplicateBook:()=>[condition("GAP",1),ev(badBook),ev(recoveryAt(4)),ev(eventAt(5))],
  snapshotDuplicate:()=>[ev(recoveryAt(2)),ev(recoveryAt(2))],
  snapshotConflict:()=>[ev(recoveryAt(2)),ev(changed(recoveryAt(2),{}, {bids:[]}))],
  scopeChange:()=>[ev(changed(eventAt(1),{sequenceScope:"INSTRUMENT"})),ev(eventAt(2))],
  suspectQuality:()=>[ev(changed(eventAt(1),{quality:"SUSPECT"})),ev(eventAt(2)),ev(recoveryAt(3))],
  oldSequence:()=>[ev(eventAt(1)),ev(changed(eventAt(2),{sequence:"1"})),ev(recoveryAt(3))],
  backwardsClock:()=>[ev(eventAt(1)),ev(changed(eventAt(2),{exchangeTimeNs:ns(0)})),ev(recoveryAt(3))],
  incompleteSequence:()=>[ev(changed(trade(1),{sequence:null}))],
  partialDuplicateBatch:()=>[{type:"BATCH",events:[eventAt(0),eventAt(1)]} as Step],
};
// Partial-duplicate logical MBP batch must contain updates, not a snapshot.
cases.partialDuplicateBatch=()=>[
  ev(eventAt(1)),{type:"BATCH",events:[eventAt(1),eventAt(2)]},
];
for(const mode of modes){
  it.each(Object.keys(cases))(`${mode}: native oracle matches every column for %s`,name=>{
    compare(mode,cases[name]());
  });
  it(`${mode}: bad book after successful guard rebase does not poison seen`,()=>{
    const tx=new SeenTransaction(mode,seed());
    expect(tx.apply(ev(badBook)).outcome).toBe("RESYNC_REJECTED");
    expect(tx.inspect().guard.seen.size).toBe(1);
    expect(tx.apply(ev(recoveryAt(4))).applied).toBe(true);
    if(mode!=="A")expect(tx.metrics.undoneWrites).toBe(1);
  });
  it(`${mode}: malformed throw rolls back operation, candidate remains usable`,()=>{
    const base=seed(),tx=new SeenTransaction(mode,base),before=checksum(tx.inspect());
    expect(()=>tx.apply(ev(changed(eventAt(1),{},{qty:-1})))).toThrow();
    expect(checksum(tx.inspect())).toBe(before);
    expect(tx.apply(ev(eventAt(1))).applied).toBe(true);
    tx.rollback();expect(base.inspect().guard.seen.size).toBe(1);
  });
  it(`${mode}: simulated commit failure discards candidate, exact retry, no double application`,()=>{
    const base=seed(),before=base.checksum(),tx=new SeenTransaction(mode,base);
    tx.apply(ev(eventAt(1)));tx.apply(ev(eventAt(1)));
    expect(()=>tx.commit(()=>{throw Error("SIMULATED_STORAGE_FAILURE");})).toThrow("SIMULATED");
    expect(tx.phase).toBe("ROLLED_BACK");expect(base.checksum()).toBe(before);
    expect(()=>tx.publish()).toThrow();expect(()=>tx.apply(ev(eventAt(2)))).toThrow();
    const {next}=compare(mode,[ev(eventAt(1)),ev(eventAt(1))],base);
    expect(next.inspect().guard.seen.size).toBe(2);
  });
  it(`${mode}: rollback before prepare, after prepare, concurrent candidate isolation`,()=>{
    const base=seed(),sum=base.checksum(),x=new SeenTransaction(mode,base),y=new SeenTransaction(mode,base);
    x.apply(ev(eventAt(1)));y.apply(ev(changed(eventAt(1),{},{qty:999})));
    expect(checksum(x.inspect())).not.toBe(checksum(y.inspect()));
    x.prepare();x.rollback();y.rollback();
    expect(base.checksum()).toBe(sum);
    expect(x.ownership.map(o=>Reflect.get(o,"point"))).toContain("ROLLED_BACK");
  });
  it(`${mode}: post-commit publish failure is retryable but cannot roll back`,()=>{
    const base=seed(),tx=new SeenTransaction(mode,base);tx.apply(ev(eventAt(1)));tx.commit();
    expect(()=>tx.publish(()=>{throw Error("PUBLISH_FAILURE");})).toThrow("PUBLISH_FAILURE");
    expect(tx.phase).toBe("COMMITTED_NOT_PUBLISHED");
    expect(()=>tx.rollback()).toThrow("AFTER_COMMIT");
    const next=tx.publish();expect(next.inspect().guard.seen.size).toBe(2);
    expect(()=>tx.publish()).toThrow();expect(()=>tx.commit()).toThrow();
    expect(base.inspect().guard.seen.size).toBe(1);
  });
  it(`${mode}: diagnostic snapshots never expose writable candidate/base Maps`,()=>{
    const base=seed(),tx=new SeenTransaction(mode,base),before=base.checksum();
    const old=base.inspect(),draft=tx.inspect();
    expect(old.guard.seen).not.toBe(draft.guard.seen);
    (old.guard.seen as Map<string,string>).clear();
    (draft.guard.seen as Map<string,string>).set("forged","fingerprint");
    (draft.lastGoodBook.bids as Map<number,unknown>).clear();
    expect(base.checksum()).toBe(before);expect(tx.inspect().guard.seen.size).toBe(1);
    tx.apply(ev(eventAt(1)));tx.commit();const next=tx.publish(),sum=next.checksum();
    const observed=next.inspect();(observed.guard.seen as Map<string,string>).clear();
    expect(next.checksum()).toBe(sum);expect(()=>tx.inspect()).toThrow();
  });
  it(`${mode}: multiple committed generations match native oracle; old generations immutable`,()=>{
    let base=seed(),old=base.inspect();const retained:[PublishedState,string][]=[];
    for(let start=1;start<33;start+=4){
      retained.push([base,base.checksum()]);
      const tx=new SeenTransaction(mode,base);
      for(let i=start;i<start+4;i++){
        const step=ev(eventAt(i));old=oracleStep(old,step).state;tx.apply(step);
      }
      tx.commit();base=tx.publish();expect(base.inspect()).toEqual(old);
      for(const [prior,hash]of retained)expect(prior.checksum()).toBe(hash);
      if(mode==="C"&&start>1)expect(tx.metrics.copies).toBe(1);
    }
  });
  it(`${mode}: independent scopes cannot contaminate seen/quality`,()=>{
    const a=seed(),other=a.inspect();
    const cfg={...config(),identity:{...config().identity,sessionId:"MOCK-OTHER"}};
    const b=PublishedState.fromOracle(createMarketQualityState(cfg,ns(0)));
    const x=new SeenTransaction(mode,a),y=new SeenTransaction(mode,b);
    x.apply(ev(gap));y.apply(ev(changed(recoveryAt(3),{sessionId:"MOCK-OTHER"})));
    expect(currentQuality(x.inspect().timeline,"L2_MBP").status).toBe("GAP");
    expect(currentMbpBook(x.inspect())).toBeNull();
    expect(currentQuality(y.inspect().timeline,"L2_MBP").status).toBe("VALID");
    expect(a.inspect()).toEqual(other);x.rollback();y.rollback();
  });
  it(`${mode}: all channels and configured NONE/INSTRUMENT/PACKET semantics match oracle`,()=>{
    for(const scope of["NONE","INSTRUMENT","PACKET"] as const){
      const cfg=config(),rule={scope,continuity:{contiguous:false} as const};
      const base=PublishedState.fromOracle(createMarketQualityState({...cfg,
        rules:{L1:rule,L2_MBP:rule,TRADES:rule}},ns(0)));
      compare(mode,[ev(changed(quote(1),{sequenceScope:scope,sequence:scope==="NONE"?null:"1"})),
        ev(changed(trade(1),{sequenceScope:scope,sequence:scope==="NONE"?null:"1"}))],base);
    }
  });
  it(`${mode}: immutable original F-01 and F-03 fixture outcomes remain identical`,()=>{
    for(const f of[F01_BOOK,F03_GAP_TWA]){
      const h=f.events[0].header,cfg=config();
      const base=PublishedState.fromOracle(createMarketQualityState({...cfg,identity:{
        ...cfg.identity,sessionId:h.sessionId,sourceId:h.sourceId,
      }},h.receiveTimeNs));
      const steps=f===F01_BOOK?f.events.map(ev):[ev(f.events[0]),{
        type:"CONDITION",channel:"L2_MBP",status:"GAP",atNs:F03_GAP_TWA.gap.startNs,reason:"F03 fixed gap",
      } as Step,ev(f.events[1])];
      const {next}=compare(mode,steps,base);
      expect(readCurrentMbpLevel(next.inspect(),"BID",80000).qty).toBe(f===F01_BOOK?0:70);
    }
  });
}
it.each(modes)("%s: finite entry budget rejects new IDs without altering a full base",mode=>{
  const old=seed().inspect(),seen=new Map(old.guard.seen);
  while(seen.size<4096)seen.set(`synthetic-only-${seen.size}`,"metadata-only fixed MOCK fingerprint");
  const base=PublishedState.fromOracle({...old,guard:{...old.guard,seen}});
  const tx=new SeenTransaction(mode,base),before=base.checksum();
  expect(()=>tx.apply(ev(eventAt(1)))).toThrow("4096");
  expect(base.checksum()).toBe(before);
  expect(checksum(tx.inspect())).toBe(before);tx.rollback();
  seen.set("overflow","metadata-only");
  expect(()=>PublishedState.fromOracle({...old,guard:{...old.guard,seen}})).toThrow("base entry budget");
});
it("cumulative transaction bytes stop before exceeding private admission budget",()=>{
  const tx=new SeenTransaction("C",seed());
  const h=eventAt(1).header,large=changed(eventAt(1),{eventId:"MOCK-LARGE-"+ "x".repeat(1024*1024)});
  // Each rejected scope consumes admitted audit bytes but cannot grow seen.
  const mismatch=changed(large,{...h,eventId:large.header.eventId,sessionId:"MOCK-FOREIGN"});
  let count=0;
  expect(()=>{
    for(;count<20;count++)tx.apply(ev(mismatch));
  }).toThrow("transaction input bytes");
  expect(count).toBeGreaterThan(1);expect(count).toBeLessThan(8);
  expect(tx.inspect().guard.seen.size).toBe(1);tx.rollback();
});
it("source hashes and A/B/C exact copy counts, including publication and flatten boundaries",()=>{
  expect(sourceHashes.guard).toMatch(/^[a-f0-9]{64}$/);
  for(const mode of modes){
    const tx=new SeenTransaction(mode,seed(100));
    for(let i=100;i<200;i++)tx.apply(ev(eventAt(i)));
    expect(tx.metrics.copies).toBe(mode==="A"?100:mode==="B"?1:0);
    expect(tx.metrics.copiedEntries).toBe(mode==="A"?14950:mode==="B"?100:0);
    tx.commit();const next=tx.publish();
    const second=new SeenTransaction(mode,next);
    expect(second.metrics.copiedEntries).toBe(mode==="A"?0:200);
    second.rollback();
  }
});
it("finite input safety stops before mutation; invalid mode or forged base rejected",()=>{
  const tx=new SeenTransaction("B",seed());
  expect(()=>tx.apply({type:"BATCH",events:Array.from({length:129},()=>eventAt(1))})).toThrow("128");
  expect(tx.inspect().guard.seen.size).toBe(1);expect(tx.metrics.writes).toBe(0);
  expect(()=>new SeenTransaction("X" as SeenMode,seed())).toThrow("INVALID_MODE");
  expect(()=>new SeenTransaction("B",{} as PublishedState)).toThrow("UNKNOWN_BASE");
  expect(()=>Reflect.construct(PublishedState,[seed().inspect()])).toThrow("PRIVATE_TRANSFER");
});
it.each(["B","C"] as const)("%s: actual private storage identities differ between candidates",mode=>{
  const base=seed(),a=new SeenTransaction(mode,base),b=new SeenTransaction(mode,base);
  const ax=a.ownership[1]!,bx=b.ownership[1]!;
  expect(Reflect.get(ax,"privateStorageReference")).not.toBe(Reflect.get(bx,"privateStorageReference"));
  expect(Reflect.get(a.ownership[0]!,"publishedSeenReference"))
    .toBe(Reflect.get(b.ownership[0]!,"publishedSeenReference"));
  a.rollback();b.rollback();
});
it("all nine strategy switch pairs retain exact state and permit reference rollback",()=>{
  for(const first of modes)for(const second of modes){
    const {next}=compare(first,[ev(eventAt(1))]);
    compare(second,[ev(eventAt(2)),ev(eventAt(2))],next);
  }
});
for(const mode of modes){
  it.each(["duplicate","conflict","changedSequenceScope","reorderedKeys","gap","unverifiable",
    "validRebase","invalidRebase","missingEvidence"])(`${mode}: standalone guard oracle %s`,name=>{
    const base=seed().inspect().guard,before=checksum(base);
    let input=eventAt(1),rule=config().rules.L2_MBP.continuity,alignment:string|undefined;
    if(name==="duplicate")input=eventAt(0);
    if(name==="conflict")input=changed(eventAt(0),{}, {bids:[]});
    if(name==="changedSequenceScope")input=changed(eventAt(0),{sequenceScope:"INSTRUMENT"});
    if(name==="reorderedKeys")input=Object.fromEntries(Object.entries(eventAt(0)).reverse()) as unknown as MarketEvent;
    if(name==="gap")input=gap;
    if(name==="unverifiable"){input=changed(eventAt(1),{sequence:null,sequenceScope:"NONE"});rule={contiguous:false};}
    if(name==="validRebase"){input=recoveryAt(2);alignment="MOCK same header and covers sequence";}
    if(name==="invalidRebase"){input=changed(recoveryAt(2),{},{snapshotCoversSequence:"1"});alignment="MOCK alignment";}
    if(name==="missingEvidence")rule={contiguous:true,evidence:""};
    if(name==="missingEvidence"){
      expect(()=>guardEvent(base,input,rule)).toThrow();
      expect(()=>guardPrototypeOnce(mode,base,input,rule)).toThrow();
    }else{
      const oracle=alignment===undefined?guardEvent(base,input,rule):rebaseSequenceGuard(base,input,rule,alignment);
      const result=guardPrototypeOnce(mode,base,input,rule,alignment).result;
      expect(result).toEqual(oracle);
      if(name==="changedSequenceScope")expect(result.outcome).toBe("CONFLICT");
      if(name==="reorderedKeys")expect(result.outcome).toBe("DUPLICATE");
    }
    expect(checksum(base)).toBe(before);
  });
}
