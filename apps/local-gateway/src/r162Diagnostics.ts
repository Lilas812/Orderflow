/** R16.2 research only. No storage algorithm, validation, format or schema changes.
 * Hooks exist only inside a finite diagnostic child. Timing and CPU runs are separate.
 */
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { PerformanceObserver } from "node:perf_hooks";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SnapshotStore } from "@workspace/storage/snapshots";
import { SegmentReader } from "@workspace/storage/reader";
import { canonical, checksum } from "@workspace/storage/catalog";
import type { StorageAdapter } from "./storageAdapter";
import type { Trace } from "./r161Diagnostics";
import { Latencies } from "./metrics";
import { eventAt } from "./r16Fixtures";
import { selectIndexLookupForDiagnostics, storageState, type IndexLookupMeasurement,
  type IndexLookupMode } from "@workspace/storage/migration";

/** Identical, light instrumentation for BOTH E comparison modes. No global JSON/crypto hooks. */
export class IndexComparisonCapture {
  phase = "ingest";
  readonly indexPasses: (IndexLookupMeasurement & {phase:string;rss:number;heapUsed:number})[] = [];
  readonly transactions: {phase:string;wallMs:number;success:boolean;rss:number;heapUsed:number}[] = [];
  readonly memory: {label:string;rss:number;heapUsed:number}[] = [];
  private undo: (()=>void) | undefined;
  attach(storage:StorageAdapter, mode:IndexLookupMode):void {
    const c=storage.catalog, original=c.transaction;
    const restore=selectIndexLookupForDiagnostics(c,mode,m=>{
      if(this.indexPasses.length>=2048)throw Error("E diagnostic index-pass bound exceeded");
      this.indexPasses.push({...m,phase:this.phase,...process.memoryUsage()});
    });
    c.transaction=<T,>(operation:()=>T):T=>{
      const start=performance.now();let success=false;
      try {const result=original.call(c,operation) as T;success=true;return result;}
      finally {
        if(this.transactions.length>=1024)throw Error("E diagnostic transaction bound exceeded");
        this.transactions.push({phase:this.phase,wallMs:performance.now()-start,success,...process.memoryUsage()});
      }
    };
    this.undo=()=>{c.transaction=original;restore();};
    this.sample("before_ingestion");
  }
  sample(label:string):void {if(this.memory.length<16)this.memory.push({label,...process.memoryUsage()});}
  report(storage:StorageAdapter) {
    return {indexPasses:this.indexPasses,transactions:this.transactions,memory:this.memory,
      manifest:storage.catalog.manifest(),storageState:storageState(storage.catalog),
      note:"E-only: identical observer/transaction/memory probes in both modes. No CPU profiler or global hooks. Heap/RSS samples are not retained bytes of the temporary Map."};
  }
  detach():void {this.undo?.();this.undo=undefined;}
}

