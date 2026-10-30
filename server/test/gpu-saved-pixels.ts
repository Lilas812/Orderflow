/** Small, unmodified slice of the pinned production inputs for pixel, not speed, checks. */
import fs from "node:fs/promises";
import { columnFileRange, tradeFileRows } from "../src/store/records.ts";
import { digest } from "../src/store/objects.ts";
const root="data/gpu-heatmap/production-input";
const m=JSON.parse(await fs.readFile(`${root}/manifest.json`,"utf8"));
const from=m.chosen.start,to=from+240,boards:Record<string,unknown[]>={},trades:Record<string,unknown[]>={};
for(const symbol of ["NQ","GC"]){
  boards[symbol]=[];trades[symbol]=[];
  for(const f of m.copied){
    if(f.name.includes(`/columns/${symbol}/1s/`)){
      const match=/(\d{4}-\d{2}-\d{2})\/(\d{2})\.bin\.gz$/.exec(f.name)!;
      const hour=Date.parse(`${match[1]}T${match[2]}:00:00Z`)/1000;
      if(hour>=to||hour+3600<=from)continue;
      for await(const c of columnFileRange(f.local,from,to))boards[symbol].push(c);
    }else if(f.name.includes(`/trades/${symbol}/`)){
      const match=/(\d{4}-\d{2}-\d{2})\/(\d{2})\.jsonl\.gz$/.exec(f.name)!;
      const hour=Date.parse(`${match[1]}T${match[2]}:00:00Z`)/1000;
      if(hour>=to||hour+3600<=from)continue;
      for await(const t of tradeFileRows(f.local))if(t.tsUs>=from*1e6&&t.tsUs<to*1e6)trades[symbol].push(t);
    }
  }
}
const file=`${root}/pixel-input.json`;
await fs.writeFile(file,JSON.stringify({from,to,boards,trades,inputHash:m.input.sha256}));
console.log(JSON.stringify({file,sha256:await digest(file),bytes:(await fs.stat(file)).size}));
