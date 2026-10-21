import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checksum, SqliteCatalog } from "@workspace/storage/catalog";
import { SegmentWriter } from "@workspace/storage/segments";
import { RangeQuery } from "@workspace/storage/range";
import { EventPipeline } from "./eventPipeline";
import { StorageAdapter } from "./storageAdapter";
import { config, deterministicDeliveries, eventAt, ns, requireOwnedDirectory } from "./r16Fixtures";
import type { MarketEvent } from "@workspace/core/events";
import { Latencies } from "./metrics";

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
  const start=performance.now(), records=storage.journal.records(scope);
  const rawReadMs=performance.now()-start;
  let chunkWriteMs: number | null=null, chunkBytes=0;
  if(withChunk && records.length) {
    const begin=performance.now();
    const segment=new SegmentWriter(storage.journal).write(scope,"L2_MBP",records.map(r=>r.position));
    chunkWriteMs=performance.now()-begin; chunkBytes=segment.bytes;
  }
  const queryStart=performance.now();
  const maxEventNs=records.reduce((max,r)=>BigInt(r.eventNs ?? r.receiveNs)>max?BigInt(r.eventNs ?? r.receiveNs):max,BigInt(ns(0)));
  const query=new RangeQuery(storage.journal).query(scope,"L2_MBP",ns(0),
    (maxEventNs+1n).toString());
  const rangeQueryMs=performance.now()-queryStart;
  const restoreStart=performance.now(); const restored=storage.journal.replay(scope);
  const restoreMs=performance.now()-restoreStart;
  return { metrics:pipeline.metrics.snapshot(), auditCount:records.length,
    auditHash:checksum(records.map(r=>r.input)), committedCursor:storage.catalog.manifest().recordCount,
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
} else if(mode==="load") {
  let nextId=1, finishing=false;
  process.on("message", raw=>{
    const message=raw as {kind:string;id:number;events:MarketEvent[];bytes:number;submittedMonoNs:string};
    if(message.kind==="batch") {
      if(finishing || message.id!==nextId++ || message.events.length>128 ||
        Buffer.byteLength(JSON.stringify(message),"utf8")!==message.bytes || message.bytes>8*1024*1024 ||
        !/^[0-9]+$/.test(message.submittedMonoNs) || BigInt(message.submittedMonoNs)>process.hrtime.bigint())
        throw new Error("Invalid or out-of-order bounded IPC batch");
      for(const event of message.events) if(!pipeline.receive(scope,event)) throw new Error("Unexpected loss in pausable load");
      send({kind:"received",id:message.id,count:message.events.length,bytes:message.bytes});
      if(!pipeline.drain()) throw new Error("Load storage failure");
      const transportMs=Number(process.hrtime.bigint()-BigInt(message.submittedMonoNs))/1e6;
      for(const _event of message.events)transportLatency.add(transportMs);
      const m=pipeline.metrics;
      send({kind:"committed",id:message.id,cpu:process.cpuUsage(initialCpu),metrics:{
        receivedEvents:m.receivedEvents,acceptedEvents:m.acceptedEvents,appliedEvents:m.appliedEvents,
        persistedEvents:m.persistedEvents,auditRecords:m.auditRecords,explicitlyLostEvents:m.explicitlyLostEvents,
        duplicateEvents:m.duplicateEvents,queueDepth:m.queueDepth,peakQueueDepth:m.peakQueueDepth,
        lastPersistedPosition:m.lastPersistedPosition,
      }});
    } else if(message.kind==="finish") {
      finishing=true; send({kind:"result",...summary(true)}); storage.close(); process.disconnect?.();
    } else throw new Error("Invalid IPC command");
  });
  send({kind:"ready"});
} else throw new Error("Explicit finite worker mode required");
process.on("disconnect",()=>process.exit(0));
}