type Times = Record<string, { calls: number; ms: number; rows: number }>;
interface Transaction {
  id: number; phase: string; startMs: number; endMs: number; success: boolean;
  historicalRows: number; timings: Times; beginMs: number; finalizeMs: number;
  rss: number; heapUsed: number; external: number; arrayBuffers: number;
}
export class ResearchProbe implements Trace {
  phase = "ingest";
  readonly transactions: Transaction[] = [];
  readonly memory: { label: string; rss: number; heapUsed: number; external: number; arrayBuffers: number }[] = [];
  private readonly undo: (() => void)[] = [];
  private readonly totals: Times = {};
  private readonly latencies = new Map<string, Latencies>();
  private current: Transaction | null = null;
  private readonly gc: {startMs: number; durationMs: number}[] = [];
  private observer: PerformanceObserver | null = null;
  private attached = false;
  private replayDepth = 0;
  add(name: string, ms: number): void {
    const key = `${this.phase}:${name}`;
    const t = this.totals[key] ??= { calls: 0, ms: 0, rows: 0 };
    t.calls++; t.ms += Math.max(0, ms);
    let l = this.latencies.get(key);
    if (!l) this.latencies.set(key, l = new Latencies());
    l.add(Math.max(0, ms));
    if (this.current) {
      const v = this.current.timings[name] ??= { calls: 0, ms: 0, rows: 0 };
      v.calls++; v.ms += Math.max(0, ms);
    }
  }
  count(name: string, n: number): void {
    (this.totals[`${this.phase}:${name}`] ??= { calls: 0, ms: 0, rows: 0 }).rows += n;
    if (this.current) (this.current.timings[name] ??= {calls:0,ms:0,rows:0}).rows += n;
  }
  measure<T>(name: string, operation: () => T): T {
    const start = performance.now();
    try { return operation(); } finally { this.add(name, performance.now() - start); }
  }
  sampleMemory(label: string): void {
    if (this.memory.length < 128) this.memory.push({label,...process.memoryUsage()});
  }
  private wrap(owner: object, key: string, wrapper: (fn: Function, self: unknown, args: unknown[]) => unknown): void {
    const target = owner as Record<string, unknown>, original = target[key];
    if (typeof original !== "function") throw Error(`Diagnostic target absent: ${key}`);
    target[key] = function(this: unknown, ...args: unknown[]) { return wrapper(original, this, args); };
    this.undo.push(() => { target[key] = original; });
  }
  attach(storage?: StorageAdapter): void {
    if (this.attached) throw Error("Research probe already attached");
    this.attached = true;
    this.wrap(JSON, "parse", (fn,self,args) => this.measure("json.decode", () => Reflect.apply(fn,self,args)));
    this.wrap(crypto, "createHash", (fn,self,args) => {
      const start = performance.now(), hash = Reflect.apply(fn,self,args) as crypto.Hash;
      const digest = hash.digest, probe = this;
      // checksum() creates the Hash BEFORE canonical(value); lifecycle includes that serialization.
      // No bytes, events or digest values are captured. Native return values/errors are unchanged.
      hash.digest = function(this: crypto.Hash, ...params: unknown[]) {
        try { return Reflect.apply(digest,this,params); }
        finally { probe.add("sha256.lifecycle_INCLUSIVE",performance.now()-start); }
      } as typeof hash.digest;
      return hash;
    });
    syncBuiltinESMExports();
    this.wrap(Array.prototype, "find", (fn,self,args) => {
      const predicate = args[0];
      const indexJoin = typeof predicate === "function" &&
        /\.position\s*===\s*\w+\.position\.toString\(/.test(Function.prototype.toString.call(predicate));
      return indexJoin ? this.measure("catalog.index_join_find",()=>Reflect.apply(fn,self,args)) :
        Reflect.apply(fn,self,args);
    });
    const collect = (entries: readonly {startTime: number; duration: number}[]) => {
      for (const e of entries) {
        if (this.gc.length >= 8192) throw Error("Diagnostic GC record limit exceeded");
        this.gc.push({startMs:e.startTime,durationMs:e.duration});
      }
    };
    this.observer = new PerformanceObserver(list => collect(list.getEntries()));
    this.observer.observe({entryTypes:["gc"]});
    if (!storage) return;
    storage.trace = this;
    this.undo.push(()=>{storage.trace=undefined;});
    this.wrap(storage.catalog,"transaction",(fn,self,args)=>{
      if (this.current || this.transactions.length >= 1024) throw Error("Diagnostic transaction bound/nesting");
      const start = performance.now();
      const row: Transaction = {id:this.transactions.length+1,phase:this.phase,startMs:start,endMs:start,success:false,
        historicalRows:0,timings:{},beginMs:0,finalizeMs:0,...process.memoryUsage()};
      this.current=row;
      let callbackEnd: number | null=null;
      const operation=args[0];
      if(typeof operation!=="function")throw Error("Diagnostic transaction callback absent");
      const callback=()=>{
        row.beginMs=performance.now()-start;
        try{return Reflect.apply(operation,undefined,[]);}finally{callbackEnd=performance.now();}
      };
      try {const result=Reflect.apply(fn,self,[callback,...args.slice(1)]);row.success=true;return result;}
      finally {
        row.endMs=performance.now();
        row.finalizeMs=callbackEnd===null?0:row.endMs-callbackEnd;
        Object.assign(row,process.memoryUsage());
        this.transactions.push(row);this.current=null;
      }
    });
    for (const name of ["records","replay","stage","verify"] as const)
      this.wrap(storage.journal,name,(fn,self,args)=>this.measure(`journal.${name}_INCLUSIVE`,()=>{
        if(name==="replay")this.replayDepth++;
        try {
          const result=Reflect.apply(fn,self,args);
          if(name==="records" && Array.isArray(result)) {
            this.count("journal.records_returned",result.length);
            if(this.current && this.replayDepth)this.current.historicalRows+=result.length;
          }
          return result;
        } finally {if(name==="replay")this.replayDepth--;}
      }));
    for(const name of ["read","records"] as const)
      this.wrap(SegmentReader.prototype,name,(fn,self,args)=>this.measure(`segment.${name}_INCLUSIVE`,()=>Reflect.apply(fn,self,args)));
    for(const name of ["readCheckpoint","validateCheckpoint","recover","selectForRange","capture","verify"])
      this.wrap(SnapshotStore.prototype,name,(fn,self,args)=>this.measure(`snapshot.${name}_INCLUSIVE`,()=>Reflect.apply(fn,self,args)));
    this.wrap(storage.catalog.database,"prepare",(fn,self,args)=>{
      const sql=String(args[0]);
      const category=/FROM records WHERE position=\?/i.test(sql)?"sql.record_pk_lookup":
        /FROM r15_records ORDER BY position/i.test(sql)?"sql.index_payload_scan":
        /FROM r15_records\b/i.test(sql)?"sql.index_columns_scan":
        /FROM snapshots/i.test(sql)?"sql.snapshot_lookup":"sql.other";
      const stmt=this.measure(`${category}.prepare`,()=>Reflect.apply(fn,self,args)) as Record<string,unknown>;
      const probe=this;
      for(const method of ["get","all","run"]) {
        const native=stmt[method];if(typeof native!=="function")continue;
        stmt[method]=function(this:unknown,...params:unknown[]) {
          return probe.measure(`${category}.${method}`,()=>{
            const result=Reflect.apply(native,this,params);
            if(method==="all" && Array.isArray(result))probe.count(category,result.length);
            else if(method==="get" && result)probe.count(category,1);
            return result;
          });
        };
      }
      return stmt;
    });
    this.sampleMemory("probe_installed");
  }
  owners(storage: StorageAdapter) {
    return [...storage.states].map(([scopeId,s])=>({
      scopeId,seenEntries:s.guard.seen.size,heads:s.guard.heads.size,
      fingerprintUtf8Bytes:[...s.guard.seen].reduce((n,[k,v])=>n+Buffer.byteLength(k)+Buffer.byteLength(v),0),
      timelineIntervals:Object.values(s.timeline).reduce((n,v)=>n+v.length,0),
      note:"String byte proxy only; Map/object overhead and allocator retention are NOT measured by owner.",
    }));
  }
  async settle(): Promise<void> {
    await new Promise<void>(resolve=>setImmediate(resolve));
    await new Promise<void>(resolve=>setImmediate(resolve));
    for(const e of this.observer?.takeRecords()??[])this.gc.push({startMs:e.startTime,durationMs:e.duration});
    this.observer?.disconnect();
  }
  report() {
    return {
      totals:this.totals,
      percentiles:Object.fromEntries([...this.latencies].map(([k,l])=>[k,l.report()])),
      transactions:this.transactions.map(t=>({...t,wallMs:t.endMs-t.startMs,
        gcObservedOverlapMs:this.gc.reduce((n,g)=>n+Math.max(0,Math.min(t.endMs,g.startMs+g.durationMs)-Math.max(t.startMs,g.startMs)),0),
        replayAfterRecordsMs:(t.timings["journal.replay_INCLUSIVE"]?.ms??0)-(t.timings["journal.records_INCLUSIVE"]?.ms??0)})),
      memory:this.memory,gc:this.gc,
      note:"TIMING DIAGNOSTIC OVERHEAD. Nested inclusive spans overlap: DO NOT SUM. GC is observed wall duration, not CPU. Sequence CPU is sampled separately. replayAfterRecords includes replay/guards/book/quality, not pure state application.",
    };
  }
  detach(): void {
    this.observer?.disconnect();
    for(const undo of this.undo.reverse())undo();
    syncBuiltinESMExports();
    this.undo.length=0;this.attached=false;
  }
}

interface CpuNode {id:number;callFrame:{functionName:string;url:string};children?:number[]}
export function sampledCategories(profile:{nodes:CpuNode[];samples?:number[];timeDeltas?:number[]}) {
  const nodes=new Map(profile.nodes.map(n=>[n.id,n])), parents=new Map<number,number>();
  for(const n of profile.nodes)for(const child of n.children??[])parents.set(child,n.id);
  const categories:Record<string,{samples:number;estimatedInclusiveMs:number}>={};
  const tests:Record<string,(n:CpuNode)=>boolean>={
    sequence:n=>/guardEvent|acceptResyncSnapshot/.test(n.callFrame.functionName),
    indexVerification:n=>n.callFrame.functionName==="verifyMetadata",
    checksum:n=>n.callFrame.functionName==="checksum" && /sqliteCatalog/.test(n.callFrame.url),
    storageCanonical:n=>n.callFrame.functionName==="canonical" && /sqliteCatalog/.test(n.callFrame.url),
    sequenceFingerprint:n=>n.callFrame.functionName==="canonical" && /sequenceGuard/.test(n.callFrame.url),
    stateReplay:n=>n.callFrame.functionName==="replay" && /eventJournal/.test(n.callFrame.url),
    gc:n=>n.callFrame.functionName==="(garbage collector)",
    idle:n=>n.callFrame.functionName==="(idle)",
  };
  for(let i=0;i<(profile.samples?.length??0);i++) {
    const stack:CpuNode[]=[];let id:number|undefined=profile.samples![i];const seen=new Set<number>();
    while(id!==undefined && !seen.has(id)){seen.add(id);const n=nodes.get(id);if(!n)break;stack.push(n);id=parents.get(id);}
    for(const [key,test]of Object.entries(tests))if(stack.some(test)){
      const c=categories[key]??={samples:0,estimatedInclusiveMs:0};c.samples++;c.estimatedInclusiveMs+=(profile.timeDeltas?.[i]??0)/1000;
    }
  }
  return {categories,note:"1ms sampled inclusive wall attribution, NOT exact CPU/per-call timers. Categories overlap. An absent category is NOT MEASURED, not zero."};
}

async function main() {
  const {measureLoad}=await import("./r16Load");
  const output=process.argv[2];
  if(!output || !/^\.local\/r162[-/\w]*$/.test(output))throw Error("Expected ignored .local/r162... output directory");
  const destination=join(import.meta.dirname,"../../..",output);
  mkdirSync(destination,{recursive:true});
  if(process.argv[3]==="compare-e") {
    for(const n of [100,400,1000]) {
      const fixedTrace={batches:Array.from({length:n/2},(_,i)=>({atMs:i*2,count:2}))};
      const expectedHash=checksum(Array.from({length:n},(_,i)=>({type:"EVENT",event:eventAt(i,1000)})));
      const spec={label:`R162-E-N${n}`,rate:1000,durationMs:1000};
      let expectedManifest:string|undefined, expectedRoots:string|undefined;
      for(let repeat=1;repeat<=(n===100?1:3);repeat++) {
        const modes=repeat%2?["r162-e-find","r162-e-map"] as const:["r162-e-map","r162-e-find"] as const;
        for(const diagnostic of modes) {
          const r=await measureLoad(spec,{commitPolicy:"coalesced",fixedTrace,diagnostic});
          const e=r.diagnostics?.worker?.indexComparison;
          const manifest=e?canonical(e.manifest):null,roots=e?canonical(e.storageState):null;
          expectedManifest??=manifest??undefined;expectedRoots??=roots??undefined;
          const matched=r.safeCompleted && r.sentEvents===n && r.durableUniqueEvents===n &&
            r.fixedTrace.allPlannedInputsSubmitted && r.storage?.auditHash===expectedHash &&
            manifest===expectedManifest && roots===expectedRoots &&
            e.indexPasses.every((p:IndexLookupMeasurement)=>p.descriptorEntries===p.indexedRows &&
              p.matchedRows===p.indexedRows && p.mapEntries===(diagnostic==="r162-e-map"?p.descriptorEntries:0));
          console.log(JSON.stringify({phase:"R16.2-E-ONLY",repeat,n,diagnostic,expectedHash,
            traceHash:checksum(JSON.stringify(fixedTrace)),matched,...r}));
          if(!matched)throw Error("E comparison unsafe/incomplete/hash or coverage mismatch; larger trials NOT RUN");
        }
      }
    }
    return;
  }
  for(const n of [100,400,1000]) {
    const fixedTrace={batches:Array.from({length:n/2},(_,i)=>({atMs:i*2,count:2}))};
    const expectedHash=checksum(Array.from({length:n},(_,i)=>({type:"EVENT",event:eventAt(i,1000)})));
    const spec={label:`R162-N${n}`,rate:1000,durationMs:1000};
    const modes=n===100?["baseline","r162-timing","r162-snapshot"]:["baseline","baseline","baseline","r162-timing","r162-cpu"];
    for(const mode of modes) {
      const r=await measureLoad(spec,{commitPolicy:"coalesced",fixedTrace,
        ...(mode==="baseline"?{}:{diagnostic:mode as "r162-timing"|"r162-cpu"|"r162-snapshot"})});
      const profile=r.diagnostics?.worker?.profile;
      let cpuAnalysis:ReturnType<typeof sampledCategories>|undefined, retainedProfile:string|undefined;
      if(profile?.file) {
        retainedProfile=join(destination,`${n}-${basename(profile.file)}`);
        copyFileSync(profile.file,retainedProfile);
        cpuAnalysis=sampledCategories(JSON.parse(readFileSync(retainedProfile,"utf8")));
      }
      const matched=r.safeCompleted && r.sentEvents===n && r.durableUniqueEvents===n &&
        r.fixedTrace.allPlannedInputsSubmitted && r.storage?.auditHash===expectedHash;
      console.log(JSON.stringify({phase:"R16.2-RESEARCH-NOT-OPTIMIZED",mode,n,expectedHash,
        traceHash:checksum(JSON.stringify(fixedTrace)),matched,retainedProfile,cpuAnalysis,...r}));
      if(!matched)throw Error("Research trial unsafe/incomplete/hash mismatch; larger cases NOT RUN");
    }
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(error);process.exitCode=1;});
