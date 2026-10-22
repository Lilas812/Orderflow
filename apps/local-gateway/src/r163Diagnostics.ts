/** R16.3 measurement ONLY. No alternate storage/guard/replay algorithm. */
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checksum } from "@workspace/storage/catalog";
import { ResearchProbe } from "./r162Diagnostics";
import type { StorageAdapter } from "./storageAdapter";
import { Latencies } from "./metrics";
import { eventAt } from "./r16Fixtures";

/** Disable only this diagnostic scheduler instance's timer. Capacity/EOF flush, clocks, IPC,
 * ownership, validation and the actual pipeline/transactions remain unchanged. */
export function fixedBoundary(scheduler:object):()=>void {
  const own=Object.getOwnPropertyDescriptor(scheduler,"arm"), original=Reflect.get(scheduler,"arm");
  if(typeof original!=="function")throw Error("Diagnostic scheduler arm target missing");
  Object.defineProperty(scheduler,"arm",{configurable:true,writable:true,value:()=>undefined});
  return ()=>{if(own)Object.defineProperty(scheduler,"arm",own);else Reflect.deleteProperty(scheduler,"arm");};
}
export function observeBatches(storage:Pick<StorageAdapter,"commit">) {
  const batches:number[]=[], original=storage.commit;
  storage.commit=function(...args:Parameters<StorageAdapter["commit"]>) {
    if(batches.length>=1024)throw Error("Diagnostic batch bound exceeded");
    const result=Reflect.apply(original,this,args);
    batches.push(args[1].length);
    return result;
  };
  return {batches,detach:()=>{storage.commit=original;}};
}

type Aggregate={calls:number;ms:number;entries:number;latency:Latencies};
/** Per-row metadata decoding is attributed using the ACTUAL SQL result array, not guessed counts.
 * Guard seen copies are identified at the two unchanged source callsites, then by Map identity.
 * Source/constructor hooks are diagnostic only; all native calls/results/errors are preserved. */
