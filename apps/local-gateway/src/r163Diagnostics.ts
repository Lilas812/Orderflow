/** R16.3 measurement ONLY. No alternate storage/guard/replay algorithm. */
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checksum } from "@workspace/storage/catalog";
import { ResearchProbe } from "./r162Diagnostics";
import type { StorageAdapter } from "./storageAdapter";
import { Latencies } from "./metrics";
import { eventAt } from "./r16Fixtures";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { PerformanceObserver } from "node:perf_hooks";
import { selectCommitReadForDiagnostics, storageState, type CommitReadMeasurement } from "@workspace/storage/migration";

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
      ["verifyMetadata",/\b(?:verifyMetadata|verifiedMetadata)\b/],["liveIndices",/\bliveIndices\b/],
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

/** Light, identical C-1 observers in before/after. No Map/semantic replay changes.
 * Counts actual native JSON/SHA calls, actual SQL result arrays and actual row-map wall time.
 */
export class C1Capture {
  phase = "ingest";
  private owner: string | null = null;
  private readonly arrays = new WeakMap<object, string>();
  readonly scans: { phase: string; owner: string; rows: number; ms: number; decode: number; checksum: number }[] = [];
  readonly reads: Record<string, number> = {};
  readonly calls: Record<string, { decode: number; checksum: number }> = {};
  readonly sourceMapParses: Record<string, number> = {};
  readonly guards: CommitReadMeasurement[] = [];
  readonly gc: { phase: string; startMs: number; ms: number }[] = [];
  readonly memory: { phase: string; rss: number; heapUsed: number }[] = [];
  private ingestStart = 0;
  private ingestEnd = 0;
  private undo: (() => void)[] = [];
  private observer?: PerformanceObserver;
  private activeScan: typeof this.scans[number] | undefined;
  attach(storage: StorageAdapter, reference: boolean): void {
    const capture = this, db = storage.catalog.database, prepare = db.prepare;
    this.undo.push(selectCommitReadForDiagnostics(storage.catalog, reference ? "reference" : "reuse",
      m => { if (this.guards.length >= 1024) throw Error("C1 diagnostic bound"); this.guards.push(m); }));
    db.prepare = function(this: typeof db, ...args: Parameters<typeof prepare>) {
      const stmt = Reflect.apply(prepare, this, args), sql = String(args[0]);
      const table = /^SELECT payload,checksum FROM (r15_records|r15_segments|r15_anchors|r15_meta)\b/.exec(sql)?.[1];
      if (table) {
        const stack = new Error().stack ?? "";
        const origin = /\b(?:verifyMetadata|verifiedMetadata)\b/.test(stack) ? "verifyMetadata" :
          /\bliveIndices\b/.test(stack) ? "liveIndices" : /\bsaveStorageState\b/.test(stack) ? "saveStorageState" : "other";
        const owner = `${origin}/${table}`;
        for (const method of ["all", "get"] as const) {
          const native = stmt[method];
          Reflect.set(stmt, method, function(this: typeof stmt, ...params: unknown[]) {
            const result = Reflect.apply(native, this, params), key = `${capture.phase}:${owner}`;
            capture.reads[key] = (capture.reads[key] ?? 0) + 1;
            if(capture.memory.length>=8192)throw Error("C1 memory diagnostic bound");
            capture.memory.push({phase:capture.phase,...process.memoryUsage()});
            if (Array.isArray(result)) capture.arrays.set(result, owner);
            return result;
          });
        }
      }
      return stmt;
    } as typeof prepare;
    this.undo.push(() => { db.prepare = prepare; });
    const map = Array.prototype.map;
    Array.prototype.map = function(this: unknown[], ...args: unknown[]) {
      const owner = capture.arrays.get(this), previous = capture.owner, scan = capture.activeScan;
      const row = owner ? { phase: capture.phase, owner, rows: this.length, ms: 0, decode: 0, checksum: 0 } : undefined;
      if (row) {
        if (capture.scans.length >= 4096) throw Error("C1 scan diagnostic bound");
        capture.owner = owner!; capture.activeScan = row;
      }
      const start = performance.now();
      try { return Reflect.apply(map, this, args); }
      finally {
        if (row) {
          row.ms = performance.now() - start; capture.scans.push(row);
          capture.owner = previous; capture.activeScan = scan;
        }
      }
    } as typeof map;
    this.undo.push(() => { Array.prototype.map = map; });
    const parse = JSON.parse, createHash = crypto.createHash;
    const count = (kind: "decode" | "checksum") => {
      const value = capture.calls[capture.phase] ??= { decode: 0, checksum: 0 };
      value[kind]++; if (capture.activeScan) capture.activeScan[kind]++;
    };
    JSON.parse = function(this: unknown, ...args: Parameters<typeof parse>) {
      // Reading Error.stack for SQL attribution can make tsx decode source maps.
      // Keep those real calls visible, but separate them from application JSON.
      if(typeof args[0]==="string"&&/^\s*\{\s*"version"\s*:\s*3\b/.test(args[0]))
        capture.sourceMapParses[capture.phase]=(capture.sourceMapParses[capture.phase]??0)+1;
      count("decode"); return Reflect.apply(parse, this, args);
    } as typeof parse;
    crypto.createHash = function(this: unknown, ...args: Parameters<typeof createHash>) {
      const hash = Reflect.apply(createHash, this, args), digest = hash.digest;
      hash.digest = function(this: typeof hash, ...params: unknown[]) { count("checksum"); return Reflect.apply(digest, this, params); } as typeof digest;
      return hash;
    } as typeof createHash;
    syncBuiltinESMExports();
    this.undo.push(() => { JSON.parse = parse; crypto.createHash = createHash; syncBuiltinESMExports(); });
    this.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (this.gc.length >= 8192) throw Error("C1 GC diagnostic bound");
        this.gc.push({ phase: this.phase, startMs: entry.startTime, ms: entry.duration });
      }
    });
    this.observer.observe({ entryTypes: ["gc"] });
    this.ingestStart=performance.now();
  }
  endIngestion(): void { this.ingestEnd=performance.now();this.phase = "after_ingest"; }
  async settle(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const e of this.observer?.takeRecords() ?? []) this.gc.push({ phase: this.phase, startMs:e.startTime, ms: e.duration });
    this.observer?.disconnect();
  }
  report(storage: StorageAdapter) {
    return { scans: this.scans, reads: this.reads, calls: this.calls, sourceMapParses:this.sourceMapParses,
      guards: this.guards, gc: this.gc,memory:this.memory,
      ingestGcMs:this.gc.reduce((n,g)=>n+Math.max(0,Math.min(this.ingestEnd||performance.now(),g.startMs+g.ms)-
        Math.max(this.ingestStart,g.startMs)),0),
      manifest: storage.catalog.manifest(), roots: storageState(storage.catalog),
      note: "Observed timing includes identical observer overhead. Row decode/checksum are actual calls inside tagged SQL array maps; all-call totals include non-metadata work. GC is attributed at observation delivery, not exact interval overlap. No descriptor/event cache retained." };
  }
  detach(): void { this.observer?.disconnect(); for (const f of this.undo.reverse()) f(); this.undo = []; }
}

