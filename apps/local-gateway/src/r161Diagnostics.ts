import { Session } from "node:inspector";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Latencies } from "./metrics";
import type { StorageAdapter } from "./storageAdapter";
import { checksum } from "@workspace/storage/catalog";
import { eventAt } from "./r16Fixtures";

export interface Trace {
  measure<T>(name: string, operation: () => T): T;
  add(name: string, ms: number): void;
  count(name: string, amount: number): void;
}
/** Diagnostic runs only. Nested timings are inclusive and MUST NOT be summed. */
export class DiagnosticTrace implements Trace {
  private timings = new Map<string,Latencies>();
  private counters = new Map<string,number>();
  readonly memory: {label:string;atMs:number;rss:number;heapUsed:number;external:number;arrayBuffers:number;
    eventWriteCalls:number;historicalReplayVisits:number;metadataRowsRead:number}[]=[];
  readonly undo: (()=>void)[]=[];
  private replayDepth=0;
  private transactions=0;
  measure<T>(name:string, operation:()=>T):T {
    const start=performance.now();
    try {return operation();}
    finally {this.add(name,performance.now()-start);}
  }
  add(name:string,ms:number):void {
    let timer=this.timings.get(name);
    if(!timer){timer=new Latencies();this.timings.set(name,timer);}
    timer.add(Math.max(0,ms));
  }
  count(name:string,n:number):void {this.counters.set(name,(this.counters.get(name)??0)+n);}
  sampleMemory(label:string):void {
    if(this.memory.length<128)this.memory.push({label,atMs:performance.now(),...process.memoryUsage(),
      eventWriteCalls:this.timings.get("sqlite.event_records.run")?.count??0,
      historicalReplayVisits:this.counters.get("journal.replay.historical_record_visits")??0,
      metadataRowsRead:this.counters.get("sqlite.index_snapshot_metadata.rows_read")??0});
  }
  private wrap(owner:object,key:string,wrap:(original:Function,self:unknown,args:unknown[])=>unknown):void {
    const methods=owner as Record<string,unknown>, original=methods[key];
    if(typeof original!=="function")throw new Error(`Diagnostic method not found: ${key}`);
    methods[key]=function(this:unknown,...args:unknown[]){return wrap(original,this,args);};
    this.undo.push(()=>{methods[key]=original;});
  }
  attach(storage:StorageAdapter):void {
    storage.trace=this;
    this.wrap(storage.journal,"replay",(fn,self,args)=>this.measure("journal.replay.INCLUSIVE",()=>{
      this.replayDepth++;
      try{return Reflect.apply(fn,self,args);}
      finally{this.replayDepth--;}
    }));
    this.wrap(storage.journal,"records",(fn,self,args)=>this.measure("journal.records.verify.INCLUSIVE",()=>{
      const result=Reflect.apply(fn,self,args) as unknown[];
      this.count("journal.records.returned_rows",result.length);
      if(this.replayDepth)this.count("journal.replay.historical_record_visits",result.length);
      return result;
    }));
    this.wrap(storage.journal,"stage",(fn,self,args)=>this.measure("journal.stage.validation",()=>Reflect.apply(fn,self,args)));
    this.wrap(storage.catalog,"transaction",(fn,self,args)=> {
      const work=args[0];
      if(typeof work!=="function")throw new TypeError("Diagnostic transaction callback");
      const start=performance.now();let end:number|null=null,entered=false,success=false;
      const callback=()=>{
        entered=true;this.add("sqlite.begin_and_setup",performance.now()-start);
        try{return Reflect.apply(work,undefined,[]);}
        finally{end=performance.now();}
      };
      try {
        const result=Reflect.apply(fn,self,[callback,...args.slice(1)]);
        success=true;this.transactions++;this.count("sqlite.committed_transactions",1);
        if(this.transactions%50===0)this.sampleMemory(`after_transaction_${this.transactions}`);
        return result;
      } finally {
        if(entered && end!==null)this.add(success?"sqlite.commit_sync_and_return":"sqlite.rollback_and_return",performance.now()-end);
        this.add("sqlite.transaction.INCLUSIVE",performance.now()-start);
      }
    });
    this.wrap(storage.catalog.database,"prepare",(fn,self,args)=> {
      const sql=String(args[0]), statement=Reflect.apply(fn,self,args) as Record<string,unknown>;
      const group=/\br15_|\bsnapshots\b/i.test(sql) ? "index_snapshot_metadata" :
        /\b(?:INTO|FROM|UPDATE)\s+records\b/i.test(sql) ? "event_records" : "catalog_other";
      for(const method of ["run","get","all"]) {
        const native=statement[method];
        if(typeof native!=="function")continue;
        // Statement lifetime is owned by SQLite/caller, not retained by undo closures.
        const trace=this;
        statement[method]=function(this:unknown,...params:unknown[]) {
          return trace.measure(`sqlite.${group}.${method}`,()=>{
            const result=Reflect.apply(native,this,params);
            if(method==="all" && Array.isArray(result))trace.count(`sqlite.${group}.rows_read`,result.length);
            return result;
          });
        };
      }
      return statement;
    });
    this.sampleMemory("after_probe_install");
  }
  report() {
    const timings=Object.fromEntries([...this.timings].map(([name,t])=>[name,{...t.report(),totalMs:t.sum}]));
    return {timings,counters:Object.fromEntries(this.counters),memory:this.memory,
      note:"DIAGNOSTIC OVERHEAD PRESENT. Nested INCLUSIVE stages overlap; do not add them.",
      unmeasured:["Node IPC internal deserialize (included in transit, not isolated)",
        "Pure imported checksum/index-validation CPU totals (see CPU profile; SQL probes are partial)",
        "SQLite native allocator bytes and retained JS bytes by owner",
        "OS fsync alone (included in native commit/return)",
        "GPU/display notification (browser not connected)"]};
  }
  detach():void {for(const undo of this.undo.reverse())undo();}
}

