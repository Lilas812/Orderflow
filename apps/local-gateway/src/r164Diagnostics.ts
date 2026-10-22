/** Pure, bounded, finite MOCK comparison. NEVER reports persistence events/s. */
import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath,pathToFileURL } from "node:url";
import { PerformanceObserver } from "node:perf_hooks";
import { createMarketQualityState } from "@workspace/core/quality-timeline";
import { checksum } from "@workspace/storage/catalog";
import { config,eventAt,ns } from "./r16Fixtures";
import { PublishedState,SeenTransaction,oracleStep,sourceHashes,type SeenMode,type CopyMetrics } from "./r164SeenPrototype";
import { Latencies } from "./metrics";

export const LIMITS=Object.freeze({workerRss:512*1024*1024,totalRss:768*1024*1024,
  deadlineMs:30000,maxEvents:2000,maxInputBytes:8*1024*1024,transactionEvents:128,seedEvents:100});
export function checkSafety(workerRss:number,parentRss:number,elapsedMs:number){
  if(![workerRss,parentRss,elapsedMs].every(x=>Number.isFinite(x)&&x>=0))
    throw Error("NOT_MEASURED: safe stop");
  if(workerRss>LIMITS.workerRss||workerRss+parentRss>LIMITS.totalRss||elapsedMs>LIMITS.deadlineMs)
    throw Error("PROTOTYPE_SAFETY_STOP: RSS/time envelope");
}
export function validateCount(n:number){
  if(!Number.isSafeInteger(n)||n<1||n>LIMITS.maxEvents)throw Error("PROTOTYPE_SAFETY_STOP: input count");
}
export function expectedCopies(mode:SeenMode,n:number){
  validateCount(n);
  if(mode==="A")return {copies:n,entries:n*100+n*(n-1)/2};
  let entries=0,copies=0;
  for(let i=0;i<n;i+=128)if(mode==="B"||i>0){copies++;entries+=100+i;}
  return {copies,entries};
}
export function seeded(){
  let state=createMarketQualityState(config(),ns(0));
  for(let i=0;i<100;i++)state=oracleStep(state,{type:"EVENT",event:eventAt(i)}).state;
  return PublishedState.fromOracle(state);
}
export async function runCase(mode:SeenMode,n:number,parentRss=0){
  validateCount(n);if(!["A","B","C"].includes(mode))throw Error("INVALID_MODE");
  const startAll=performance.now(),cpuAll=process.cpuUsage();
  const base=seeded(),baseHash=base.checksum(),inputs=Array.from({length:n},(_,i)=>eventAt(100+i));
  if(Buffer.byteLength(JSON.stringify(inputs),"utf8")>LIMITS.maxInputBytes)throw Error("PROTOTYPE_SAFETY_STOP: bytes");
  const inputHash=checksum(inputs),logicalLatency=new Latencies(),gc:{start:number;ms:number}[]=[];
  const observer=new PerformanceObserver(list=>{
    for(const e of list.getEntries()){
      if(gc.length>=4096)throw Error("PROTOTYPE_SAFETY_STOP: GC diagnostic capacity");
      gc.push({start:e.startTime,ms:e.duration});
    }
  });
  observer.observe({entryTypes:["gc"]});
  let peakRss=0,peakHeap=0,peakKernel=0,samples=0;
  const sample=()=>{
    const m=process.memoryUsage(),k=process.resourceUsage().maxRSS*1024;
    peakRss=Math.max(peakRss,m.rss);peakHeap=Math.max(peakHeap,m.heapUsed);peakKernel=Math.max(peakKernel,k);samples++;
    checkSafety(Math.max(m.rss,k),parentRss,performance.now()-startAll);
  };
  let total:CopyMetrics={copies:0,copiedEntries:0,copyMs:0,requests:0,writes:0,undoneWrites:0,
    setMs:0,lookups:0,lookupMs:0};
  let current=base,transactions=0,publishMs=0,rollbackUnchanged=false,hotEnd=0;
  const begin=performance.now(),cpuBegin=process.cpuUsage();sample();
  try{
    for(let i=0;i<n;i+=128){
      const tx=new SeenTransaction(mode,current);
      for(const event of inputs.slice(i,i+128)){
        const t=performance.now();tx.apply({type:"EVENT",event});logicalLatency.add(performance.now()-t);
        if((++transactions&31)===0)sample();
      }
      const t=performance.now();tx.commit();current=tx.publish();publishMs+=performance.now()-t;
      for(const key of Object.keys(total) as (keyof CopyMetrics)[])total[key]+=tx.metrics[key];
      sample();
    }
    hotEnd=performance.now();const hotCpu=process.cpuUsage(cpuBegin);
    const hotMemory={hotSampledPeakRss:peakRss,hotSampledPeakHeapUsed:peakHeap,hotKernelPeakRss:peakKernel};
    // All correctness checks are OUTSIDE hot timing, same for A/B/C.
    let old=base.inspect();for(const event of inputs)old=oracleStep(old,{type:"EVENT",event}).state;
    const actual=current.checksum(),oracleHash=checksum(old);
    if(actual!==oracleHash||base.checksum()!==baseHash||checksum(inputs)!==inputHash)
      throw Error("ORACLE_MISMATCH");
    const rolled=new SeenTransaction(mode,current),before=current.checksum();
    rolled.apply({type:"EVENT",event:eventAt(100+n)});
    try{rolled.commit(()=>{throw Error("SIMULATED_FAILURE");});}catch(error){
      if(!(error instanceof Error)||error.message!=="SIMULATED_FAILURE")throw error;
    }
    rollbackUnchanged=rolled.phase==="ROLLED_BACK"&&current.checksum()===before;
    if(!rollbackUnchanged)throw Error("ROLLBACK_MISMATCH");
    const expected=expectedCopies(mode,n);
    if(total.copies!==expected.copies||total.copiedEntries!==expected.entries)throw Error("COPY_COUNT_MISMATCH");
    await new Promise<void>(r=>setImmediate(r));await new Promise<void>(r=>setImmediate(r));
    sample();const cpu=process.cpuUsage(cpuAll),wallMs=hotEnd-begin;
    return {
      kind:"R164_PURE_PROTOTYPE",environment:"MOCK",seed:1610,expectedResultSchemaVersion:1,
      mode,n,seedEvents:100,inputHash,sourceHashes,logicalEvents:transactions,
      transactionCount:Math.ceil(n/128),transactionMax:128,
      copied:total,hotWallMs:wallMs,publishMs,logicalLatencyMs:logicalLatency.report(),
      hotCpuUserMs:hotCpu.user/1000,hotCpuSystemMs:hotCpu.system/1000,
      hotCpuPercentOfOneCore:(hotCpu.user+hotCpu.system)/1000/wallMs*100,
      workerCpuMs:(cpu.user+cpu.system)/1000,totalMs:performance.now()-startAll,
      ...hotMemory,sampledPeakRss:peakRss,kernelPeakRss:peakKernel,sampledPeakHeapUsed:peakHeap,memorySamples:samples,
      hotGcMs:gc.reduce((v,e)=>v+Math.max(0,Math.min(hotEnd,e.start+e.ms)-Math.max(begin,e.start)),0),
      oracleHash,actualHash:actual,baseUnchanged:true,inputUnchanged:true,rollbackUnchanged,
      persistenceEventsPerSecond:"NOT_MEASURED",sqliteCommit:"NOT_EXECUTED",
      note:"VM/proxy/timing instrumentation included; setup/oracle checks outside hot timing; not production throughput",
      safeCompleted:true,
    };
  }finally{observer.disconnect();}
}

