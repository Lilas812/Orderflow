import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checksum, SqliteCatalog } from "@workspace/storage/catalog";
import { SegmentWriter } from "@workspace/storage/segments";
import { RangeQuery } from "@workspace/storage/range";
import { EventPipeline } from "./eventPipeline";
import { StorageAdapter } from "./storageAdapter";
import { config, deterministicDeliveries, eventAt, ns, requireOwnedDirectory } from "./r16Fixtures";
import type { MarketEvent } from "@workspace/core/events";
import { Latencies } from "./metrics";
import { CommitScheduler } from "./commitScheduler";
import { PerformanceObserver } from "node:perf_hooks";
import { selectCommitReadForDiagnostics, storageState } from "@workspace/storage/migration";
import type { FiniteSeenRun } from "./storageAdapter";

const [mode,dir]=process.argv.slice(2);
const seenLoad=mode==="load:r165-fixed-immutable"||mode==="load:r165-fixed-owned";
const seenCrash=/^r165-crash-(owned|immutable)-(before|transaction|window|publish)$/.test(mode);
let finite:FiniteSeenRun|undefined;
if(seenLoad) {
  const encoded=process.argv[4]??"";
  if(Buffer.byteLength(encoded)>64*1024)throw Error("Startup control too large");
  const payload=JSON.parse(encoded) as {run:FiniteSeenRun;trace:{batches:{atMs:number;count:number}[]}};
  if(!payload.trace || !Array.isArray(payload.trace.batches) || payload.trace.batches.length>2048 ||
    payload.trace.batches.some(b=>!Number.isFinite(b.atMs)||b.atMs<0||b.atMs>=1000||![2,4].includes(b.count)) ||
    payload.trace.batches.reduce((n,b)=>n+b.count,0)!==payload.run.eventLimit ||
    checksum(payload.trace)!==payload.run.traceHash ||
    payload.run.mode!==(mode.endsWith("-owned")?"owned":"immutable"))throw Error("Unverified fixed MOCK startup");
  finite=payload.run;
} else if(seenCrash)finite={mode:mode.includes("-owned-")?"owned":"immutable",eventLimit:100,
  traceHash:checksum("R165 CRASH TEST"),c1Mode:"reference",boundary:"fixed"};
