import { expect, it } from "vitest";
import { checksum } from "@workspace/storage/catalog";
import { worker, processRss } from "./r16Load";
import { deterministicDeliveries, ownedDirectory, removeOwnedDirectory } from "./r16Fixtures";

async function execute(mode:string,dir:string,crash=false):Promise<Record<string,any>> {
  const child=worker(mode,dir);
  let result:Record<string,any>|null=null,stderr="",failure:string|null=null;
  child.stdout?.resume();child.stderr?.on("data",x=>{stderr=(stderr+String(x)).slice(-4096);});
  return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{failure="Integration safety deadline";child.kill("SIGKILL");},30_000);
    const memory=setInterval(()=>{
      if(result)return;
      try{
        const rss=processRss(child.pid!),combined=rss+processRss(process.pid);
        if(rss>512*1024*1024 || combined>768*1024*1024){failure="Integration RSS cap";child.kill("SIGKILL");}
      }catch{if(!child.killed && !result){failure="Integration RSS unavailable";child.kill("SIGKILL");}}
    },20);
    child.on("message",raw=>{
      const msg=raw as Record<string,any>;
      if(msg.kind==="result")result=msg;
      if(msg.kind==="committed" && crash){result=msg;child.send({kind:"crash-now"});}
    });
    child.on("error",e=>{clearTimeout(timer);clearInterval(memory);reject(e);});
    child.on("exit",(code,signal)=>{
      clearTimeout(timer);clearInterval(memory);
      if(failure || !result || (!crash && code!==0) || (crash && signal!=="SIGKILL"))
        reject(Error(failure??`Worker ${code}/${signal}: ${stderr}`));
      else resolve(result);
    });
  });
}
it("matches original, SQLite+chunk and restarted hashes, counts, quantities and cursor",async()=>{
  const dir=ownedDirectory();
  try{
    const before=checksum(deterministicDeliveries().map(event=>({type:"EVENT",event})));
    const saved=await execute("fixture",dir),restored=await execute("restore",dir);
    expect(saved.auditHash).toBe(before);expect(restored.auditHash).toBe(before);
    for(const report of [saved,restored]){
      expect(report).toMatchObject({auditCount:1010,uniqueAccepted:1000,committedCursor:"1010",finalBidQty:40,rangeRecords:1010});
    }
    expect(saved.chunkBytes).toBeGreaterThan(0);
    expect(restored.metrics).toMatchObject({lastPersistedPosition:"1010",lastAppliedPosition:"1000",counterWindow:"THIS_PROCESS_SESSION",receivedEvents:0});
    console.log("R16_RESTART",JSON.stringify({hash:before,saved,restored}));
  }finally{removeOwnedDirectory(dir);}
},30_000);
it("SIGKILL inside transaction restores only committed audit and the original canonical book",async()=>{
  const dir=ownedDirectory();
  try{
    const crash=await execute("crash",dir,true);expect(crash.position).toBe("1010");
    const restored=await execute("restore",dir);
    expect(restored).toMatchObject({auditCount:1010,uniqueAccepted:1000,committedCursor:"1010",finalBidQty:40});
    expect(restored.auditHash).toBe(checksum(deterministicDeliveries().map(event=>({type:"EVENT",event}))));
    console.log("R16_SIGKILL",JSON.stringify(restored));
  }finally{removeOwnedDirectory(dir);}
},30_000);
