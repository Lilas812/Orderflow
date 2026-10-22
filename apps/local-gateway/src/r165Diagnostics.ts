import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { measureLoad, validateFixedTrace, type FixedLoadTrace } from "./r16Load";
import { checksum } from "@workspace/storage/catalog";

export interface SeenComparisonCase {
  readonly n:100|400|1000|2000;readonly repeat:number;
  readonly order:readonly ("immutable"|"owned")[];readonly trace:FixedLoadTrace;
}
export function buildSeenTrace(n:100|400|1000|2000):FixedLoadTrace {
  const count=n===2000?4:2;
  return {batches:Array.from({length:n/count},(_,i)=>({atMs:i*2,count}))};
}
export async function compareSeenCase(spec:SeenComparisonCase) {
  const durationMs=spec.n===100?100:1000;
  if(![100,400,1000,2000].includes(spec.n)||!Number.isSafeInteger(spec.repeat)||spec.repeat<0||
    spec.order.length!==2||new Set(spec.order).size!==2||
    spec.order.some(x=>x!=="immutable"&&x!=="owned")||validateFixedTrace(spec.trace,durationMs)!==spec.n)
    throw Error("Invalid R16.5 fixed comparison");
  const results:Record<string,Awaited<ReturnType<typeof measureLoad>>>={};
  for(const mode of spec.order)results[mode]=await measureLoad({
    label:`R165-${spec.n}-${spec.repeat}-${mode}`,rate:spec.n===100?1000:spec.n,durationMs,
  },{diagnostic:`r165-fixed-${mode}`,commitPolicy:"coalesced",fixedTrace:spec.trace});
  const before=results.immutable,after=results.owned;
  const b=before.diagnostics?.worker?.seen,a=after.diagnostics?.worker?.seen;
  const boundaries=Array.from({length:Math.ceil(spec.n/128)},(_,i)=>Math.min(128,spec.n-i*128));
  const matched=!!(before.safeCompleted&&after.safeCompleted&&
    before.sentEvents===spec.n&&after.sentEvents===spec.n&&
    [before,after].every(r=>r.metrics?.persistedEvents===spec.n&&r.metrics?.appliedEvents===spec.n&&
      r.uncommittedEvents===0&&r.explicitlyLostEvents===0)&&
    before.storage?.auditHash===after.storage?.auditHash&&b&&a&&
    b.stateHash===a.stateHash&&b.journalHead===a.journalHead&&b.indexRoot===a.indexRoot&&
    checksum(b.transactions.map((x:{events:number})=>x.events))===checksum(boundaries)&&
    checksum(b.transactions.map((x:{events:number})=>x.events))===
      checksum(a.transactions.map((x:{events:number})=>x.events)));
  return {before,after,matched};
}
export async function runSeenComparisons() {
  const output=resolve(import.meta.dirname,"../../../.local/r165-measurements");
  mkdirSync(output,{recursive:true});
  const reports=[];
  for(const n of [100,400,1000,2000] as const) {
    for(let repeat=0;repeat<(n===100?1:3);repeat++) {
      const order=repeat%2?["owned","immutable"] as const:["immutable","owned"] as const;
      const pair=await compareSeenCase({n,repeat,order,trace:buildSeenTrace(n)});
      const report={n,repeat,order,...pair};
      reports.push(report);
      writeFileSync(join(output,`${n}-${repeat}.json`),JSON.stringify(report,null,2));
      console.log(JSON.stringify({n,repeat,matched:pair.matched,before:pair.before.actualPersistedEventsPerSecond,
        after:pair.after.actualPersistedEventsPerSecond,beforeStop:pair.before.stopReason,afterStop:pair.after.stopReason}));
      if(!pair.matched) {
        writeFileSync(join(output,"all.json"),JSON.stringify(reports,null,2));
        throw Error("Comparison stopped: incomplete, unsafe or unequal trial (retained in report)");
      }
    }
  }
  writeFileSync(join(output,"all.json"),JSON.stringify(reports,null,2));
  return reports;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  runSeenComparisons().catch(e=>{console.error(e);process.exitCode=1;});
