import { fork, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IpcCredits, ipcBatch } from "./mockTransport";
import { eventAt, ownedDirectory, removeOwnedDirectory } from "./r16Fixtures";

export interface LoadSpec { label:string;rate:number;durationMs:number }
export const LOAD_LIMITS=Object.freeze({workerRss:512*1024*1024,totalRss:768*1024*1024,hardMs:30_000,heapMiB:256});
export function worker(mode: string, dir: string): ChildProcess {
  return fork(new URL("./r16Worker.ts",import.meta.url),[mode,dir],{
    execArgv:["--max-old-space-size=256","--import","tsx"],stdio:["ignore","pipe","pipe","ipc"],
  });
}
export function processRss(pid: number): number {
  // These diagnostics target this Linux environment. Do not pretend Windows /proc exists.
  const status=readFileSync(`/proc/${pid}/status`,"utf8"), match=/^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if(!match) throw new Error("RSS cannot be measured accurately; stopping safely");
  return Number(match[1])*1024;
}
async function recoveredCursor(dir:string, remainingMs:number):Promise<string|null> {
  if(remainingMs<100)return null;
  const child=worker("cursor",dir);child.stdout?.resume();child.stderr?.resume();
  let cursor:string|null=null;
  return await new Promise(resolve=>{
    const timer=setTimeout(()=>child.kill("SIGKILL"),remainingMs);
    const monitor=setInterval(()=>{
      if(cursor)return;
      try {if(processRss(child.pid!)>LOAD_LIMITS.workerRss ||
        processRss(child.pid!)+processRss(process.pid)>LOAD_LIMITS.totalRss)child.kill("SIGKILL");}
      catch {if(child.exitCode===null && child.signalCode===null)child.kill("SIGKILL");}
    },10);
    child.on("message",raw=>{const m=raw as {kind:string;manifest:{recordCount:string}};if(m.kind==="cursor")cursor=m.manifest.recordCount;});
    child.on("error",()=>{clearTimeout(timer);clearInterval(monitor);resolve(null);});
    child.on("exit",code=>{clearTimeout(timer);clearInterval(monitor);resolve(code===0?cursor:null);});
  });
}
export async function measureLoad(spec: LoadSpec) {
  if(!Number.isSafeInteger(spec.rate) || spec.rate<=0 || spec.rate>50_000 ||
    ![100,1000].includes(spec.durationMs)) throw new Error("Outside approved finite load envelope");
  const dir=ownedDirectory(), child=worker("load",dir), credit=new IpcCredits();
  const started=performance.now(), initialCpu=process.cpuUsage(), requested=spec.rate*spec.durationMs/1000;
  let sourceStart:number|null=null,lastSend:number|null=null,firstReceived:number|null=null,lastReceived:number|null=null;
  let lastCommit:number|null=null,received=0,sent=0,id=0,finish=false,writeReady=true;
  let workerPeakRss=0,totalPeakRss=0,cpuPercent:number|null=null,stderr="",lastMetrics:Record<string,any>|null=null;
  let final:Record<string,any>|null=null,stopReason:string|null=null,lastCpu:NodeJS.CpuUsage|null=null;
  child.stderr?.on("data", data=>{stderr=(stderr+String(data)).slice(-8192);});
  child.stdout?.resume();
  return await new Promise<Record<string,any>>(resolve=>{
    let ended=false;
    const stop=(reason:string)=>{if(stopReason===null) stopReason=reason; child.kill("SIGKILL");};
    const guard=setInterval(()=>{
      if(ended) return;
      if(performance.now()-started>=LOAD_LIMITS.hardMs-5000) {stop("25s work budget; 5s reserved for durable cursor recovery within 30s");return;}
      if(final) return;
      try {
        const rss=processRss(child.pid!), parent=processRss(process.pid);
        workerPeakRss=Math.max(workerPeakRss,rss); totalPeakRss=Math.max(totalPeakRss,rss+parent);
        if(rss>LOAD_LIMITS.workerRss || rss+parent>LOAD_LIMITS.totalRss) stop("RSS safety limit");
      } catch(error) {
        // Only a live worker needs a measurement. Exit processing may have removed /proc.
        if(child.exitCode===null && child.signalCode===null) stop(String(error));
      }
    },10);
    const pump=setInterval(()=>{
      if(ended || stopReason || sourceStart===null || finish || !writeReady) return;
      const elapsed=performance.now()-sourceStart;
      const due=Math.min(requested,Math.floor(elapsed*spec.rate/1000));
      if(elapsed<spec.durationMs && sent<due) {
        const count=Math.min(128,due-sent,2048-credit.count);
        if(count<1 || credit.paused) return;
        const events=Array.from({length:count},(_,i)=>eventAt(sent+i,spec.rate));
        const next=id+1, message=ipcBatch(next,events,process.hrtime.bigint().toString()), bytes=message.bytes;
        if(!credit.reserve(next,count,bytes)) return;
        id=next; sent+=count; lastSend=performance.now();
        writeReady=child.send(message,error=>{
          if(error) stop(`IPC send error: ${error.message}`);
          else writeReady=true;
        });
      }
      // The offering window really ends at 100ms/1s. Paused, never-submitted
      // test inputs are counted explicitly, not silently emitted after the window.
      if(elapsed>=spec.durationMs && credit.count===0) {finish=true;child.send({kind:"finish"});}
    },2);
    child.on("message",raw=>{
      const message=raw as Record<string,any>;
      try {
        if(message.kind==="ready") sourceStart=performance.now();
        else if(message.kind==="received") {
          const pending=credit.pending.get(message.id);
          if(!pending || pending.count!==message.count || pending.bytes!==message.bytes) throw new Error("Receipt credit does not match submitted payload");
          credit.received(message.id); received+=message.count;
          firstReceived??=performance.now(); lastReceived=performance.now();
        } else if(message.kind==="committed") { credit.committed(message.id); lastCommit=performance.now();lastMetrics=message.metrics;lastCpu=message.cpu; }
        else if(message.kind==="result") final=message;
        else stop("Unexpected worker message");
      } catch(error) {stop(`IPC protocol error: ${error}`);}
    });
    child.on("error",error=>stop(`Worker error: ${error.message}`));
    child.on("exit",async(code,signal)=>{
      ended=true; clearInterval(guard);clearInterval(pump);
      if(!final && !stopReason) stopReason=`Worker exited ${code}/${signal}: ${stderr}`;
      const sourceMs=sourceStart===null ? null:Math.min(spec.durationMs,performance.now()-sourceStart);
      const metrics=final?.metrics ?? lastMetrics;
      const cursor=final?.committedCursor ?? await recoveredCursor(dir,LOAD_LIMITS.hardMs-(performance.now()-started));
      const durable=cursor===null ? null:Number(cursor);
      const elapsedMs=performance.now()-started;
      const cpu=process.cpuUsage(initialCpu), workerCpu=final?.cpu ?? lastCpu;
      if(workerCpu) cpuPercent=(cpu.user+cpu.system+workerCpu.user+workerCpu.system)/(elapsedMs*1000)*100;
      const report={
        ...spec,targetEventsPerSecond:spec.rate,requestedEvents:requested,sentEvents:sent,receivedEvents:received,
        actualInputEventsPerSecond:sourceMs && sourceMs>0 ? sent*1000/sourceMs:null,
        actualReceivedEventsPerSecond:sourceStart!==null && lastReceived!==null ? received*1000/(lastReceived-sourceStart):null,
        actualPersistedEventsPerSecond:sourceStart!==null && lastCommit!==null && metrics ?
          metrics.persistedEvents*1000/(lastCommit-sourceStart):null,
        notSubmittedEvents:requested-sent,
        confirmedCommittedAuditEvents:metrics?.auditRecords ?? 0,
        recoveredCommittedCursor:cursor,
        durableUniqueEvents:durable,
        sentButNotDurableEvents:durable===null?null:sent-durable,
        receivedEventsConfidence:final?"EXACT":"RECEIPT ACK LOWER BOUND; in-flight receipt may be unconfirmed",
        // On forced exit an ACK may be lost after commit: do not label these definitely uncommitted/lost.
        uncommittedEvents:final ? received-final.metrics.auditRecords:null,
        commitUnconfirmedEvents:sent-(metrics?.auditRecords ?? 0),
        explicitlyLostEvents:metrics?.explicitlyLostEvents ?? null,
        forcedTerminationUnpersistedTransmissions:final?0:durable===null?null:sent-durable,
        wallMs:elapsedMs,sourceMs,firstReceivedMs:firstReceived===null||sourceStart===null?null:firstReceived-sourceStart,
        lastSendAfterSourceStartMs:lastSend===null||sourceStart===null?null:lastSend-sourceStart,
        targetAchieved:sent===requested,
        ipc:credit.snapshot(),workerPeakRss,totalPeakRss,
        cpuParent:cpu,cpuWorker:workerCpu,totalCpuPercentOfOneCore:cpuPercent,
        cpuMeasurement:final?"RUN + FINALIZATION; worker initialization excluded":"LAST COMMIT ACK: LOWER BOUND; worker initialization excluded",
        kernelWorkerMaxRss:final?.resourceUsage?.maxRSS ? final.resourceUsage.maxRSS*1024:null,
        metrics,storage:final?{disk:final.disk,rawReadMs:final.rawReadMs,rangeQueryMs:final.rangeQueryMs,
          restoreMs:final.restoreMs,chunkWriteMs:final.chunkWriteMs,chunkBytes:final.chunkBytes,
          rangeStatus:final.rangeStatus,rangeFaults:final.rangeFaults,transportToCommitLatencyMs:final.transportToCommitLatencyMs,
          chunkBytesPerSecond:final.chunkWriteMs>0?final.chunkBytes*1000/final.chunkWriteMs:null,
          auditHash:final.auditHash,sqlite:final.sqlite}:null,
        diskAtWorkerExit:diskSizes(dir),
        safeCompleted:!!final && code===0 && !stopReason,stopReason,
        limits:LOAD_LIMITS,note:"MOCK only; timings include IPC/backpressure. GPU not measured. Peak RSS sampled every 10ms.",
      };
      removeOwnedDirectory(dir); resolve(report);
    });
  });
}
function diskSizes(dir:string) {
  const out={db:0,wal:0,chunks:0,total:0};
  for(const e of readdirSync(dir,{withFileTypes:true})) {
    const file=join(dir,e.name);
    if(e.isDirectory()) {const child=diskSizes(file);out.chunks+=child.total;out.total+=child.total;}
    else {
      const size=statSync(file).size;out.total+=size;
      if(e.name.endsWith(".sqlite"))out.db+=size;
      if(e.name.endsWith("-wal"))out.wal+=size;
    }
  }
  return out;
}
export async function runApprovedLoads() {
  const reports=[];
  // Sequential, never concurrent; no long tests or automatically escalating safety limits.
  for(const [label,rate] of [["LOW",1000],["MEDIUM",10000],["SPIKE",50000]] as const) {
    const pilot=await measureLoad({label,rate,durationMs:100}); reports.push(pilot);
    console.log(JSON.stringify(pilot));
    if(pilot.safeCompleted) {
      const full=await measureLoad({label,rate,durationMs:1000}); reports.push(full);console.log(JSON.stringify(full));
    } else console.log(JSON.stringify({label,durationMs:1000,status:"NOT RUN",reason:"Pilot did not complete within safety envelope"}));
  }
  return reports;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  runApprovedLoads().catch(error=>{console.error(error);process.exitCode=1;});
}
