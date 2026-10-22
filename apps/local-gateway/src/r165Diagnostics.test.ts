import { expect, it } from "vitest";
import { buildSeenTrace, compareSeenCase } from "./r165Diagnostics";
import { worker, validateFixedTrace, processRss, LOAD_LIMITS } from "./r16Load";
import { ownedDirectory, removeOwnedDirectory, config, eventAt, ns } from "./r16Fixtures";
import { StorageAdapter } from "./storageAdapter";
import { checksum } from "@workspace/storage/catalog";

it.each([100,400,1000,2000] as const)("fixes whole frames and approved schedule for %i", n=>{
  expect(validateFixedTrace(buildSeenTrace(n),n===100?100:1000)).toBe(n);
  expect(buildSeenTrace(n).batches.every(b=>128%b.count===0)).toBe(true);
});
it("rejects invalid comparison before creating any DB/process",async()=>{
  await expect(compareSeenCase({n:400,repeat:0,order:["owned","owned"],trace:buildSeenTrace(400)})).rejects.toThrow();
});
it.each((["immutable","owned"] as const).flatMap(mode=>
  (["before","transaction","publish","window"] as const).map(point=>[mode,point] as const)))(
  "%s crash restores only a verified whole prefix (%s)", async(mode,point)=>{
  const dir=ownedDirectory();
  try {
    const child=worker(`r165-crash-${mode}-${point}`,dir);
    let error="";
    child.stderr?.on("data",x=>{error+=String(x);});
    child.stdout?.resume();
    const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill("SIGKILL");reject(Error("Crash worker timeout"));},25_000);
      const guard=setInterval(()=>{
        try {if(processRss(child.pid!)>LOAD_LIMITS.workerRss ||
          processRss(child.pid!)+processRss(process.pid)>LOAD_LIMITS.totalRss)child.kill("SIGKILL");}
        catch {if(child.exitCode===null && child.signalCode===null)child.kill("SIGKILL");}
      },10);
      child.on("message",raw=>{if((raw as {kind:string}).kind==="commit-window")child.kill("SIGKILL");});
      child.on("error",reject);
      child.on("exit",(code,signal)=>{clearTimeout(timer);clearInterval(guard);resolve({code,signal});});
    });
    expect(error).toBe("");expect(exit.signal).toBe("SIGKILL");
    const restored=new StorageAdapter(dir);
    try {
      const id=restored.register(config(),ns(0)),rows=restored.journal.records(id);
      expect(rows.length).toBe(point==="publish"?2:point==="window"?rows.length:1);
      expect([1,2]).toContain(rows.length);
      expect(rows.map(r=>r.input)).toEqual(Array.from({length:rows.length},(_,i)=>({type:"EVENT",event:eventAt(i)})));
      expect(checksum(restored.stateSnapshot(id))).toBe(checksum(restored.journal.replay(id)));
    } finally {restored.close();}
  } finally {removeOwnedDirectory(dir);}
},30_000);