type Result=Awaited<ReturnType<typeof runCase>>;
function procRss(pid:number){
  const text=readFileSync(`/proc/${pid}/status`,"utf8"),m=/^VmRSS:\s+(\d+)\s+kB/m.exec(text);
  if(!m)throw Error("NOT_MEASURED: /proc RSS");return Number(m[1])*1024;
}
export function isolatedCase(mode:SeenMode,n:number):Promise<Result>{
  validateCount(n);
  return new Promise((resolve,reject)=>{
    const child=fork(fileURLToPath(import.meta.url),["--case",mode,String(n),String(process.memoryUsage().rss)],{
      execArgv:["--import","tsx"],stdio:["ignore","ignore","pipe","ipc"],
    });
    let result:Result|undefined,failure:Error|undefined,stderr="",sampledCombined=0;
    const timer=setTimeout(()=>stop(Error("PROTOTYPE_SAFETY_STOP: 30s parent timeout")),30000);
    const stop=(error:Error)=>{failure??=error;child.kill("SIGKILL");};
    const sampler=setInterval(()=>{
      try{
        if(!child.pid)throw Error("NOT_MEASURED: PID");
        const parent=procRss(process.pid),worker=procRss(child.pid);
        sampledCombined=Math.max(sampledCombined,parent+worker);
        checkSafety(worker,parent,0);
      }catch(error){if(!result)stop(error instanceof Error?error:Error(String(error)));}
    },20);
    child.stderr?.on("data",b=>{
      if(stderr.length<16384)stderr+=String(b);
      else stop(Error("PROTOTYPE_SAFETY_STOP: diagnostic stderr limit"));
    });
    child.on("message",message=>{
      const m=message as {ok?:boolean;result?:Result;error?:string};
      if(m.ok&&m.result)result=m.result;else stop(Error(m.error??"CHILD_DIAGNOSTIC_ERROR"));
    });
    child.on("error",error=>{failure??=error;child.kill("SIGKILL");});
    child.on("exit",(code,signal)=>{
      clearInterval(sampler);clearTimeout(timer);
      if(failure||code!==0||!result)reject(failure??Error(`Child exited ${code}/${signal}: ${stderr}`));
      else resolve(Object.assign(result,{parentSampledCombinedRss:sampledCombined}));
    });
  });
}
async function main(){
  if(process.argv[2]==="--case"){
    try{const result=await runCase(process.argv[3] as SeenMode,Number(process.argv[4]),Number(process.argv[5]));
      process.send?.({ok:true,result},()=>process.disconnect?.());
    }catch(error){process.send?.({ok:false,error:String(error)},()=>process.disconnect?.());process.exitCode=1;}
    return;
  }
  // Stage 2000 is reached ONLY after all smaller counts have safely matched oracle.
  for(const n of[100,400,1000,2000]){
    const hashes=new Set<string>();
    for(let repeat=0;repeat<3;repeat++){
      const order=repeat===0?["A","B","C"]:repeat===1?["B","C","A"]:["C","A","B"];
      for(const mode of order as SeenMode[]){
        try{
          const r=await isolatedCase(mode,n);hashes.add(r.actualHash);
          console.log(JSON.stringify({...r,repeat,order:order.join(""),stage:n===2000?"AFTER_SMALLER_CASES_SAFE":"PRIMARY"}));
          if(hashes.size!==1)throw Error("CROSS_MODE_MISMATCH");
        }catch(error){
          console.log(JSON.stringify({kind:"R164_PURE_PROTOTYPE",mode,n,repeat,safeCompleted:false,
            stopReason:String(error),persistenceEventsPerSecond:"NOT_MEASURED"}));
          throw error; // Never silently exclude a stopped trial or proceed to a larger input.
        }
      }
    }
  }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)
  main().catch(e=>{console.error(e);process.exitCode=1;});
