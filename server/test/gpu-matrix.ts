/** Serial 60s x 3 fixed-input comparisons. No real upstream/persistent settings. */
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
const arg=(key:string)=>process.argv.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
const renderer=arg("renderer");
if(renderer!=="canvas"&&renderer!=="webgl")throw Error("renderer_required");
const front=arg("front");
const root=`data/gpu-heatmap/matrix-${renderer}`;
const m=JSON.parse(await fs.readFile("data/gpu-heatmap/production-input/measurement.json","utf8"));
await fs.mkdir(root,{recursive:true});
const outcomes=[];
matrix:for(let round=1;round<=3;round++)for(const symbol of ["NQ","GC"])for(const dpr of [1,2,3]){
  const out=`${root}/round${round}-${symbol}-dpr${dpr}`;
  const command=["server/test/smoothing-live-check.ts","--matrix",`--symbol=${symbol}`,`--dpr=${dpr}`,
    "--seconds=60","--batches=241",`--renderer=${renderer}`,`--seed-seconds=${m.offset}`,
    `--replay-input=${m.input.file}`,`--out=${out}`,...(front?[`--front=${front}`]:[])];
  const child=spawn(process.execPath,command,{stdio:["ignore","pipe","pipe"]});
  let log="";child.stdout.on("data",b=>log+=b);child.stderr.on("data",b=>log+=b);
  const code=await new Promise<number|null>(resolve=>child.once("exit",resolve));
  await fs.writeFile(`${out}/runner.log`,log).catch(async()=>{await fs.mkdir(out,{recursive:true});await fs.writeFile(`${out}/runner.log`,log)});
  const row={renderer,round,symbol,dpr,code,out,inputHash:m.input.sha256,front:front??"candidate dist"};
  outcomes.push(row);await fs.writeFile(`${root}/runs.json`,JSON.stringify(outcomes,null,2));
  console.log(JSON.stringify(row));
  const result=JSON.parse(await fs.readFile(`${out}/real-ws.json`,"utf8"))[0];
  if(result.error||!result.browserClosed?.exited||!result.serverClosed) {
    console.error(JSON.stringify({stop:"invalid_run_or_cleanup",result}));process.exitCode=1;break matrix;
  }
}