async function c1Main() {
  const { measureLoad } = await import("./r16Load");
  for (const n of [100, 400, 1000]) {
    const fixedTrace = { batches: Array.from({ length: n / 2 }, (_, i) => ({ atMs: i * 2, count: 2 })) };
    const expectedHash = checksum(Array.from({ length: n }, (_, i) => ({ type: "EVENT", event: eventAt(i, 1000) })));
    const expectedBatches = Array.from({ length: Math.ceil(n / 128) }, (_, i) => Math.min(128, n - i * 128));
    for (const boundary of (n === 100 ? ["fixed"] : ["fixed", "normal"]) as ("fixed" | "normal")[]) {
      for (let repeat = 0; repeat < (n === 100 ? 1 : 3); repeat++) {
        for (const version of (repeat % 2 ? ["after", "before"] : ["before", "after"]) as ("before" | "after")[]) {
          const diagnostic = `r163-c1-${version}-${boundary}` as const;
          const r = await measureLoad({ label: `C1-N${n}-${repeat}`, rate: 1000, durationMs: 1000 },
            { commitPolicy: "coalesced", fixedTrace, diagnostic });
          const matched = r.safeCompleted && r.sentEvents === n && r.durableUniqueEvents === n &&
            r.storage?.auditHash === expectedHash &&
            (boundary !== "fixed" || JSON.stringify(r.diagnostics?.worker.fixedBatches) === JSON.stringify(expectedBatches));
          console.log(JSON.stringify({ phase: "R16.3-C1", n, repeat, boundary, version, expectedHash,
            traceHash: checksum(JSON.stringify(fixedTrace)), expectedBatches, matched, ...r }));
          if (!matched) throw Error("C1 safety/hash/boundary mismatch; remaining trials NOT RUN");
        }
      }
    }
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
  (process.argv.includes("--c1") ? c1Main() : main()).catch(error=>{console.error(error);process.exitCode=1;});
