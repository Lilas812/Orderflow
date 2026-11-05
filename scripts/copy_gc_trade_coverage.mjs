/** Research-only read of one cloud index. Never creates a production store/writer. */
import fs from "node:fs";
import path from "node:path";
import { ReplitObjects, digest } from "../server/src/store/objects.ts";
const root = path.resolve("data/research-v2/gc-trade-coverage-03");
fs.mkdirSync(root, {recursive:true});
const file=path.join(root,"coverage.json"), manifest=path.join(root,"coverage-input.json");
try {
  const objects=new ReplitObjects();
  const name="prod/instruments/GC/coverage.json";
  if(!fs.existsSync(manifest)){
    const generation=await objects.downloadVersion(name,file);
    if(generation===null)throw Error("coverage_not_found");
    fs.writeFileSync(manifest,JSON.stringify({name,generation,file:path.relative(process.cwd(),file),
      sha256:await digest(file),bytes:fs.statSync(file).size,copiedAt:new Date().toISOString()},null,2)+"\n");
  }
  const original=JSON.parse(fs.readFileSync(manifest));
  if(await digest(file)!==original.sha256)throw Error("index_copy_changed");
  const v=JSON.parse(fs.readFileSync(file,"utf8"));
  if(!Array.isArray(v.tick))throw Error("invalid_coverage");
  const previous=JSON.parse(fs.readFileSync("data/research-v2/gc-alignment-02/inputs.json"))
    .filter(r=>r.name.includes("/trades/"));
  const outFile=path.join(root,"trade-inputs.json");
  const rows=fs.existsSync(outFile)?JSON.parse(fs.readFileSync(outFile)):[];
  for(const old of previous){
    const prior=rows.find(r=>r.name===old.name);
    if(prior){if(await digest(prior.file)!==prior.sha256)throw Error("trade_copy_changed");continue;}
    const dest=path.join(root,"copies",old.name);
    const generation=await objects.downloadVersion(old.name,dest);
    if(generation===null)throw Error("trade_disappeared");
    rows.push({name:old.name,generation,file:dest,sha256:await digest(dest),previousSha256:old.sha256});
    fs.writeFileSync(outFile,JSON.stringify(rows,null,2)+"\n");
  }
  const after=path.join(root,"coverage-after.json");
  const afterGeneration=await objects.downloadVersion(name,after);
  if(afterGeneration===null)throw Error("coverage_disappeared");
  const clip=rs=>rs.map(([a,b])=>[Math.max(a,1793232000),Math.min(b,1793750400)]).filter(([a,b])=>a<b);
  const unchanged=JSON.stringify(clip(v.tick))===JSON.stringify(clip(JSON.parse(fs.readFileSync(after)).tick));
  const result={...original,afterGeneration,afterSha256:await digest(after),historicalTickRangesUnchanged:unchanged,
    copiedTradeFiles:rows.length,changedTradeHashes:rows.filter(r=>r.sha256!==r.previousSha256).map(r=>r.name)};
  fs.writeFileSync(path.join(root,"copy-result.json"),JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result));
  if(!unchanged)throw Error("historical_coverage_changed");
}catch{console.error("coverage_read_failed; no SDK details logged");process.exitCode=1;}
