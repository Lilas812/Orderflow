import { expect, it } from "vitest";
import { createSequenceGuard, guardEvent, rebaseSequenceGuard } from "@workspace/core/sequence-guard";
import { C1Capture, R163Probe, fixedBoundary, observeBatches } from "./r163Diagnostics";
import { eventAt, ownedDirectory, removeOwnedDirectory, config, ns } from "./r16Fixtures";
import { StorageAdapter } from "./storageAdapter";
import { selectCommitReadForDiagnostics } from "@workspace/storage/migration";
import { EventPipeline } from "./eventPipeline";
import { CommitScheduler } from "./commitScheduler";
import { worker } from "./r16Load";
import { ipcBatch } from "./mockTransport";

it("diagnostic boundary restores the scheduler instance without changing its clock",()=>{
  let calls=0;
  class Scheduler {arm(){calls++;}}
  const scheduler=new Scheduler(), restore=fixedBoundary(scheduler);
  scheduler.arm();expect(calls).toBe(0);restore();scheduler.arm();expect(calls).toBe(1);
  expect(Object.hasOwn(scheduler,"arm")).toBe(false);
});

it("C-1 removes only the repeated metadata row decode/checksum; all originals and roots agree",async()=>{
  const run=async(reference:boolean)=>{
    const dir=ownedDirectory(),storage=new StorageAdapter(dir),scope=storage.register(config(),ns(0)),capture=new C1Capture();
    try{
      capture.attach(storage,reference);
      for(let offset=0;offset<8;offset+=4)
        storage.commit(scope,Array.from({length:4},(_,i)=>({type:"EVENT" as const,event:eventAt(offset+i,1000)})));
      capture.endIngestion();await capture.settle();
      const result=capture.report(storage);capture.detach();
      storage.journal.verify();
      return {result,inputs:storage.journal.records().map(r=>r.input)};
    }finally{capture.detach();storage.close();removeOwnedDirectory(dir);}
  };
  const before=await run(true),after=await run(false);
  for(const r of [before,after]){
    const rows=(owner:string)=>r.result.scans.filter(s=>s.phase==="ingest"&&s.owner===`${owner}/r15_records`)
      .reduce((n,s)=>n+s.rows,0);
    expect(rows("verifyMetadata")).toBe(4);expect(rows("saveStorageState")).toBe(12);
    for(const scan of r.result.scans.filter(s=>s.phase==="ingest"))
      expect([scan.decode,scan.checksum]).toEqual([scan.rows,scan.rows]);
  }
  expect(before.result.scans.filter(s=>s.phase==="ingest"&&s.owner==="liveIndices/r15_records").reduce((n,s)=>n+s.rows,0)).toBe(4);
  expect(after.result.scans.filter(s=>s.phase==="ingest"&&s.owner==="liveIndices/r15_records")).toEqual([]);
  expect((before.result.calls.ingest.decode-(before.result.sourceMapParses.ingest??0))-
    (after.result.calls.ingest.decode-(after.result.sourceMapParses.ingest??0))).toBe(6);
  expect(before.result.calls.ingest.checksum-after.result.calls.ingest.checksum).toBe(6);
  expect(after.result.guards).toHaveLength(2);expect(after.result.guards.every(g=>g.success)).toBe(true);
  expect(after.result.roots).toEqual(before.result.roots);expect(after.result.manifest).toEqual(before.result.manifest);
  expect(after.inputs).toEqual(before.inputs);
});

it("C-1 light capture restores JSON, crypto and row-map natives after failure",()=>{
  const dir=ownedDirectory(),storage=new StorageAdapter(dir),saved={parse:JSON.parse,map:Array.prototype.map};
  const capture=new C1Capture();
  try{capture.attach(storage,false);expect(()=>JSON.parse("{")).toThrow();}
  finally{capture.detach();storage.close();removeOwnedDirectory(dir);}
  expect(JSON.parse).toBe(saved.parse);expect(Array.prototype.map).toBe(saved.map);
});

