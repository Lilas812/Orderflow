/** Paid raw inputs already exist. This program performs no network requests. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanDbn } from "./mbo_dbn.mjs";
import { packed } from "./gc_board_metrics.mjs";
import { decodeMbp10, SecondSampler, BookMetrics } from "./mbp10_metrics.mjs";
import { columnFileRange } from "../server/src/store/records.ts";
import { digest } from "../server/src/store/objects.ts";
if (os.getPriority() < 19) throw Error("run_with_nice_-n_19");
const root = path.resolve("data/research-v2/mbp10-check-01");
const windows = JSON.parse(fs.readFileSync(path.join(root, "windows.json")));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
if (manifest.length !== 3) throw Error("incomplete_raw_manifest");
const reports = [];
for (const window of windows) {
  const input = manifest.find(m => m.label === window.label);
  if (input?.file !== `raw/GCZ26-${window.start.slice(0,13)}.mbp10.dbn.zst`)
    throw Error("raw_path_outside_authorized_window");
  if (!input || JSON.stringify(input.parameters) !== JSON.stringify({
    dataset:"GLBX.MDP3",symbols:"GCZ6",stype_in:"raw_symbol",schema:"mbp-10",start:window.start,end:window.end
  })) throw Error("raw_window_mismatch");
  const start = Date.parse(window.start) / 1000, end = start + 3600;
  const sampler = new SecondSampler(start, end);
  let metadata, id;
  const parsed = await scanDbn(path.join(root, input.file), meta => {
    metadata = meta;
    if (meta.schema !== 2 || meta.dataset !== "GLBX.MDP3" ||
        BigInt(meta.startNs) !== BigInt(start)*1000000000n || BigInt(meta.endNs) !== BigInt(end)*1000000000n)
      throw Error("mbp10_metadata_mismatch");
    const ids = meta.mappings.filter(m=>m.raw==="GCZ6").flatMap(m=>m.intervals
      .filter(i=>i.from<=20261103&&i.to>20261103).map(i=>+i.symbol));
    if (ids.length !== 1 || meta.notFound.length || meta.partial.length) throw Error("ambiguous_contract");
    id = ids[0];
  }, record => {
    const row = decodeMbp10(record);
    if (row.instrumentId !== id) throw Error("unexpected_mbp_contract");
    sampler.accept(row);
  });
  if (parsed.compressedSha256 !== input.sha256) throw Error("mbp10_hash_mismatch");
  const reference = sampler.finish(), mbo = new Map(), app = new Map();
  const hh = window.start.slice(11,13), day = window.start.slice(0,10);
  const mboFile = path.resolve("data/research-v2/mbo-01/rebuilt/GCZ26", day, hh+".bin.gz");
  const mboSummary=JSON.parse(fs.readFileSync(path.join(path.dirname(mboFile),"summary.json")));
  if(mboSummary.status!=="complete"||mboSummary.contract!=="GCZ26")throw Error("incomplete_mbo_reconstruction");
  const appFile = path.join(root,"app-copy",day+"-"+hh+".bin.gz");
  if (await digest(appFile) !== window.sha256) throw Error("app_copy_hash_mismatch");
  for await (const c of columnFileRange(mboFile,start,end)) mbo.set(c.tsSec,packed(c));
  for await (const c of columnFileRange(appFile,start,end)) app.set(c.tsSec,packed(c));
  const stats = {mbo:new BookMetrics(),app:new BookMetrics(),mboCommonCohort:new BookMetrics(),
    appCommonCohort:new BookMetrics()};
  const appSource = {}, examples = [];
  const quarter = Array.from({length:4},()=>({mbo:new BookMetrics(),app:new BookMetrics()}));
  for (let s=start;s<end;s++) {
    const r=reference.rows.get(s), m=mbo.get(s), a=app.get(s);
    if (!r) continue;
    if(m) {stats.mbo.add(m,r);quarter[Math.floor((s-start)/900)].mbo.add(m,r);}
    if(a) {
      stats.app.add(a,r);quarter[Math.floor((s-start)/900)].app.add(a,r);
      (appSource[a.source]??=new BookMetrics()).add(a,r);
    }
    if(m&&a){stats.mboCommonCohort.add(m,r);stats.appCommonCohort.add(a,r);}
    if(m&&(m.bids[0]!==r.bids[0]||m.asks[0]!==r.asks[0])&&examples.length<5)
      examples.push({second:s,mbo:{bids:[...m.bids.slice(0,20)],asks:[...m.asks.slice(0,20)]},
        mbp10:{bids:r.bids,asks:r.asks}});
  }
  const {rows:ignored,...sampling}=reference;
  const report={label:window.label,start:window.start,end:window.end,raw:input,metadata,parsed,sampling,
    mboSeconds:mbo.size,appSeconds:app.size,mboDerivedSha256:await digest(mboFile),
    mboInputSha256:mboSummary.inputSha256,
    appGeneration:window.generation,appSha256:window.sha256,
    comparisons:Object.fromEntries(Object.entries(stats).map(([k,v])=>[k,v.result()])),
    appSource:Object.fromEntries(Object.entries(appSource).map(([k,v])=>[k,v.result()])),
    quarter:quarter.map(q=>({mbo:q.mbo.result(),app:q.app.result()})),examples};
  reports.push(report);
  console.log(JSON.stringify({label:window.label,sampling,mbo:report.comparisons.mbo,
    app:report.comparisons.app}));
}
fs.writeFileSync(path.join(root,"comparison.json"),JSON.stringify({reports,
  method:"Last full MBP-10 row per ts_event second, stable file-order tie, quiet seconds carried only after known good state. No app gap fill. Each row contains top10 so F_LAST is diagnostic, not required to reconstruct MBP. Prices integer GC ticks, event timestamp integer nanoseconds.",
},null,2));
fs.writeFileSync(path.join(root,"raw/SHA256SUMS"),
  manifest.map(m=>`${m.sha256}  ${path.basename(m.file)}`).join("\n")+"\n");
