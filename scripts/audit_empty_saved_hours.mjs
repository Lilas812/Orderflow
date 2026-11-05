/** Read-only cloud/local inventory. No writer, API requests, coverage repair or upstream. */
import fs from "node:fs/promises";
import {createReadStream} from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {createGunzip} from "node:zlib";
import {ReplitObjects,digest} from "../server/src/store/objects.ts";
import {inspectBookSeconds} from "../server/src/store/book-seconds.ts";
import {clipRanges,coveredHours} from "../server/src/store/coverage.ts";
import {createRequire} from "node:module";
const {Storage}=createRequire(new URL("../server/src/store/objects.ts",import.meta.url))("@google-cloud/storage");
const root=path.resolve(process.argv[2]??"data/research-v2/save-evidence-fix-audit");
await fs.mkdir(root,{recursive:true});
const objects=new ReplitObjects();
const prior=await fs.readFile(path.join(root,"progress.json"),"utf8").then(JSON.parse,()=>({rows:[],indexes:[]}));
const rows=prior.rows,indexes=prior.indexes;
// Same existing sidecar authentication as ReplitObjects, read-only listing.
// Listing exposes generation, avoiding one metadata RPC per copied file.
const storage=new Storage({projectId:"",credentials:{audience:"replit",subject_token_type:"access_token",
  type:"external_account",token_url:"http://127.0.0.1:1106/token",universe_domain:"googleapis.com",
  credential_source:{url:"http://127.0.0.1:1106/credential",format:{type:"json",subject_token_field_name:"access_token"}}}});
const bucket=storage.bucket(process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID);
const seconds=r=>r.reduce((n,[a,b])=>n+b-a,0);
async function countTrades(file,hour){
  const raw=createReadStream(file),input=raw.pipe(createGunzip()),r=readline.createInterface({input,crlfDelay:Infinity});
  let count=0,failure;input.on("error",e=>{failure=e;r.close();});
  try{for await(const line of r)if(line){const t=JSON.parse(line);
    if(!Number.isSafeInteger(t.tsUs)||Math.floor(t.tsUs/3.6e9)!==hour/3600)throw Error("bad_trade_hour");count++;
  }if(failure)throw failure;return count;}finally{r.close();input.destroy();raw.destroy();}
}
for(const symbol of ["NQ","GC"]){
  const base="prod/"+(symbol==="GC"?"instruments/GC/":""),idx=path.join(root,symbol+"-coverage.json");
  let sourceIndex=indexes.find(r=>r.symbol===symbol&&!r.location);
  if(!sourceIndex){
    const generation=await objects.downloadVersion(base+"coverage.json",idx);
    if(generation===null)throw Error("missing_coverage");
    sourceIndex={symbol,generation,sha256:await digest(idx)};indexes.push(sourceIndex);
  }
  if(await digest(idx)!==sourceIndex.sha256)throw Error("saved_index_changed");
  const index=JSON.parse(await fs.readFile(idx,"utf8"));
  for(const kind of ["book","tick"]){
    const prefix=base+(kind==="book"?`columns/${symbol}/1s/`:`trades/${symbol}/`);
    const [listed]=await bucket.getFiles({prefix});
    const versions=new Map(listed.map(f=>[f.name,String(f.metadata.generation)]));
    const names=new Set(versions.keys());
    const hours=new Set([...coveredHours(index[kind])]);
    for(const name of names){
      const m=name.match(/(\d{4}-\d\d-\d\d)\/(\d\d)\.(?:bin|jsonl)\.gz$/);
      if(m)hours.add(Date.parse(`${m[1]}T${m[2]}:00:00Z`)/1000);
    }
    const todo=[...hours].sort((a,b)=>a-b).filter(hour=>!rows.some(r=>r.location==="cloud"&&r.symbol===symbol&&r.kind===kind&&Date.parse(r.utcHour)/1000===hour));
    const work=async hour=>{
      const iso=new Date(hour*1000).toISOString(),name=prefix+iso.slice(0,10)+"/"+iso.slice(11,13)+(kind==="book"?".bin.gz":".jsonl.gz");
      const cov=seconds(clipRanges(index[kind],hour,hour+3600));
      const file=path.join(root,`own-${symbol}-${kind}-${hour}`+(kind==="book"?".bin.gz":".jsonl.gz"));
      const row={location:"cloud",symbol,kind,utcHour:iso,coverageSeconds:cov,present:names.has(name),
        count:0,generation:null,sha256:null,error:null};
      try{
        if(row.present){
          row.generation=await objects.downloadVersion(name,file,versions.get(name));if(row.generation===null)throw Error("object_disappeared");
          row.sha256=await digest(file);
          row.count=kind==="book"?(await inspectBookSeconds(file,hour)).count:await countTrades(file,hour);
        }
      }catch{row.count=null;row.error="read_or_decode_failed";}
      finally{await fs.rm(file,{force:true});}
      rows.push(row);
    };
    for(let i=0;i<todo.length;i+=4){
      await Promise.all(todo.slice(i,i+4).map(work)); // at most four small object reads; no production VM requests.
      await fs.writeFile(path.join(root,"progress.json"),JSON.stringify({indexes,rows},null,2)+"\n");
    }
  }
  const after=path.join(root,symbol+"-coverage-after.json");
  const afterGeneration=await objects.downloadVersion(base+"coverage.json",after);
  sourceIndex.afterGeneration=afterGeneration;
  sourceIndex.afterSha256=await digest(after);
  // Running receiver may legitimately extend current ranges; retain both snapshots.
}
for(const symbol of ["NQ","GC"]){
  const local=symbol==="NQ"?"data":"data/instruments/GC";
  let index;try{index=JSON.parse(await fs.readFile(path.join(local,"coverage.json"),"utf8"));}
  catch{indexes.push({symbol,location:"local",error:"index_unavailable"});continue;}
  for(const kind of ["book","tick"]){
    for(const hour of coveredHours(index[kind])){
      const iso=new Date(hour*1000).toISOString(),prefix=kind==="book"?`columns/${symbol}/1s`:`trades/${symbol}`;
      let file=path.join(local,prefix,iso.slice(0,10),iso.slice(11,13)+(kind==="book"?".bin":".jsonl.gz"));
      let present=true;if(kind==="book"){try{await fs.access(file);}catch{file+=".gz";}}
      try{await fs.access(file);}catch{present=false;}
      const row={location:"local",symbol,kind,utcHour:iso,coverageSeconds:seconds(clipRanges(index[kind],hour,hour+3600)),present,count:0,error:null};
      try{if(present)row.count=kind==="book"?(await inspectBookSeconds(file,hour)).count:await countTrades(file,hour);}
      catch{row.count=null;row.error="read_or_decode_failed";}
      rows.push(row);
    }
  }
}
const suspicious=rows.filter(r=>r.coverageSeconds>0&&(r.count===0||r.count===null));
const result={checkedAt:new Date().toISOString(),indexes,rows,suspicious,
  note:"Empty is not proof of no exchange trades. Missing local files can be an intentional cloud cache eviction; cloud errors are not zero. No repair executed."};
await fs.writeFile(path.join(root,"result.json"),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({complete:true,checkedHours:rows.length,suspicious}));