it("budget refusal requests scheduler stop, retains the event, and never acknowledges commit",()=>{
  const dir=ownedDirectory(),storage=new StorageAdapter(dir),scope=storage.register(config(),ns(0));
  const pipeline=new EventPipeline(storage),failures:string[]=[],commits:number[]=[];
  const scheduler=new CommitScheduler(pipeline,scope,{policy:"coalesced",onFailure:r=>failures.push(r),
    onCommitted:r=>commits.push(r.count)});
  try{
    selectCommitReadForDiagnostics(storage.catalog,"reuse");
    storage.commit(scope,[{type:"EVENT",event:eventAt(0)}]);
    const db=storage.catalog.database,row=db.prepare("SELECT payload FROM r15_records").get() as {payload:string};
    db.prepare("UPDATE r15_records SET payload=?").run(row.payload+" ".repeat(16*1024*1024+1-Buffer.byteLength(row.payload)));
    const event=eventAt(1),events=[event];
    scheduler.accept(ipcBatch(1,events,process.hrtime.bigint().toString()));
    expect(scheduler.finish()).toBe(false);
    expect(failures).toHaveLength(1);expect(commits).toEqual([]);
    expect(scheduler.pendingEvents).toBe(1);expect(pipeline.metrics.persistedEvents).toBe(0);
    expect(pipeline.metrics.explicitlyLostEvents).toBe(0);expect(pipeline.metrics.queueDepth).toBe(1);
    expect(storage.catalog.manifest().recordCount).toBe("1");
  }finally{scheduler.dispose();storage.close();removeOwnedDirectory(dir);}
});

