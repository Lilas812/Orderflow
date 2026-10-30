/** Select a fixed 60s replay workload from the pinned one-hour production copy. */
import fs from "node:fs/promises";
import { tradeFileRows } from "../src/store/records.ts";
const dir="data/gpu-heatmap/production-input";
const manifest=JSON.parse(await fs.readFile(`${dir}/manifest.json`,"utf8"));
const from=manifest.chosen.start, counts=new Uint32Array(3600), quantity=new Float64Array(3600);
for(const c of manifest.copied)if(c.name.includes("/trades/GC/")){
  for await(const t of tradeFileRows(c.local)){
    const i=Math.floor(t.tsUs/1e6)-from;if(i>=0&&i<3600){counts[i]++;quantity[i]+=t.size;}
  }
}
const missing=new Set<number>(manifest.symbols.GC.missingSeconds);
const windows=[];
for(let offset=60;offset<=3540;offset++){
  let gaps=0,n=0,q=0;
  for(let i=offset;i<offset+60;i++){if(missing.has(from+i))gaps++;n+=counts[i]!;q+=quantity[i]!;}
  windows.push({offset,gaps,trades:n,quantity:q});
}
windows.sort((a,b)=>a.gaps-b.gaps||b.trades-a.trades||b.quantity-a.quantity||a.offset-b.offset);
const w=windows[0]!;
const result={...w,sourceUTC:[new Date((from+w.offset)*1000).toISOString(),new Date((from+w.offset+60)*1000).toISOString()],
  input:manifest.input,selection:"Least missing GC seconds, then most GC trades in a 60s window within the fixed hour",
  rate:"1x exchange time; 250ms deliveries preserve file order, no artificial trades or book columns"};
await fs.writeFile(`${dir}/measurement.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
