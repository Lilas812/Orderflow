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

const [mode,dir]=process.argv.slice(2);
requireOwnedDirectory(dir);
if(mode==="cursor") {
  const c=new SqliteCatalog(join(dir,"events.r16.sqlite"));
  process.send?.({kind:"cursor",manifest:c.manifest()});
  c.close();process.disconnect?.();
} else {
const storage=new StorageAdapter(dir), scope=storage.register(config(),ns(0));
const pipeline=new EventPipeline(storage);
const transportLatency=new Latencies();
const initialCpu=process.cpuUsage();
const diagnostics=["load:timing","load:cpu","load:r162-cpu"].includes(mode)?await import("./r161Diagnostics"):null;
const r163=mode==="load:r163-trace"?new (await import("./r163Diagnostics")).R163Probe():null;
const research=["load:r162-timing","load:r162-snapshot"].includes(mode)?
  new (await import("./r162Diagnostics")).ResearchProbe():r163;
const fixed=mode.startsWith("load:r163-")?await import("./r163Diagnostics"):null;
const batchObserver=fixed?fixed.observeBatches(storage):null;
const indexComparison=["load:r162-e-find","load:r162-e-map","load:r163-fixed-find","load:r163-fixed-map"].includes(mode)?
  new (await import("./r162Diagnostics")).IndexComparisonCapture():null;
if(indexComparison)indexComparison.attach(storage,mode.endsWith("-find")?"find-reference":"map");
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
  };
}
function send(value: object) { process.send?.(value); }
if(mode==="restore") {
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
} else if(["load","load:timing","load:cpu","load:coalesced","scheduler-test","load:r162-timing","load:r162-cpu","load:r162-snapshot","load:r162-e-find","load:r162-e-map","load:r163-fixed-find","load:r163-fixed-map","load:r163-trace"].includes(mode)) {
  let nextId=1, finishing=false;
  const scheduler=new CommitScheduler(pipeline,scope,{
    policy:mode==="load:coalesced" || mode==="scheduler-test" || /^load:r16[23]-/.test(mode)?"coalesced":"immediate",
    onReceived:receipt=>send({kind:"received",id:receipt.id,count:receipt.count,bytes:receipt.bytes,
      transitMs:Number(process.hrtime.bigint()-BigInt(receipt.submittedMonoNs))/1e6}),
    onFailure:reason=>send({kind:"storage-error",reason,metrics:pipeline.metrics.snapshot(),scheduler:scheduler.snapshot()}),
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
      const profile=cpu?await cpu.stop(dir):null;
      r163?.endIngestion();
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
      const result=summary(true);
      indexComparison?.sample("after_summary");
      trace?.sampleMemory("after_summary");
      const retained={guardSeenEntries:[...storage.states.values()].reduce((n,s)=>n+s.guard.seen.size,0),
        tradeRawReferences:[...storage.trades.values()].reduce((n,s)=>n+s.rawEvents.length,0),
        queueDepth:pipeline.metrics.queueDepth,queueBytes:pipeline.metrics.queueBytes};
      const owners=research?.owners(storage);
      if(research)await research.settle();
      send({kind:"result",...result,scheduler:scheduler.snapshot(),...(diagnostics||research||indexComparison?{diagnostics:{trace:trace?.report(),profile,retained,owners,snapshotAux,
        indexComparison:indexComparison?.report(storage),
        fixedBatches:batchObserver?.batches,r163:r163?.detail(),
        snapshotWrites:snapshotAux?.captured?1:0,
        tradeDedupCalls:mode==="load:timing"?(trace as import("./r161Diagnostics").DiagnosticTrace).report().timings["candidate.trade_dedup"]?.count??0:null,
        renderNotifications:"NOT EXERCISED; browser disconnected"}}:{})});
      scheduler.dispose();restoreBoundary?.();batchObserver?.detach();trace?.detach();indexComparison?.detach();storage.close(); process.disconnect?.();
    } else throw new Error("Invalid IPC command");
    } catch(error) {
      scheduler.dispose();
      indexComparison?.detach();
      restoreBoundary?.();batchObserver?.detach();trace?.detach();
      send({kind:"fatal",reason:String(error),uncommittedOwnedEvents:scheduler.pendingEvents,
        metrics:pipeline.metrics.snapshot(),scheduler:scheduler.snapshot()});
    }
  });
  send({kind:"ready"});
} else throw new Error("Explicit finite worker mode required");
process.on("disconnect",()=>process.exit(0));
}