it("real IPC reports READ_BUDGET/STOP_REQUIRED separately from its receive acknowledgement",async()=>{
  const dir=ownedDirectory(),storage=new StorageAdapter(dir),scope=storage.register(config(),ns(0));
  storage.commit(scope,[{type:"EVENT",event:eventAt(0)}]);
  const db=storage.catalog.database,row=db.prepare("SELECT payload FROM r15_records").get() as {payload:string};
  db.prepare("UPDATE r15_records SET payload=?").run(row.payload+" ".repeat(16*1024*1024+1-Buffer.byteLength(row.payload)));
  storage.close();
  const child=worker("load:r163-c1-after-normal",dir),messages:{kind:string;reason?:string;metrics?:{persistedEvents:number;explicitlyLostEvents:number};
    scheduler?:{pendingEvents:number}}[]=[];
  const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
  child.stdout?.resume();child.stderr?.resume();
  try{
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error("C1 IPC budget timeout")),15000);
      child.on("error",reject);
      child.on("message",raw=>{
        const message=raw as typeof messages[number];messages.push(message);
        if(message.kind==="ready"){
          const events=[eventAt(1)];
          child.send(ipcBatch(1,events,process.hrtime.bigint().toString()));
        }
        if(message.kind==="storage-error"){clearTimeout(timeout);resolve();}
        if(message.kind==="fatal"){clearTimeout(timeout);reject(Error(message.reason));}
      });
    });
    expect(messages.some(m=>m.kind==="received")).toBe(true);expect(messages.some(m=>m.kind==="committed")).toBe(false);
    const failure=messages.find(m=>m.kind==="storage-error")!;
    expect(failure.reason).toMatch(/READ_BUDGET.*STOP_REQUIRED/);
    expect(failure.metrics).toMatchObject({persistedEvents:0,explicitlyLostEvents:0});
  }finally{
    child.kill("SIGTERM");await exited;
    const reopened=new StorageAdapter(dir);
    try{expect(reopened.journal.records(scope)).toHaveLength(1);}finally{reopened.close();removeOwnedDirectory(dir);}
  }
},20000);
it("fixed batch observer records only successful original commits",()=>{
  const native=(...args:unknown[])=>{if(!args[1])throw Error("write failure");return {committed:true};};
  const store={commit:native} as unknown as Pick<StorageAdapter,"commit">;
  const observed=observeBatches(store);
  expect(()=>Reflect.apply(store.commit,store,["scope",null])).toThrow("write failure");
  expect(Reflect.apply(store.commit,store,["scope",[1,2]])).toEqual({committed:true});
  expect(observed.batches).toEqual([2]);observed.detach();expect(store.commit).toBe(native);
});
it("native seen-copy counts preserve duplicate/conflict results and immutable original states",async()=>{
  const initial=createSequenceGuard(),first=eventAt(0),second=eventAt(1),rule={contiguous:true,evidence:"deterministic MOCK"};
  const expected1=guardEvent(initial,first,rule),expected2=guardEvent(expected1.state,second,rule);
  const before={Map:globalThis.Map,map:Array.prototype.map,parse:JSON.parse};
  const probe=new R163Probe();probe.attach();
  let results;
  try {
    const one=guardEvent(initial,first,rule),two=guardEvent(one.state,second,rule);
    const duplicate=guardEvent(two.state,second,rule);
    const conflict=guardEvent(two.state,{...second,header:{...second.header,receiveTimeNs:
      (BigInt(second.header.receiveTimeNs)+1n).toString()}},rule);
    const resync=guardEvent(createSequenceGuard(),first,rule);
    if(first.kind!=="L2_SNAPSHOT")throw Error("Expected MOCK snapshot");
    const rebased=rebaseSequenceGuard(createSequenceGuard(),first,rule,"MOCK alignment");
    results={one,two,duplicate,conflict,resync,rebased};
    probe.endIngestion();await probe.settle();
  }finally{probe.detach();}
  expect(globalThis.Map).toBe(before.Map);expect(Array.prototype.map).toBe(before.map);expect(JSON.parse).toBe(before.parse);
  expect(results!.one).toEqual(expected1);expect(results!.two).toEqual(expected2);
  expect(initial.seen.size).toBe(0);expect(results!.one.state.seen.size).toBe(1);
  expect(results!.duplicate.outcome).toBe("DUPLICATE");expect(results!.conflict.outcome).toBe("CONFLICT");
  expect(results!.conflict.state.seen.get([...expected2.state.seen.keys()][1])).toBe([...expected2.state.seen.values()][1]);
  expect(probe.detail().ingestSeenCopies).toBe(5);
});
it("Array.map holes/thisArg and nanosecond JSON reviver/errors are not altered",()=>{
  const probe=new R163Probe(),values=[1,,3];
  probe.attach();
  let mapped:unknown,nanoseconds:unknown;
  try{
    mapped=values.map(function(this:{n:number},v){return (v??0)*this.n;},{n:2});
    nanoseconds=JSON.parse('{"ns":"1792626182911123456"}',(_k,v)=>v);
    expect(()=>JSON.parse("{")).toThrow();
  }finally{probe.detach();}
  expect(mapped).toEqual([2,,6]);expect(nanoseconds).toEqual({ns:"1792626182911123456"});
});
it("counts real per-transaction metadata decoding and all native seen copies, without changing storage",async()=>{
  const dir=ownedDirectory(),storage=new StorageAdapter(dir),scope=storage.register(config(),ns(0));
  const probe=new R163Probe();
  const restore = selectCommitReadForDiagnostics(storage.catalog, "reference");
  try{
    probe.attach(storage);
    storage.commit(scope,Array.from({length:4},(_,i)=>({type:"EVENT" as const,event:eventAt(i,1000)})));
    storage.commit(scope,Array.from({length:4},(_,i)=>({type:"EVENT" as const,event:eventAt(i+4,1000)})));
    probe.endIngestion();await probe.settle();probe.detach();
    const detail=probe.detail(),a=detail.attribution;
    expect(detail.ingestSeenCopies).toBe(20);
    expect(detail.ingestCopiedEntries).toBe(62);
    for(const owner of ["verifyMetadata","liveIndices"]){
      expect(a[`ingest:${owner}/r15_records/json.decode`].calls).toBe(4);
      expect(a[`ingest:${owner}/r15_records/sha256.lifecycle_INCLUSIVE`].calls).toBe(4);
    }
    expect(a["ingest:saveStorageState/r15_records/json.decode"].calls).toBe(12);
    expect(a["ingest:saveStorageState/r15_records/sha256.lifecycle_INCLUSIVE"].calls).toBe(12);
    storage.journal.verify();expect(storage.catalog.manifest().recordCount).toBe("8");
  }finally{probe.detach();restore();storage.close();removeOwnedDirectory(dir);}
});
