import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitScheduler } from "./commitScheduler";
import { ipcBatch, IpcCredits } from "./mockTransport";
import { eventAt, deterministicDeliveries, config, ns, ownedDirectory, removeOwnedDirectory } from "./r16Fixtures";
import { EventPipeline } from "./eventPipeline";
import { StorageAdapter } from "./storageAdapter";
import { checksum } from "@workspace/storage/catalog";
import { worker, processRss, validateFixedTrace, loadOffering } from "./r16Load";
import type { MarketEvent } from "@workspace/core/events";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(()=>vi.useRealTimers());
function fake() {
  let now=0,fail=false;
  const staged:MarketEvent[]=[],stored:MarketEvent[]=[],transactions:number[]=[],receipts:number[]=[],commits:number[]=[];
  const p={receive:(_s:string,e:unknown)=>{staged.push(e as MarketEvent);return true;},drain:()=>{
    if(fail)return false;transactions.push(staged.length);stored.push(...staged.splice(0));now+=4;return true;
  }};
  const s=new CommitScheduler(p,"test",{policy:"coalesced",clock:()=>now,
    onReceived:r=>receipts.push(r.id),onCommitted:r=>commits.push(r.id)});
  const frame=(id:number,start:number,count:number)=>ipcBatch(id,Array.from({length:count},(_,i)=>eventAt(start+i)));
  return {s,stored,transactions,receipts,commits,frame,setNow:(n:number)=>{now=n;},setFail:(b:boolean)=>{fail=b;}};
}
describe("whole-frame commit scheduling",()=>{
  it("flushes exactly 128 immediately and acknowledges receipt before commit",()=>{
    const h=fake();expect(h.s.accept(h.frame(1,0,128))).toBe(true);
    expect(h.transactions).toEqual([128]);expect(h.receipts).toEqual([1]);expect(h.commits).toEqual([1]);
    expect(h.s.snapshot()).toMatchObject({committedGroups:1,meanTransactionEvents:128,maxCommittedTransactionEvents:128,pendingEvents:0});
    h.s.dispose();
  });
  it("combines multiple whole IPC frames to exactly 128",()=>{
    const h=fake();h.s.accept(h.frame(1,0,64));expect(h.commits).toEqual([]);
    h.s.accept(h.frame(2,64,64));expect(h.transactions).toEqual([128]);expect(h.commits).toEqual([1,2]);h.s.dispose();
  });
  it("flushes the maximal whole-frame prefix without creating a 140-event transaction",()=>{
    const h=fake();h.s.accept(h.frame(1,0,80));h.s.accept(h.frame(2,80,60));
    expect(h.transactions).toEqual([80]);expect(h.s.pendingEvents).toBe(60);
    h.s.finish();expect(h.transactions).toEqual([80,60]);
    expect(h.stored.map(e=>e.header.eventId)).toEqual(Array.from({length:140},(_,i)=>eventAt(i).header.eventId));
  });
  it.each([0,129])("explicitly rejects a %i-event IPC frame before taking ownership",count=>{
    const h=fake();expect(()=>h.s.accept(h.frame(1,0,count))).toThrow("IPC_NOT_ADMITTED");
    expect(h.s.pendingEvents).toBe(0);expect(h.receipts).toEqual([]);expect(h.stored).toEqual([]);h.s.dispose();
  });
  it("requests at the first pending event's 10ms deadline, not ten ms after the newest arrival",()=>{
    vi.useFakeTimers();const h=fake();h.s.accept(h.frame(1,0,1));
    h.setNow(5);vi.advanceTimersByTime(5);h.s.accept(h.frame(2,1,1));
    expect(h.commits).toEqual([]);h.setNow(10);vi.advanceTimersByTime(5);
    expect(h.transactions).toEqual([2]);
    expect(h.s.snapshot()).toMatchObject({
      firstEventToFlushRequestMs:{meanMs:10},requestToFlushStartMs:{meanMs:0},
      firstEventToFlushStartMs:{meanMs:10},firstEventToCommitMs:{meanMs:14},
      eventToCommitMs:{meanMs:11.5},timerRequestLatenessMs:{meanMs:0},
    });h.s.dispose();
  });
  it("records a late event-loop request rather than pretending the timer fired at 10ms",()=>{
    vi.useFakeTimers();const h=fake();h.s.accept(h.frame(1,0,2));h.setNow(27);vi.advanceTimersByTime(10);
    expect(h.s.snapshot()).toMatchObject({firstEventToFlushRequestMs:{meanMs:27},timerRequestLatenessMs:{meanMs:17},
      firstEventToCommitMs:{meanMs:31}});h.s.dispose();
  });
  it("flushes remaining input immediately at EOF and cancels the timer",()=>{
    vi.useFakeTimers();const h=fake();h.s.accept(h.frame(1,0,3));h.s.finish();
    expect(h.transactions).toEqual([3]);h.setNow(100);vi.advanceTimersByTime(100);expect(h.transactions).toEqual([3]);
    expect(()=>h.s.accept(h.frame(2,3,1))).toThrow("IPC_NOT_ADMITTED");
  });
  it("retains a failed group's ownership and retries without re-enqueueing or reapplying it",()=>{
    const h=fake();h.setFail(true);expect(h.s.accept(h.frame(1,0,128))).toBe(false);
    expect(h.s.snapshot()).toMatchObject({pendingEvents:128,committedEvents:0,failures:1});expect(h.commits).toEqual([]);
    expect(()=>h.s.accept(h.frame(2,128,1))).toThrow("IPC_NOT_ADMITTED");
    h.setFail(false);expect(h.s.retry()).toBe(true);expect(h.s.retry()).toBe(true);
    expect(h.stored).toHaveLength(128);expect(h.commits).toEqual([1]);expect(h.transactions).toEqual([128]);h.s.dispose();
  });
  it("distinguishes receipt credits from durable commit credits",()=>{
    const credit=new IpcCredits(),h=fake(),frame=h.frame(1,0,1);
    credit.reserve(frame.id,frame.events.length,frame.bytes);h.s.accept(frame);credit.received(1);
    expect(credit.snapshot()).toMatchObject({outstandingEvents:1,unconfirmedSendEvents:0});
    expect(h.stored).toHaveLength(0);h.s.finish();credit.committed(1);expect(credit.count).toBe(0);
  });
  it("rejects event and byte capacity overflow explicitly, leaving the existing frame intact",()=>{
    const h=fake(),s=new CommitScheduler({receive:()=>true,drain:()=>true},"test",
      {policy:"coalesced",clock:()=>0,maxPendingEvents:2,maxPendingBytes:100});
    s.accept({...h.frame(1,0,2),bytes:90});
    expect(()=>s.accept({...h.frame(2,2,1),bytes:5})).toThrow("IPC_NOT_ADMITTED");
    expect(s.snapshot()).toMatchObject({pendingEvents:2,pendingBytes:90,rejectedEvents:1});
    const bytesOnly=new CommitScheduler({receive:()=>true,drain:()=>true},"test",
      {policy:"coalesced",clock:()=>0,maxPendingBytes:100});
    bytesOnly.accept({...h.frame(1,0,1),bytes:90});
    expect(()=>bytesOnly.accept({...h.frame(2,1,1),bytes:11})).toThrow("IPC_NOT_ADMITTED");
    expect(bytesOnly.pendingEvents).toBe(1);bytesOnly.dispose();s.dispose();h.s.dispose();
  });
  it("owns a private input copy while waiting",()=>{
    const h=fake(),frame=h.frame(1,0,1);h.s.accept(frame);Reflect.set((frame.events[0] as MarketEvent).header,"eventId","caller mutation");
    h.s.finish();expect(h.stored[0].header.eventId).toBe(eventAt(0).header.eventId);
  });
  it("keeps the immediate comparison flag as one transaction per IPC frame",()=>{
    const h=fake(),s=new CommitScheduler({receive:()=>true,drain:()=>true},"test",{policy:"immediate",clock:()=>0});
    s.accept(h.frame(1,0,3));s.accept(h.frame(2,3,5));
    expect(s.snapshot()).toMatchObject({committedGroups:2,meanTransactionEvents:4,maxCommittedTransactionEvents:5});
    s.dispose();h.s.dispose();
  });
  it("does not permit enlarged safety limits",()=>{
    for(const options of [{maxPendingEvents:2049},{maxPendingBytes:8*1024*1024+1}])
      expect(()=>new CommitScheduler({receive:()=>true,drain:()=>true},"test",{policy:"coalesced",...options})).toThrow();
  });
  it("rejects duplicate IPC IDs before admission",()=>{
    const h=fake();h.s.accept(h.frame(1,0,2));expect(()=>h.s.accept(h.frame(1,0,2))).toThrow();
    h.s.finish();expect(h.stored).toHaveLength(2);
  });
});
it("preserves actual FULL/WAL atomic rollback, then retries the same owned 128 events",()=>{
  const dir=ownedDirectory(),storage=new StorageAdapter(dir),scope=storage.register(config(),ns(0)),p=new EventPipeline(storage);
  const ack:number[]=[],s=new CommitScheduler(p,scope,{policy:"coalesced",onCommitted:r=>ack.push(r.id)});
  try {
    storage.beforeCommit=()=>{throw Error("injected failure");};
    expect(s.accept(ipcBatch(1,Array.from({length:128},(_,i)=>eventAt(i))))).toBe(false);
    expect(storage.catalog.manifest().recordCount).toBe("0");expect(p.metrics.persistedEvents).toBe(0);
    expect(ack).toEqual([]);expect(s.pendingEvents).toBe(128);expect(p.metrics.queueDepth).toBe(128);
    storage.beforeCommit=undefined;expect(s.retry()).toBe(true);
    expect(storage.catalog.manifest().recordCount).toBe("128");expect(p.metrics.persistedEvents).toBe(128);
    expect(ack).toEqual([1]);expect(storage.catalog.database.pragma("synchronous",{simple:true})).toBe(2);
    expect(storage.catalog.database.pragma("journal_mode",{simple:true})).toBe("wal");
    expect(storage.journal.records(scope).map(r=>r.input)).toEqual(Array.from({length:128},(_,i)=>({type:"EVENT",event:eventAt(i)})));
  }finally{s.dispose();storage.close();removeOwnedDirectory(dir);}
});
it("keeps 1010 deliveries / 1000 unique / 10 duplicates and the canonical input checksum",()=>{
  const dir=ownedDirectory(),storage=new StorageAdapter(dir),scope=storage.register(config(),ns(0)),p=new EventPipeline(storage);
  const s=new CommitScheduler(p,scope,{policy:"coalesced"}),events=deterministicDeliveries();
  try{
    for(let i=0,id=1;i<events.length;i+=64,id++)s.accept(ipcBatch(id,events.slice(i,i+64)));
    expect(s.finish()).toBe(true);
    expect(p.metrics.snapshot()).toMatchObject({receivedEvents:1010,persistedEvents:1000,appliedEvents:1000,duplicateEvents:10,auditRecords:1010});
    expect(checksum(storage.journal.records(scope).map(r=>r.input))).toBe(checksum(events.map(event=>({type:"EVENT",event}))));
    expect(s.snapshot()).toMatchObject({committedGroups:8,maxCommittedTransactionEvents:128,pendingEvents:0});
  }finally{s.dispose();storage.close();removeOwnedDirectory(dir);}
},30_000);
it.each([
  {batches:[{atMs:0,count:129}]},{batches:[{atMs:1,count:1},{atMs:0,count:1}]},
  {batches:[{atMs:100,count:1}]},{batches:Array.from({length:17},()=>({atMs:0,count:128}))},
])("rejects unsafe or non-FIFO fixed comparison traces: %j",trace=>{
  expect(()=>validateFixedTrace(trace,100)).toThrow();
});
it.each([
  {elapsed:150,remaining:1,expected:{canOffer:true,canEnd:false}},
  {elapsed:150,remaining:0,expected:{canOffer:false,canEnd:true}},
  {elapsed:150,remaining:null,expected:{canOffer:false,canEnd:true}},
])("preserves fixed input counts under late IPC dispatch but keeps the natural offering window: %j",c=>{
  expect(loadOffering(c.elapsed,100,c.remaining)).toEqual(c.expected);
});

