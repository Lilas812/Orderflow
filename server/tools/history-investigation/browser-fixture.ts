// ダミー専用。製品entrypoint/上流/実保存を起動せず、実build + 実HubをHTTP配信。
import "./offline.ts";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { Hub, attachHub } from "../../src/hub/hub.ts";
import { defaults } from "../../src/settings/schema.ts";
import type { Column } from "../../src/aggregate/columns.ts";

const port = 25751, out = "data/history-browser-verification";
await fs.mkdir(out,{recursive:true});
const NOW=1793277000;
let columns:Column[]=[], generation=0, state="running", added:number[]=[];
let requests:{fromSec:number;toSec:number;columns:number;at:string}[]=[];
const make=(second:number,size:number,depth:number):Column=>({
  tsSec:second,source:"history",
  bids:Array.from({length:depth},(_,i)=>({price:80000-i,size})),
  asks:Array.from({length:depth},(_,i)=>({price:80001+i,size})),
});
const reset=()=>{
  generation++;state="running";added=[];requests=[];
  columns=[make(NOW-1200,120,20),make(NOW-1,120,20)];
};
reset();
const hub=new Hub({
  savedRange:()=>({fromSec:NOW-10800,toSec:NOW}),
  read:async(fromSec,toSec)=>{
    const result=columns.filter(c=>c.tsSec>=fromSec&&c.tsSec<toSec);
    requests.push({fromSec,toSec,columns:result.length,at:new Date().toISOString()});
    return {columns:result,trades:[]};
  },
  status:()=>({phase2a:{backfill:{state,startSec:NOW-10800,endSec:NOW,
    startedAtUs:(NOW-100+generation)*1e6,finishedAtUs:state==="complete"?(NOW+generation)*1e6:null}}}),
},(event,detail)=>console.log(JSON.stringify({dummy:true,event,...(detail as Record<string,unknown>)})),{
  now:()=>NOW*1000,later:(fn,ms)=>setTimeout(fn,ms),cancel:id=>clearTimeout(id as NodeJS.Timeout),
});
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url??"/","http://127.0.0.1");
    const json=(value:unknown,status=200)=>{res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(value));};
    if(url.pathname==="/__fixture/evidence") {
      json({dummy:true,pid:process.pid,nowSec:NOW,generation,state,added,requests,hub:hub.snapshot()});return;
    }
    if(url.pathname==="/__fixture/reset"&&req.method==="POST") {
      if(hub.snapshot().connected!==0){json({error:"close previous case browser first"},409);return;}
      reset();json({dummy:true,generation});return;
    }
    if(url.pathname==="/__fixture/late"&&req.method==="POST") {
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const {fromSec,toSec}=input;
      if(state!=="running"||!Number.isSafeInteger(fromSec)||!Number.isSafeInteger(toSec)
        ||fromSec<NOW-10800||toSec>NOW-1||fromSec>=toSec||toSec-fromSec>180) {
        json({error:"invalid dummy late range"},400);return;
      }
      for(let s=fromSec;s<toSec;s++){columns.push(make(s,400,40));added.push(s);}
      columns.sort((a,b)=>a.tsSec-b.tsSec);state="complete";hub.flush();
      json({dummy:true,added,hub:hub.snapshot()});return;
    }
    if(url.pathname==="/api/settings"&&req.method==="GET") {
      json({version:4,values:{...defaults,heatStyle:"block",heatLowerMode:"off",
        heatUpperMode:"size",heatUpperSize:500,heatGamma:1},updatedAt:null});return;
    }
    if(url.pathname.startsWith("/api/")){json({error:"dummy fixture has no other APIs"},404);return;}
    if(url.pathname==="/favicon.ico"){res.writeHead(204);res.end();return;}
    if(req.method!=="GET"){json({error:"method not allowed"},405);return;}
    const name=url.pathname==="/"?"index.html":url.pathname.slice(1);
    const root=path.resolve("artifacts/heatmap/dist/public"), file=path.resolve(root,name);
    if(!file.startsWith(root+"/")){json({error:"bad path"},400);return;}
    let body=await fs.readFile(file);
    if(name==="index.html") body=Buffer.from(body.toString().replace("<title>","<title>ダミー隔離検証 — ")
      .replace("</body>",'<div style="position:fixed;bottom:0;right:0;background:#fff;color:#900;font:12px monospace;z-index:99999;padding:3px">ダミー隔離データ・上流未接続</div></body>'));
    const type=file.endsWith(".html")?"text/html":file.endsWith(".js")?"text/javascript":file.endsWith(".css")?"text/css":"application/octet-stream";
    res.writeHead(200,{"content-type":type,"cache-control":"no-store"});res.end(body);
  } catch(e) {res.writeHead(500);res.end("dummy fixture error");console.error(e);}
});
const wss=attachHub(server,hub,origin=>origin===`http://127.0.0.1:${port}`);
await new Promise<void>(resolve=>server.listen(port,"127.0.0.1",resolve));
console.log(JSON.stringify({dummy:true,event:"fixture_ready",pid:process.pid,url:`http://127.0.0.1:${port}/?debug=1`}));
let stopping=false;
process.on("SIGTERM",()=>{
  if(stopping)return;stopping=true;
  const before=hub.snapshot();hub.stop();
  wss.close();
  server.close(async()=>{
    const cleanup={dummy:true,pid:process.pid,closedAt:new Date().toISOString(),before,after:hub.snapshot(),httpClosed:true,upstreamOpened:0};
    await fs.writeFile(`${out}/server-cleanup.json`,JSON.stringify(cleanup,null,2));
    console.log(JSON.stringify({event:"fixture_stopped",...cleanup}));
  });
  server.closeIdleConnections();
});