export class R163Probe extends ResearchProbe {
  private frames:string[]=[];
  private rowOwner:string|null=null;
  private readonly attributed:Record<string,Aggregate>={};
  private readonly rowArrays=new WeakMap<object,string>();
  private readonly knownSeen=new WeakSet<object>();
  private readonly undo163:(()=>void)[]=[];
  private readonly copies:{start:number;end:number;stage:string;entries:number;phase:string}[]=[];
  private readonly buckets:Record<string,{copies:number;entries:number;ms:number}>={};
  private begin=0;
  private finish=0;
  private readonly seenSites:number[];
  readonly guardSourceHash:string;
  constructor() {
    super();
    const source=readFileSync(new URL("../../../packages/core/src/sequenceGuard.ts",import.meta.url),"utf8");
    this.seenSites=source.split("\n").flatMap((line,i)=>line.includes("new Map(state.seen)")?[i+1]:[]);
    if(this.seenSites.length!==2)throw Error("Guard copy callsites changed; diagnostic attribution NOT AVAILABLE");
    this.guardSourceHash=checksum(source);
  }
  override measure<T>(name:string,operation:()=>T):T {
    this.frames.push(name);
    try{return super.measure(name,operation);}finally{this.frames.pop();}
  }
  private origin():string {
    if(this.rowOwner)return this.rowOwner;
    if(this.frames.includes("segment.read_INCLUSIVE"))return "chunk.raw";
    if(this.frames.includes("segment.records_INCLUSIVE"))return "records.raw";
    return this.stackOrigin(new Error().stack??"");
  }
  private stackOrigin(stack:string):string {
    for(const [name,pattern]of [
      ["verifyMetadata",/\bverifyMetadata\b/],["liveIndices",/\bliveIndices\b/],
      ["saveStorageState",/\bsaveStorageState\b/],["insertIndex",/\binsertIndex\b/],
      ["snapshot.readCheckpoint",/\breadCheckpoint\b/],["snapshot.validateCheckpoint",/\bvalidateCheckpoint\b/],
      ["snapshot.capture",/\bSnapshotStore\.capture\b/],["snapshot.recover",/\bSnapshotStore\.recover\b/],
      ["segment.read",/\bSegmentReader\.read\b/],["segment.records",/\bSegmentReader\.records\b/],
      ["scope",/\bEventJournal\.scope\b/],["stage",/\bEventJournal\.stage\b/],
      ["scheduler.input_clone",/\bCommitScheduler\.accept\b/],["pipeline.input_clone",/\bEventPipeline\.receive\b/],
      ["commit",/\bEventJournal\.commit\b/],["replay",/\bEventJournal\.replay\b/],
      ["storageState",/\bstorageState\b/],["manifest",/\bSqliteCatalog\.manifest\b/],
    ] as const)if(pattern.test(stack))return name;
    return "other";
  }
  override add(name:string,ms:number):void {
    super.add(name,ms);
    if(name==="json.decode"||name==="sha256.lifecycle_INCLUSIVE")this.record(`${this.origin()}/${name}`,ms);
  }
  private record(name:string,ms:number,entries=0) {
    const key=`${this.phase}:${name}`;
    if(!this.attributed[key]&&Object.keys(this.attributed).length>=512)throw Error("Diagnostic attribution bound exceeded");
    const value=this.attributed[key]??={calls:0,ms:0,entries:0,latency:new Latencies()};
    value.calls++;value.ms+=ms;value.entries+=entries;value.latency.add(ms);
  }
  override attach(storage?:StorageAdapter):void {
    super.attach(storage);
    const nativeMap=globalThis.Map, nativeArrayMap=Array.prototype.map, probe=this;
    // Metadata rows() immediately calls .map() on exactly the SQL .all() result.
    Array.prototype.map=function(this:unknown[],...args:unknown[]) {
      const owner=probe.rowArrays.get(this), previous=probe.rowOwner;
      if(owner)probe.rowOwner=owner;
      const start=performance.now();
      try{return Reflect.apply(nativeArrayMap,this,args);}
      finally{if(owner){probe.record(`${owner}/decode_and_checksum_rows`,performance.now()-start,this.length);probe.rowOwner=previous;}}
    } as typeof Array.prototype.map;
    this.undo163.push(()=>{Array.prototype.map=nativeArrayMap;});
    if(storage) {
      const db=storage.catalog.database, nativePrepare=db.prepare;
      db.prepare=function(this:typeof db,...args:Parameters<typeof nativePrepare>) {
        const stmt=Reflect.apply(nativePrepare,this,args);
        const table=/^SELECT payload,checksum FROM (r15_records|r15_segments|r15_anchors)\b/i.exec(String(args[0]))?.[1];
        if(table) {
          const origin=probe.stackOrigin(new Error().stack??""), all=stmt.all;
          stmt.all=function(...params:unknown[]) {
            const result=Reflect.apply(all,this,params);
            if(Array.isArray(result))probe.rowArrays.set(result,`${origin}/${table}`);
            return result;
          };
        }
        return stmt;
      } as typeof db.prepare;
      this.undo163.push(()=>{db.prepare=nativePrepare;});
    }
    globalThis.Map=new Proxy(nativeMap,{
      construct(target,args,newTarget) {
        const input=args[0];
        let seen=input instanceof nativeMap && probe.knownSeen.has(input);
        if(!seen && input instanceof nativeMap) {
          const first=input.size?input.values().next().value:undefined;
          if(input.size===0 || (typeof first==="string"&&first.startsWith("{"))) {
            const stack=new Error().stack??"";
            seen=probe.seenSites.some(line=>stack.includes(`sequenceGuard.ts:${line}:`));
            if(seen)probe.knownSeen.add(input);
          }
        }
        if(!seen)return Reflect.construct(target,args,newTarget);
        const stage=probe.frames.includes("journal.replay_INCLUSIVE")?"historical":
          probe.frames.some(f=>f.startsWith("candidate."))?"candidate":"journal_new";
        const entries=(input as Map<unknown,unknown>).size,start=performance.now();
        const result=Reflect.construct(target,args,newTarget),end=performance.now();
        probe.knownSeen.add(result);
        if(probe.copies.length>=32768)throw Error("Diagnostic copy record bound exceeded");
        probe.copies.push({start,end,entries,stage,phase:probe.phase});
        probe.record(`seen_copy_native/${stage}`,end-start,entries);
        const range=entries===0?"0":entries<128?"1-127":entries<256?"128-255":entries<512?"256-511":entries<1024?"512-1023":"1024+";
        const bucket=probe.buckets[`${probe.phase}:${range}`]??={copies:0,entries:0,ms:0};
        bucket.copies++;bucket.entries+=entries;bucket.ms+=end-start;
        return result;
      },
    });
    this.undo163.push(()=>{globalThis.Map=nativeMap;});
    this.begin=performance.now();
  }
  endIngestion():void {this.finish=performance.now();this.phase="snapshot_aux";}
  detail() {
    const base=super.report(),end=this.finish||performance.now(),copies=this.copies.filter(c=>c.phase==="ingest");
    return {
      guardSourceHash:this.guardSourceHash,guardCopySourceLines:this.seenSites,
      attribution:Object.fromEntries(Object.entries(this.attributed).map(([k,v])=>[k,{
        calls:v.calls,ms:v.ms,entries:v.entries,latency:v.latency.report(),
      }])),copySizeBuckets:this.buckets,
      ingestSeenCopies:copies.length,ingestCopiedEntries:copies.reduce((n,c)=>n+c.entries,0),
      ingestGcObservedMs:base.gc.reduce((n,g)=>n+Math.max(0,Math.min(end,g.startMs+g.durationMs)-Math.max(this.begin,g.startMs)),0),
      ingestCopyGcOverlapMs:copies.reduce((n,c)=>n+base.gc.reduce((v,g)=>v+Math.max(0,
        Math.min(c.end,g.startMs+g.durationMs)-Math.max(c.start,g.startMs)),0),0),
      note:"DIAGNOSTIC OVERHEAD; spans overlap. Native constructor wall times include overlapping GC. Copied entries are logical work, NOT allocated object/byte counts. JSON/SHA owner attribution uses actual metadata result arrays and current call context. SHA lifecycle includes canonical serialization. Ingest excludes forced GC and Snapshot/summary. No raw IDs/fingerprints retained.",
    };
  }
  override detach():void {
    for(const undo of this.undo163.reverse())undo();
    this.undo163.length=0;super.detach();
  }
}