requireOwnedDirectory(dir);
if(mode==="cursor") {
  const c=new SqliteCatalog(join(dir,"events.r16.sqlite"));
  process.send?.({kind:"cursor",manifest:c.manifest()});
  c.close();process.disconnect?.();
} else {
const gc={count:0,ms:0,kinds:{} as Record<string,number>};
const gcObserver=seenLoad?new PerformanceObserver(list=>{
  for(const entry of list.getEntries()) {
    gc.count++;gc.ms+=entry.duration;
    const kind=String((entry as unknown as {detail:{kind:number}}).detail.kind);
    gc.kinds[kind]=(gc.kinds[kind]??0)+1;
  }
}):null;
gcObserver?.observe({entryTypes:["gc"]});
const storage=new StorageAdapter(dir,finite?{finiteSeen:finite}:{}), scope=storage.register(config(),ns(0));
if(finite)selectCommitReadForDiagnostics(storage.catalog,"reference");
const pipeline=new EventPipeline(storage);
const transportLatency=new Latencies();
const initialCpu=process.cpuUsage();
const diagnostics=["load:timing","load:cpu","load:r162-cpu"].includes(mode)?await import("./r161Diagnostics"):null;
const r163=mode==="load:r163-trace"?new (await import("./r163Diagnostics")).R163Probe():null;
const research=["load:r162-timing","load:r162-snapshot"].includes(mode)?
  new (await import("./r162Diagnostics")).ResearchProbe():r163;
const c1Mode=mode.startsWith("load:r163-c1-");
const c1=c1Mode?new (await import("./r163Diagnostics")).C1Capture():null;
const fixed=mode.startsWith("load:r163-")&&(!c1Mode||mode.endsWith("-fixed"))?await import("./r163Diagnostics"):null;
const batchObserver=fixed?fixed.observeBatches(storage):null;
const indexComparison=c1Mode||["load:r162-e-find","load:r162-e-map","load:r163-fixed-find","load:r163-fixed-map"].includes(mode)?
  new (await import("./r162Diagnostics")).IndexComparisonCapture():null;
if(indexComparison)indexComparison.attach(storage,mode.endsWith("-find")?"find-reference":"map");
if(c1)c1.attach(storage,mode.includes("-before-"));
const trace=mode==="load:timing"?new diagnostics!.DiagnosticTrace():research;
const cpu=["load:cpu","load:r162-cpu"].includes(mode)?new diagnostics!.CpuCapture():null;
if(trace){trace.attach(storage);pipeline.trace=trace;}
if(cpu)await cpu.start();
const timed=<T,>(name:string,operation:()=>T):T=>trace?trace.measure(name,operation):operation();
function sizes(path: string): {db:number;wal:number;chunks:number;total:number} {
  const result={db:0,wal:0,chunks:0,total:0};
  for(const entry of readdirSync(path,{withFileTypes:true})) {
    const file=join(path,entry.name);
    if(entry.isDirectory()) {
      const child=sizes(file); result.chunks+=child.total; result.total+=child.total;
    } else {
      const bytes=statSync(file).size; result.total+=bytes;
      if(entry.name.endsWith(".sqlite")) result.db+=bytes;
      else if(entry.name.endsWith("-wal")) result.wal+=bytes;
    }
  }
  return result;
}
function summary(withChunk: boolean) {
  const start=performance.now(), records=timed("summary.audit_read",()=>storage.journal.records(scope));
  trace?.sampleMemory("summary_after_audit_read");
  const rawReadMs=performance.now()-start;
  let chunkWriteMs: number | null=null, chunkBytes=0;
  if(withChunk && records.length) {
    const begin=performance.now();
    const segment=timed("summary.chunk_write_checksum",()=>new SegmentWriter(storage.journal).write(scope,"L2_MBP",records.map(r=>r.position)));
    chunkWriteMs=performance.now()-begin; chunkBytes=segment.bytes;
  }
  const queryStart=performance.now();
  const maxEventNs=records.reduce((max,r)=>BigInt(r.eventNs ?? r.receiveNs)>max?BigInt(r.eventNs ?? r.receiveNs):max,BigInt(ns(0)));
  const query=timed("summary.range_snapshot_read",()=>new RangeQuery(storage.journal).query(scope,"L2_MBP",ns(0),
    (maxEventNs+1n).toString()));
  const rangeQueryMs=performance.now()-queryStart;
  const restoreStart=performance.now(); const restored=timed("summary.restore",()=>storage.journal.replay(scope));
  const restoreMs=performance.now()-restoreStart;
  return { metrics:pipeline.metrics.snapshot(), auditCount:records.length,
    auditHash:timed("summary.audit_checksum",()=>checksum(records.map(r=>r.input))), committedCursor:storage.catalog.manifest().recordCount,
    finalBidQty:restored.lastGoodBook.bids.get(80000) ?? null,
    uniqueAccepted:records.filter(r=>r.applied).length,
    rangeQueryMs, rangeStatus:query.status,rangeFaults:query.faults,rangeRecords:query.records.length, rawReadMs, restoreMs, chunkWriteMs,chunkBytes,
    transportToCommitLatencyMs:transportLatency.report(),
    disk:sizes(dir), cpu:process.cpuUsage(initialCpu), memory:process.memoryUsage(), resourceUsage:process.resourceUsage(),
    sqlite:storage.catalog.database.prepare("SELECT sqlite_version() AS version").get(),
    ...(finite?{seen:{mode:finite.mode,c1Mode:"reference",copies:storage.seenObservations,
      transactions:storage.commitObservations,gc,heapUsed:process.memoryUsage().heapUsed,
      stateHash:checksum(restored),journalHead:storage.catalog.manifest().head,
      indexRoot:(awaitlessStorageState()).indexRoot,inputHash:checksum(records.map(r=>r.input))}}:{}),
  };
}
function awaitlessStorageState() {
  // Read only, existing v2 storage proof; no new checksum or schema.
  return storageState(storage.catalog);
}
function send(value: object) { process.send?.(value); }
if(seenCrash) {
  pipeline.receive(scope,eventAt(0));if(!pipeline.drain())throw Error("Crash seed failed");
  pipeline.receive(scope,eventAt(1));
  if(mode.endsWith("-before"))process.kill(process.pid,"SIGKILL");
  if(mode.endsWith("-transaction"))storage.beforeCommit=()=>process.kill(process.pid,"SIGKILL");
  if(mode.endsWith("-publish"))storage.beforePublish=()=>process.kill(process.pid,"SIGKILL");
  if(mode.endsWith("-window"))storage.beforeCommit=()=>send({kind:"commit-window"});
  pipeline.drain();
  if(mode.endsWith("-window"))setInterval(()=>{},1000);
} else if(mode==="restore") {
  send({kind:"result",...summary(false)}); storage.close(); process.disconnect?.();
} else if(mode==="fixture" || mode==="crash") {
  const deliveries=deterministicDeliveries();
  for(const e of deliveries) pipeline.receive(scope,e);
  if(!pipeline.drain()) throw new Error("Fixture commit failed");
  if(mode==="crash") {
    send({kind:"committed",count:1010,position:pipeline.metrics.lastPersistedPosition});
    process.on("message", message=>{
      if((message as {kind:string}).kind!=="crash-now") return;
      pipeline.receive(scope,eventAt(1000));
      storage.beforeCommit=()=>{process.kill(process.pid,"SIGKILL");};
      pipeline.drain(); throw new Error("SIGKILL did not happen");
    });
  } else {
    send({kind:"result",...summary(true)}); storage.close(); process.disconnect?.();
  }
} else if(seenLoad||c1Mode||["load","load:timing","load:cpu","load:coalesced","scheduler-test","load:r162-timing","load:r162-cpu","load:r162-snapshot","load:r162-e-find","load:r162-e-map","load:r163-fixed-find","load:r163-fixed-map","load:r163-trace"].includes(mode)) {
  let nextId=1, finishing=false;
  const scheduler=new CommitScheduler(pipeline,scope,{
    policy:mode==="load:coalesced" || mode==="scheduler-test" || /^load:r16[235]-/.test(mode)?"coalesced":"immediate",
    onReceived:receipt=>send({kind:"received",id:receipt.id,count:receipt.count,bytes:receipt.bytes,
      transitMs:Number(process.hrtime.bigint()-BigInt(receipt.submittedMonoNs))/1e6}),
    onFailure:reason=>send({kind:"storage-error",
      reason:c1?.guards.at(-1)?.error??reason,
      metrics:pipeline.metrics.snapshot(),scheduler:scheduler.snapshot()}),
    onCommitted:receipt=>{
      const transportMs=Number(process.hrtime.bigint()-BigInt(receipt.submittedMonoNs))/1e6;
      for(let i=0;i<receipt.count;i++)transportLatency.add(transportMs);
      const m=pipeline.metrics,ackStarted=performance.now();
      send({kind:"committed",id:receipt.id,ackMonoNs:process.hrtime.bigint().toString(),cpu:process.cpuUsage(initialCpu),metrics:{
        receivedEvents:m.receivedEvents,acceptedEvents:m.acceptedEvents,appliedEvents:m.appliedEvents,
        persistedEvents:m.persistedEvents,auditRecords:m.auditRecords,explicitlyLostEvents:m.explicitlyLostEvents,
        duplicateEvents:m.duplicateEvents,queueDepth:m.queueDepth,peakQueueDepth:m.peakQueueDepth,
        lastPersistedPosition:m.lastPersistedPosition,
      }});
      trace?.add("worker.commit_ack_send_synchronous",performance.now()-ackStarted);
    },
  });
  const restoreBoundary=fixed?.fixedBoundary(scheduler);
  // Only the finite comparison disables timer requests; whole IPC frames still use capacity/end flush.
  const internals=scheduler as unknown as {arm():void};
  if(seenLoad)internals.arm=()=>{};
  process.on("message", async raw=>{
    try {
    const message=raw as {kind:string;id:number;events:MarketEvent[];bytes:number;submittedMonoNs:string};
    if(message.kind==="batch") {
      const receivedMs=performance.now();
      if(finishing || message.id!==nextId || !Array.isArray(message.events) || message.events.length<1 || message.events.length>128 ||
        Buffer.byteLength(JSON.stringify(message),"utf8")!==message.bytes || message.bytes>8*1024*1024 ||
        !/^[0-9]+$/.test(message.submittedMonoNs) || BigInt(message.submittedMonoNs)>process.hrtime.bigint())
        throw new Error("Invalid or out-of-order bounded IPC batch");
      nextId++;scheduler.accept(message,receivedMs);
    } else if(mode==="scheduler-test" && message.kind==="fail-next") {
      storage.beforeCommit=()=>{storage.beforeCommit=undefined;throw Error("R16.1 injected write failure");};
      send({kind:"armed"});
    } else if(mode==="scheduler-test" && message.kind==="arm-crash") {
      storage.beforeCommit=()=>{
        // Bounded test-only evidence: this callback runs INSIDE the existing SQLite transaction.
        // It is not a persistence record or a new storage format.
        writeFileSync(join(dir,"r161-commit-open.marker"),"R16.1 TEST BEFORE COMMIT",{mode:0o600});
        process.kill(process.pid,"SIGKILL");
      };
      send({kind:"armed"});
    } else if(mode==="scheduler-test" && message.kind==="retry") {
      scheduler.retry();
    } else if(message.kind==="finish") {
      finishing=true;
      if(!scheduler.finish())return;
      if(seenLoad){await new Promise<void>(resolve=>setImmediate(resolve));gcObserver?.disconnect();}
      const profile=cpu?await cpu.stop(dir):null;
      r163?.endIngestion();
      c1?.endIngestion();
      trace?.sampleMemory("after_ingestion_before_gc");
      const gc=(globalThis as {gc?:()=>void}).gc;
      if(trace && gc){gc();trace.sampleMemory("after_ingestion_after_diagnostic_gc");}
      if(indexComparison){indexComparison.sample("after_ingestion");indexComparison.phase="summary";}
      let snapshotAux: {captured:boolean;status:string;recoveredStatus:string} | null=null;
      if(research)research.phase="snapshot_aux";
      if(mode==="load:r162-snapshot"||r163) {
        const {SnapshotStore}=await import("@workspace/storage/snapshots");
        const snapshots=new SnapshotStore(storage.journal);
        const captured=snapshots.capture(scope,storage.latestPersistedTime!);
        const recovered=snapshots.recover(scope,storage.latestPersistedTime!);
        snapshotAux={captured:captured.captured,status:captured.status,recoveredStatus:recovered.status};
      }
      if(research)research.phase="summary";
      if(c1)c1.phase="summary";
      const result=summary(true);
      indexComparison?.sample("after_summary");
      trace?.sampleMemory("after_summary");
      const retained={guardSeenEntries:[...storage.states.values()].reduce((n,s)=>n+s.guard.seen.size,0),
        tradeRawReferences:[...storage.trades.values()].reduce((n,s)=>n+s.rawEvents.length,0),
        queueDepth:pipeline.metrics.queueDepth,queueBytes:pipeline.metrics.queueBytes};
      const owners=research?.owners(storage);
      if(research)await research.settle();
      if(c1)await c1.settle();
      send({kind:"result",...result,scheduler:scheduler.snapshot(),...(seenLoad?{diagnostics:{seen:result.seen}}:{}),...(diagnostics||research||indexComparison?{diagnostics:{trace:trace?.report(),profile,retained,owners,snapshotAux,
        indexComparison:indexComparison?.report(storage),
        c1:c1?.report(storage),
        fixedBatches:batchObserver?.batches,r163:r163?.detail(),
        snapshotWrites:snapshotAux?.captured?1:0,
        tradeDedupCalls:mode==="load:timing"?(trace as import("./r161Diagnostics").DiagnosticTrace).report().timings["candidate.trade_dedup"]?.count??0:null,
        renderNotifications:"NOT EXERCISED; browser disconnected"}}:{})});
      scheduler.dispose();restoreBoundary?.();batchObserver?.detach();trace?.detach();c1?.detach();indexComparison?.detach();storage.close(); process.disconnect?.();
    } else throw new Error("Invalid IPC command");
    } catch(error) {
      scheduler.dispose();
      indexComparison?.detach();
      c1?.detach();
      restoreBoundary?.();batchObserver?.detach();trace?.detach();
      send({kind:"fatal",reason:String(error),uncommittedOwnedEvents:scheduler.pendingEvents,
        metrics:pipeline.metrics.snapshot(),scheduler:scheduler.snapshot()});
    }
  });
  send({kind:"ready"});
} else throw new Error("Explicit finite worker mode required");
process.on("disconnect",()=>process.exit(0));
}