interface CpuNode {id:number;callFrame:{functionName:string;url:string};children?:number[]}
interface CpuProfile {nodes:CpuNode[];samples?:number[];timeDeltas?:number[];startTime:number;endTime:number}
export class CpuCapture {
  private readonly session=new Session();
  private post(method:string,params:object={}):Promise<Record<string,unknown>> {
    return new Promise((resolve,reject)=>{
      this.session.post(method as "Profiler.enable",params,(error,result)=>error?reject(error):resolve(result as Record<string,unknown>));
    });
  }
  async start():Promise<void> {
    this.session.connect();await this.post("Profiler.enable");
    await this.post("Profiler.setSamplingInterval",{interval:1000});await this.post("Profiler.start");
  }
  async stop(directory:string,owner:"worker"|"parent"="worker") {
    try {
      const response=await this.post("Profiler.stop"),profile=response.profile as CpuProfile;
      const encoded=JSON.stringify(profile);
      if(Buffer.byteLength(encoded)>16*1024*1024)throw new Error("CPU profile exceeds bounded diagnostic output");
      const file=join(directory,`${owner}.cpuprofile`);writeFileSync(file,encoded,{mode:0o600});
      const nodes=new Map(profile.nodes.map(n=>[n.id,n])),self=new Map<number,number>();
      for(let i=0;i<(profile.samples?.length??0);i++) {
        const id=profile.samples![i],ms=(profile.timeDeltas?.[i]??0)/1000;
        self.set(id,(self.get(id)??0)+ms);
      }
      const top=[...self].map(([id,selfMs])=>({function:nodes.get(id)?.callFrame.functionName||"(anonymous)",
        url:nodes.get(id)?.callFrame.url,selfMs})).sort((a,b)=>b.selfMs-a.selfMs);
      return {file,bytes:Buffer.byteLength(encoded),sampleIntervalUs:1000,
        sampledWallMs:(profile.endTime-profile.startTime)/1000,topSelf:top.slice(0,40),
        note:"Separate CPU-diagnostic run; sampled self times, not exact per-call durations. Includes idle/GC."};
    }finally{this.session.disconnect();}
  }
}

