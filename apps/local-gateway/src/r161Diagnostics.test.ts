import { expect,it } from "vitest";
import { DiagnosticTrace } from "./r161Diagnostics";
import { StorageAdapter } from "./storageAdapter";
import { EventPipeline } from "./eventPipeline";
import { config,deterministicDeliveries,eventAt,ns,ownedDirectory,removeOwnedDirectory } from "./r16Fixtures";
import { checksum } from "@workspace/storage/catalog";

it("records bounded exact timing statistics without swallowing errors",()=>{
  const trace=new DiagnosticTrace();for(let i=1;i<=100;i++)trace.add("test",i);
  expect(trace.report().timings.test).toMatchObject({count:100,totalMs:5050,meanMs:50.5,p95Ms:95,p99Ms:99});
  expect(()=>trace.measure("failure",()=>{throw Error("original");})).toThrow("original");
  expect(trace.report().timings.failure.count).toBe(1);
});
it("diagnostic wrappers preserve audit bytes, commit counts and FULL/WAL",()=>{
  const dir=ownedDirectory(),storage=new StorageAdapter(dir),trace=new DiagnosticTrace();
  try {
    const id=storage.register(config(),ns(0));trace.attach(storage);
    const p=new EventPipeline(storage);p.trace=trace;
    for(const e of deterministicDeliveries())p.receive(id,e);
    expect(p.drain()).toBe(true);
    expect(p.metrics.snapshot()).toMatchObject({receivedEvents:1010,appliedEvents:1000,duplicateEvents:10,persistedEvents:1000});
    expect(trace.report().counters["sqlite.committed_transactions"]).toBe(8);
    expect(trace.report().counters["journal.replay.historical_record_visits"]).toBe(3584);
    expect(checksum(storage.journal.records(id).map(r=>r.input)))
      .toBe(checksum(deterministicDeliveries().map(event=>({type:"EVENT",event}))));
    expect(storage.catalog.database.pragma("synchronous",{simple:true})).toBe(2);
    expect(storage.catalog.database.pragma("journal_mode",{simple:true})).toBe("wal");
    expect(trace.report().timings["sqlite.commit_sync_and_return"].count).toBe(8);
  }finally{trace.detach();storage.close();removeOwnedDirectory(dir);}
},30_000);
it("separates committed transactions from rollback and detaches without changing semantics",()=>{
  const dir=ownedDirectory(),s=new StorageAdapter(dir),t=new DiagnosticTrace();
  try{
    const id=s.register(config(),ns(0));t.attach(s);s.beforeCommit=()=>{throw Error("disk");};
    expect(()=>s.commit(id,[{type:"EVENT",event:eventAt(0)}])).toThrow("disk");
    expect(t.report().counters["sqlite.committed_transactions"]??0).toBe(0);
    expect(t.report().timings["sqlite.rollback_and_return"].count).toBe(1);
    t.detach();s.trace=undefined;s.beforeCommit=undefined;
    expect(s.commit(id,[{type:"EVENT",event:eventAt(0)}]).lastPosition).toBe("1");
  }finally{s.close();removeOwnedDirectory(dir);}
});