async function main() {
  const {measureLoad}=await import("./r16Load");
  const output=process.argv[2];
  if(!output||!/^\.local\/r163[-/\w]*$/.test(output))throw Error("Expected ignored .local/r163... directory");
  mkdirSync(join(import.meta.dirname,"../../..",output),{recursive:true});
  for(const n of [100,400,1000]) {
    const fixedTrace={batches:Array.from({length:n/2},(_,i)=>({atMs:i*2,count:2}))};
    const expectedHash=checksum(Array.from({length:n},(_,i)=>({type:"EVENT",event:eventAt(i,1000)})));
    const expectedBatches=Array.from({length:Math.ceil(n/128)},(_,i)=>Math.min(128,n-i*128));
    const history=expectedBatches.reduce((a,b,i)=>a+expectedBatches.slice(0,i).reduce((x,y)=>x+y,0),0);
    for(const diagnostic of ["r162-e-map","r163-fixed-find","r163-fixed-map","r163-trace"] as const) {
      const r=await measureLoad({label:`R163-N${n}`,rate:1000,durationMs:1000},
        {commitPolicy:"coalesced",fixedTrace,diagnostic});
      const d=r.diagnostics?.worker, fixed=diagnostic.startsWith("r163-");
      const matched=r.safeCompleted&&r.sentEvents===n&&r.durableUniqueEvents===n&&r.storage?.auditHash===expectedHash&&
        (!fixed||JSON.stringify(d.fixedBatches)===JSON.stringify(expectedBatches))&&
        (diagnostic!=="r163-trace"||d.r163.ingestSeenCopies===2*n+history);
      console.log(JSON.stringify({phase:"R16.3-RESEARCH-NO-OPTIMIZATION",n,diagnostic,
        expectedHash,traceHash:checksum(JSON.stringify(fixedTrace)),expectedBatches,expectedHistoricalRows:history,matched,...r}));
      if(!matched)throw Error("Unsafe/incomplete/hash/boundary/copy-count mismatch; larger trials NOT RUN");
    }
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(error);process.exitCode=1;});
