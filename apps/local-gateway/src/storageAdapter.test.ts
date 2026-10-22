import { expect, it } from "vitest";
import { checksum } from "@workspace/storage/catalog";
import { EventPipeline } from "./eventPipeline";
import { StorageAdapter } from "./storageAdapter";
import { config, eventAt, ns, ownedDirectory, recoveryAt, removeOwnedDirectory, deterministicDeliveries } from "./r16Fixtures";
import type { FiniteSeenRun } from "./storageAdapter";
function isolated(run:(s:StorageAdapter,p:EventPipeline,id:string)=>void) {
  const dir=ownedDirectory(),s=new StorageAdapter(dir);
  try{const id=s.register(config(),ns(0));run(s,new EventPipeline(s),id);}
  finally{s.close();removeOwnedDirectory(dir);}
}
for(const mode of ["immutable","owned"] as const) {
  const finite:FiniteSeenRun={mode,eventLimit:100,traceHash:checksum("R165 same input"),c1Mode:"reference",boundary:"fixed"};
  function run(test:(s:StorageAdapter,p:EventPipeline,id:string)=>void) {
    const dir=ownedDirectory(),s=new StorageAdapter(dir,{finiteSeen:finite});
    try {const id=s.register(config(),ns(0));test(s,new EventPipeline(s),id);}
    finally{s.close();removeOwnedDirectory(dir);}
  }
  it(`R165 ${mode}: publish failure retries without INSERT and old readers stay unchanged`,()=>run((s,p,id)=>{
    const old=s.stateSnapshot(id),oldHash=checksum(old);
    s.beforePublish=()=>{throw Error("publish failed");};
    p.receive(id,eventAt(0));expect(p.drain()).toBe(false);
    const hash=checksum(s.journal.records()),manifest=s.catalog.manifest();
    expect(s.pendingAttempt?.phase).toBe("COMMITTED_NOT_PUBLISHED");
    expect(checksum(s.stateSnapshot(id))).toBe(oldHash);expect(p.metrics.persistedEvents).toBe(0);
    s.beforePublish=undefined;expect(p.drain()).toBe(true);
    expect(checksum(s.journal.records())).toBe(hash);expect(s.catalog.manifest()).toEqual(manifest);
    expect(p.metrics.persistedEvents).toBe(1);expect(checksum(old)).toBe(oldHash);
    expect(p.drain()).toBe(true);expect(p.metrics.persistedEvents).toBe(1);
  }));
  it(`R165 ${mode}: lost commit return requires independent verification`,()=>run((s,p,id)=>{
    s.afterCommitBeforeReceipt=()=>{throw Error("lost receipt");};
    p.receive(id,eventAt(0));expect(p.drain()).toBe(false);
    expect(s.pendingAttempt?.receipt).toBeNull();
    expect(s.pendingAttempt?.evidence?.expected).not.toBeNull();
    const hash=checksum(s.journal.records());
    s.afterCommitBeforeReceipt=undefined;expect(p.drain()).toBe(true);
    expect(checksum(s.journal.records())).toBe(hash);expect(p.metrics.persistedEvents).toBe(1);
  }));
  it(`R165 ${mode}: corrupt evidence is not success proof and UNKNOWN fences writes`,()=>run((s,p,id)=>{
    s.afterCommitBeforeReceipt=()=>{throw Error("lost");};
    p.receive(id,eventAt(0));expect(p.drain()).toBe(false);
    s.catalog.database.prepare("UPDATE records SET checksum='bad' WHERE position=1").run();
    expect(s.pendingAttempt?.reconcile()).toBe("UNKNOWN");
    expect(p.drain()).toBe(false);expect(p.metrics.persistedEvents).toBe(0);
    expect(()=>s.commit(id,[{type:"EVENT",event:eventAt(1)}])).toThrow();
  }));
  it(`R165 ${mode}: same-base candidates do not share writes; stale generation rejected`,()=>run((s,_p,id)=>{
    const a=s.beginCommit(id,[{type:"EVENT",event:eventAt(0)}]);
    const b=s.beginCommit(id,[{type:"EVENT",event:eventAt(0)}]);
    a.execute();expect(()=>b.execute()).toThrow("Stale");
    const detached=s.states.get(id)!;(detached.guard.seen as Map<string,string>).clear();
    expect(s.stateSnapshot(id)?.guard.seen.size).toBe(1);
  }));
}
it.each(["immutable","owned"] as const)("R165 %s preserves 1010/1000/10 delivery and full restore hashes",mode=>{
  const dir=ownedDirectory(),s=new StorageAdapter(dir,{finiteSeen:{mode,eventLimit:2000,
    traceHash:checksum("1010-1000-10"),c1Mode:"reference",boundary:"fixed"}});
  try {
    const id=s.register(config(),ns(0)),p=new EventPipeline(s);
    const inputs=deterministicDeliveries(),hash=checksum(inputs);
    for(const event of inputs)expect(p.receive(id,event)).toBe(true);
    expect(p.drain()).toBe(true);
    expect(p.metrics).toMatchObject({receivedEvents:1010,persistedEvents:1000,duplicateEvents:10,appliedEvents:1000});
    expect(checksum(s.journal.records(id).map(r=>(r.input as {event:unknown}).event))).toBe(hash);
    expect(checksum(s.stateSnapshot(id))).toBe(checksum(s.journal.replay(id)));
  } finally{s.close();removeOwnedDirectory(dir);}
},30_000);
it.each([NaN,Infinity,-Infinity,undefined])("R165 never silently normalizes invalid input %s",value=>isolated((s,_p,id)=>{
  const event=eventAt(0);
  const malformed={...event,header:{...event.header,exchangeTimeNs:value}};
  expect(()=>s.commit(id,[{type:"EVENT",event:malformed as never}])).toThrow();
  expect(s.journal.records()).toHaveLength(0);
  expect(s.pendingAttempt).toBeNull();
}));
it("uses actual patched SQLite, FULL durability and WAL", ()=>isolated(s=>{
  const version=s.catalog.database.prepare("SELECT sqlite_version() AS v").get() as {v:string};
  const [major,minor,patch]=version.v.split(".").map(Number);
  expect(major*1e6+minor*1e3+patch).toBeGreaterThanOrEqual(3e6+51e3+3);
  expect(s.catalog.database.pragma("journal_mode",{simple:true})).toBe("wal");
  expect(s.catalog.database.pragma("synchronous",{simple:true})).toBe(2);
}));
it("transaction failure leaves both stored bytes and canonical model untouched", ()=>isolated((s,p,id)=>{
  p.receive(id,eventAt(0));p.drain();const before=checksum(s.journal.records(id));
  s.beforeCommit=()=>{throw Error("FAIL BEFORE COMMIT");};p.receive(id,eventAt(1));p.flush();
  expect(checksum(s.journal.records(id))).toBe(before);
  expect(s.states.get(id)?.lastGoodBook.bids.get(80000)).toBe(40);
  expect(s.catalog.manifest().recordCount).toBe("1");
}));
it("bounds paused transport notifications at high and low watermarks", ()=>isolated((s,_p,id)=>{
  const notifications:boolean[]=[],p=new EventPipeline(s,()=>0,{events:4,bytes:8*1024*1024,high:.75,low:.5,batch:1},x=>notifications.push(x));
  for(let i=0;i<3;i++)p.receive(id,eventAt(i));
  expect(notifications).toEqual([true]);p.flush();expect(notifications).toEqual([true,false]);
  expect(p.metrics.pauseRequests).toBe(1);
}));
it("persists a disconnect independently and cannot restore merely by reconnecting", ()=>isolated((s,p,id)=>{
  p.receive(id,eventAt(0));p.drain();
  const rc=p.reconnectController(id,["L2_MBP"],()=>ns(1));rc.disconnect();p.drain();
  expect(p.book(id)).toBeNull();rc.connected();expect(rc.synchronized(!!p.book(id))).toBe(false);
  p.receive(id,eventAt(2));p.drain();expect(p.book(id)).toBeNull();
  p.receive(id,recoveryAt(3));p.drain();expect(rc.synchronized(!!p.book(id))).toBe(true);
  expect(s.journal.records(id).some(r=>r.input.type==="CONDITION")).toBe(true);
}));
it("keeps source/session scopes separate and preserves interleaved global arrival order", ()=>isolated((s,p,id)=>{
  const cfg=config(), other={...cfg,identity:{...cfg.identity,sessionId:"MOCK-R16-OTHER"}};
  const id2=s.register(other,ns(0)),first=eventAt(0);
  p.receive(id,first);p.receive(id2,{...first,header:{...first.header,sessionId:"MOCK-R16-OTHER"}});
  p.receive(id,eventAt(2));p.drain();
  expect(s.journal.records().map(r=>r.scopeId)).toEqual([id,id2,id]);
  expect(p.book(id)).toBeNull();expect(p.book(id2)).not.toBeNull();
}));