async function main() {
  const {measureLoad}=await import("./r16Load");
  const mode=process.argv[2]??"baseline";
  if(mode==="baseline") {
    for(let repeat=1;repeat<=3;repeat++)
      for(const [label,rate] of [["LOW",1000],["MEDIUM",10000],["SPIKE",50000]] as const) {
        const pilot=await measureLoad({label,rate,durationMs:100});
        console.log(JSON.stringify({phase:"baseline",repeat,...pilot}));
        if(pilot.safeCompleted)console.log(JSON.stringify({phase:"baseline",repeat,...await measureLoad({label,rate,durationMs:1000})}));
        else console.log(JSON.stringify({phase:"baseline",repeat,label,status:"1s NOT RUN: unsafe pilot"}));
      }
  } else if(mode==="compare") {
    // Fixed metadata, input count, sequence/content and planned times are identical across policies.
    // Capped traces test relative costs; they are NOT full target-rate achievement trials.
    const cases=[
      {label:"LOW-100ms",rate:1000,durationMs:100,n:96,batch:4,step:4},
      {label:"LOW-1s",rate:1000,durationMs:1000,n:400,batch:2,step:2},
      {label:"MEDIUM-100ms",rate:10000,durationMs:100,n:600,batch:20,step:2},
      {label:"MEDIUM-1s",rate:10000,durationMs:1000,n:1000,batch:20,step:2},
      {label:"SPIKE-100ms",rate:50000,durationMs:100,n:640,batch:100,step:2},
      {label:"SPIKE-1s",rate:50000,durationMs:1000,n:1536,batch:128,step:2.56},
    ];
    const selected=process.argv[3];
    if(selected && !cases.some(c=>c.label===selected))throw Error("Unknown fixed comparison case");
    for(const c of cases.filter(c=>!selected || c.label===selected)) {
      const trace={batches:Array.from({length:Math.ceil(c.n/c.batch)},(_,i)=>({atMs:i*c.step,count:Math.min(c.batch,c.n-i*c.batch)}))};
      const expectedHash=checksum(Array.from({length:c.n},(_,i)=>({type:"EVENT",event:eventAt(i,c.rate)})));
      // Diagnostic milliseconds can be fractional; the market canonicalizer intentionally accepts integer numbers only.
      // Hash the deterministic metadata string; do not weaken market-event checksum validation.
      const traceHash=checksum(JSON.stringify({spec:c,trace}));
      for(let repeat=1;repeat<=3;repeat++) {
        // Counterbalance policy order, run serially, never overlap CPU profiling/testing with these trials.
        const policies=repeat%2?["immediate","coalesced"] as const:["coalesced","immediate"] as const;
        for(const commitPolicy of policies) {
          const r=await measureLoad(c,{commitPolicy,fixedTrace:trace});
          const matched=r.safeCompleted && r.fixedTrace.allPlannedInputsSubmitted &&
            r.sentEvents===c.n && r.durableUniqueEvents===c.n && r.storage?.auditHash===expectedHash;
          console.log(JSON.stringify({phase:"fixed-comparison",repeat,traceHash,expectedHash,
            fullTraceAndHashMatched:matched,...r}));
        }
      }
    }
  } else if(mode==="coalesced") {
    for(const [label,rate] of [["LOW",1000],["MEDIUM",10000],["SPIKE",50000]] as const) {
      const pilot=await measureLoad({label,rate,durationMs:100},{commitPolicy:"coalesced"});
      console.log(JSON.stringify({phase:mode,...pilot}));
      if(pilot.safeCompleted)console.log(JSON.stringify({phase:mode,...await measureLoad({label,rate,durationMs:1000},{commitPolicy:"coalesced"})}));
      else console.log(JSON.stringify({phase:mode,label,status:"1s NOT RUN: unsafe pilot"}));
    }
  } else if(mode==="timing-small") {
    console.log(JSON.stringify({phase:mode,...await measureLoad({label:"LOW-CAPPED-DIAGNOSTIC",rate:1000,durationMs:1000},
      {diagnostic:"timing",diagnosticEventLimit:400})}));
  } else if(mode==="timing" || mode==="cpu") {
    console.log(JSON.stringify({phase:mode,...await measureLoad({label:"LOW",rate:1000,durationMs:1000},{diagnostic:mode})}));
  } else throw new Error("Expected baseline | compare | coalesced | timing | timing-small | cpu");
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(error);process.exitCode=1;});
