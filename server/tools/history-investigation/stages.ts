import "./offline.ts";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { coverageSegments } from "../../src/vp/trade-history.ts";
import { VolumeProfile } from "../../src/vp/state.ts";

// Separate tiny VP/coverage trials: do not repeat until CPU saturation.
const out = process.argv[2];
assert.match(out ?? "", /^data\/history-investigation-[a-zA-Z0-9_-]+$/);
const start = 1793275200;
const trades = Array.from({length:1200},(_,i)=>({
  tsUs:start*1e6+i*50000,recvUs:start*1e6+i*50000,seq:i,
  price:80000+i%200,size:1+i%3,side:i%2?"buy" as const:"sell" as const,
}));
const fragmented = Array.from({length:450},(_,i):[number,number]=>[start+2*i,start+2*i+1]);
const compact:[number,number][] = [[start,start+900]];
const functions = {
  vp:()=>{const v=new VolumeProfile(start);for(const t of trades)v.add(t);assert.equal(v.summary().total,2400);assert.equal(v.message().levels.length,200);},
  compact:()=>assert.equal(coverageSegments(compact,start,start+900).length,1),
  fragmented:()=>assert.equal(coverageSegments(fragmented,start,start+900).length,900),
};
const results=[];
for(const [name,work] of Object.entries(functions)) {
  work();work();
  for(let repetition=1;repetition<=3;repetition++) {
    let lateness=0;
    const expected=performance.now()+10;
    const tick=new Promise<void>(resolve=>setTimeout(()=>{lateness=Math.max(0,performance.now()-expected);resolve();},10));
    const before=performance.now(),cpuBefore=process.cpuUsage();work();
    const wallMs=performance.now()-before,cpu=process.cpuUsage(cpuBefore);
    await tick;await delay(10);
    results.push({name,repetition,wallMs,processCpuMs:(cpu.user+cpu.system)/1000,
      intervalCores:(cpu.user+cpu.system)/(wallMs*1000),timerLatenessMs:lateness});
  }
}
await fs.writeFile(`${out}/stages.json`,JSON.stringify({dummy:true,warmup:2,workPerTrial:1,
  input:{trades:1200,coverageSeconds:900,compactIntervals:1,fragmentedIntervals:450},
  note:"Very short process CPU intervals include V8/GC noise; do not extrapolate to public sustained CPU.",results},null,2));
console.log(results);