/** The same finite worker, not a new worker implementation/service. Strict temporary DB + safety caps. */
async function runChild(mode:string,dir:string,onMessage?:(m:Record<string,any>,c:ChildProcess)=>void,expectCrash=false) {
  const c=worker(mode,dir),messages:Record<string,any>[]=[];let failure="",stderr="",complete=false;
  c.stdout?.resume();c.stderr?.on("data",x=>{stderr=(stderr+String(x)).slice(-8192);});
  return await new Promise<{messages:Record<string,any>[];signal:NodeJS.Signals|null}>((resolve,reject)=>{
    const timer=setTimeout(()=>{failure="30s integration budget";c.kill("SIGKILL");},30_000);
    const memory=setInterval(()=>{
      if(complete)return; // Completed summary received; only finite process teardown remains.
      try{if(processRss(c.pid!)>512*1024*1024 || processRss(c.pid!)+processRss(process.pid)>768*1024*1024)
        {failure="RSS limit";c.kill("SIGKILL");}}
      catch(error){
        // The crash probe deliberately kills a process while SQLite has an open transaction.
        // /proc may lose VmRSS before Node emits exit (even before State becomes Z).
        // Only this positively evidenced crash path may complete the intended SIGKILL here.
        let insideCrashTransaction=false;
        if(expectCrash)try{insideCrashTransaction=readFileSync(join(dir,"r161-commit-open.marker"),"utf8")==="R16.1 TEST BEFORE COMMIT";}catch{}
        if(insideCrashTransaction){c.kill("SIGKILL");return;}
        // A zombie/already-reaped PID has no RSS and consumes no resident memory.
        // Node's exit event may follow the /proc transition; do not confuse it with a live measurement failure.
        let dead=false;
        try{dead=/^State:\s+[ZX]/m.test(readFileSync(`/proc/${c.pid}/status`,"utf8"));}
        catch(e){dead=(e as NodeJS.ErrnoException).code==="ENOENT";}
        if(!dead && c.exitCode===null && c.signalCode===null){failure=`RSS unavailable for live worker: ${error}`;c.kill("SIGKILL");}
      }
    },10);
    c.on("message",raw=>{
      const m=raw as Record<string,any>;messages.push(m);
      if(m.kind==="result")complete=true;
      try{onMessage?.(m,c);}catch(e){failure=String(e);c.kill("SIGKILL");}
    });
    c.on("error",e=>{failure=String(e);});
    c.on("exit",(code,signal)=>{
      clearInterval(memory);clearTimeout(timer);
      if(failure || (code!==0 && signal!=="SIGKILL"))reject(Error(failure||`worker ${code}/${signal}: ${stderr}`));
      else resolve({messages,signal});
    });
  });
}
it("finite IPC distinguishes receipt from commit and recovers a failed group on explicit retry",async()=>{
  const dir=ownedDirectory();
  try{
    const r=await runChild("scheduler-test",dir,(m,c)=>{
      if(m.kind==="ready")c.send({kind:"fail-next"});
      if(m.kind==="armed")c.send(ipcBatch(1,[eventAt(0),eventAt(1)],process.hrtime.bigint().toString()));
      if(m.kind==="received")expect(m).toMatchObject({id:1,count:2});
      if(m.kind==="storage-error"){
        expect(m.metrics.persistedEvents).toBe(0);expect(m.scheduler.pendingEvents).toBe(2);c.send({kind:"retry"});
      }
      if(m.kind==="committed"){expect(m.metrics.persistedEvents).toBe(2);c.send({kind:"finish"});}
    });
    expect(r.messages.filter(m=>m.kind==="received")).toHaveLength(1);
    expect(r.messages.filter(m=>m.kind==="committed")).toHaveLength(1);
    const result=r.messages.find(m=>m.kind==="result");
    expect(result).toMatchObject({auditCount:2,uniqueAccepted:2,committedCursor:"2"});
    expect(result?.auditHash).toBe(checksum([eventAt(0),eventAt(1)].map(event=>({type:"EVENT",event}))));
  }finally{removeOwnedDirectory(dir);}
},30_000);
it("SIGKILL inside a coalesced transaction restores the committed prefix, then resends without double application",async()=>{
  const dir=ownedDirectory();
  try{
    const killed=await runChild("scheduler-test",dir,(m,c)=>{
      if(m.kind==="ready") {
        c.send(ipcBatch(1,Array.from({length:64},(_,i)=>eventAt(i)),process.hrtime.bigint().toString()));
        c.send(ipcBatch(2,Array.from({length:64},(_,i)=>eventAt(i+64)),process.hrtime.bigint().toString()));
      }
      if(m.kind==="committed" && m.id===2)c.send({kind:"arm-crash"});
      if(m.kind==="armed"){
        c.send(ipcBatch(3,[eventAt(128)],process.hrtime.bigint().toString()));
        c.send(ipcBatch(4,[eventAt(129)],process.hrtime.bigint().toString()));c.send({kind:"finish"});
      }
    },true);
    expect(killed.signal).toBe("SIGKILL");
    expect(readFileSync(join(dir,"r161-commit-open.marker"),"utf8")).toBe("R16.1 TEST BEFORE COMMIT");
    expect(killed.messages.filter(m=>m.kind==="committed").map(m=>m.id)).toEqual([1,2]);
    const restored=(await runChild("restore",dir)).messages.find(m=>m.kind==="result")!;
    expect(restored).toMatchObject({auditCount:128,uniqueAccepted:128,committedCursor:"128",finalBidQty:41});
    expect(restored.auditHash).toBe(checksum(Array.from({length:128},(_,i)=>({type:"EVENT",event:eventAt(i)}))));
    const resumed=(await runChild("scheduler-test",dir,(m,c)=>{
      if(m.kind==="ready"){c.send(ipcBatch(1,[eventAt(128),eventAt(129)],process.hrtime.bigint().toString()));c.send({kind:"finish"});}
    })).messages.find(m=>m.kind==="result")!;
    expect(resumed).toMatchObject({auditCount:130,uniqueAccepted:130,committedCursor:"130"});
    expect(resumed.auditHash).toBe(checksum(Array.from({length:130},(_,i)=>({type:"EVENT",event:eventAt(i)}))));
  }finally{removeOwnedDirectory(dir);}
},30_000);
