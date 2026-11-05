/** Derive fixed-cohort lag/BBO tests and readable tables from local compact BBO data. */
import fs from "node:fs";
import path from "node:path";
import {createInterface} from "node:readline";
import {paired} from "./gc_alignment_metrics.mjs";
const dir=path.resolve("data/research-v2/gc-alignment-02");
const start=Date.parse("2026-10-29")/1000,len=6*86400;
const ab=new Int32Array(len),aa=new Int32Array(len),mb=new Int32Array(len),ma=new Int32Array(len);
const x=new Float64Array(len),y=new Float64Array(len);
// Reference BBO beyond app observations is read from the existing binary files by the main analysis;
// the compact CSV has only app seconds. For near-lag fixed support require all neighbors explicitly.
const all=[];
const reader=createInterface({input:fs.createReadStream(path.join(dir,"bbo.csv")),crlfDelay:Infinity});
for await(const line of reader) {
  if(line.startsWith("tsSec"))continue;
  const [sec,b,a,,rb,ra]=line.split(",");
  const i=+sec-start;
  ab[i]=+b;aa[i]=+a;mb[i]=+rb;ma[i]=+ra;
  x[i]=(+b+ +a)/2;if(rb&&ra)y[i]=(+rb+ +ra)/2;
  all.push(i);
}
const near=all.filter(i=>Array.from({length:13},(_,j)=>i+j-6).every(k=>k>=0&&k<len&&mb[k]));
const shifts=[];
for(let shift=-6;shift<=6;shift++) {
  let bid=0,ask=0,both=0;
  for(const i of near){const j=i+shift;bid+=ab[i]===mb[j]?1:0;ask+=aa[i]===ma[j]?1:0;both+=ab[i]===mb[j]&&aa[i]===ma[j]?1:0;}
  shifts.push({shift,pairs:near.length,bid,ask,both,...paired(x,y,near,shift)});
}
let common=0,wider=0,worse=0,appStillReferenceChanges=0,appChangesReferenceStill=0,consecutive=0;
for(const i of all) {
  if(!mb[i])continue;common++;
  if(aa[i]-ab[i]>ma[i]-mb[i])wider++;
  if(ab[i]<mb[i]||aa[i]>ma[i])worse++;
  if(i>0&&ab[i-1]&&mb[i-1]) {
    consecutive++;
    const ac=ab[i]!==ab[i-1]||aa[i]!==aa[i-1],bc=mb[i]!==mb[i-1]||ma[i]!==ma[i-1];
    if(!ac&&bc)appStillReferenceChanges++;
    if(ac&&!bc)appChangesReferenceStill++;
  }
}
const board=JSON.parse(fs.readFileSync(path.join(dir,"board-analysis.json")));
const result={fixedCohortNote:"All 13 MBO BBO seconds also have app observations; no missing seconds carried",
  shifts,common,wider,worse,consecutive,appStillReferenceChanges,appChangesReferenceStill};
fs.writeFileSync(path.join(dir,"fixed-cohort.json"),JSON.stringify(result,null,2)+"\n");
const csv=["utc_hour,app_seconds,reference_seconds,common_seconds,bid_match_pct,ask_match_pct,both_match_pct,adjacent_common_pairs,app_bbo_change_pct,reference_bbo_change_pct"];
for(const r of board.hourly)csv.push([r.utcHour,r.appSeconds,r.referenceSeconds,r.pairs,
  ...["bidMatches","askMatches","bothMatches"].map(k=>r.pairs?100*r[k]/r.pairs:""),
  r.appFrequency.adjacent,100*r.appFrequency.changeRate,100*r.referenceFrequencySameSeconds.changeRate].join(","));
fs.writeFileSync(path.join(dir,"hourly.csv"),csv.join("\n")+"\n");
console.log(JSON.stringify({fixedPairs:near.length,common,wider,worse,consecutive,appStillReferenceChanges,appChangesReferenceStill,shifts}));
