import { expect, it } from "vitest";
import { createSequenceGuard, guardEvent, rebaseSequenceGuard } from "@workspace/core/sequence-guard";
import { R163Probe, fixedBoundary, observeBatches } from "./r163Diagnostics";
import { eventAt, ownedDirectory, removeOwnedDirectory, config, ns } from "./r16Fixtures";
import { StorageAdapter } from "./storageAdapter";

it("diagnostic boundary restores the scheduler instance without changing its clock",()=>{
  let calls=0;
  class Scheduler {arm(){calls++;}}
  const scheduler=new Scheduler(), restore=fixedBoundary(scheduler);
  scheduler.arm();expect(calls).toBe(0);restore();scheduler.arm();expect(calls).toBe(1);
  expect(Object.hasOwn(scheduler,"arm")).toBe(false);
});
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
  }finally{probe.detach();storage.close();removeOwnedDirectory(dir);}
});
