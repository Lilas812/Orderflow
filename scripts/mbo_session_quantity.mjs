/** Descriptive offline trend only: growth is not by itself proof of missed cancellations. */
import fs from "node:fs";
import path from "node:path";
import { columnFileRange } from "../server/src/store/records.ts";
import { Distribution } from "./gc_board_metrics.mjs";
const root = path.resolve("data/research-v2/mbo-01/rebuilt/GCZ26");
const start = Date.parse("2026-11-02T23:00:00Z") / 1000, end = start + 23 * 3600;
const rows = [], minutes = [];
let before = null, increases = 0, decreases = 0;
for (let hour = start; hour < end; hour += 3600) {
  const utc = new Date(hour * 1000).toISOString();
  const file = path.join(root, utc.slice(0, 10), utc.slice(11, 13) + ".bin.gz");
  if (!fs.existsSync(file)) throw Error("session_reconstruction_missing");
  const q = new Distribution(), totals = new Distribution();
  let seconds = 0, sum = 0, full = 0;
  const minute = new Map();
  for await (const c of columnFileRange(file, hour, hour + 3600)) {
    const value = [...c.bids.slice(0, 10), ...c.asks.slice(0, 10)].reduce((n,l) => n + l.size, 0);
    const all = [...c.bids, ...c.asks].reduce((n,l) => n + l.size, 0);
    seconds++; sum += value; full += all; q.add(value); totals.add(all);
    const key = Math.floor((c.tsSec - start) / 60), m = minute.get(key) ?? {minute:key, sum:0,n:0};
    m.sum += value; m.n++; minute.set(key,m);
    if (before !== null) { if (value > before) increases++; if (value < before) decreases++; }
    before = value;
  }
  minutes.push(...[...minute.values()].map(m=>({minute:m.minute, mean:m.sum/m.n})));
  rows.push({ utcHour:utc, seconds, meanTop10Both:seconds?sum/seconds:null,
    meanWholeSavedWindow:seconds?full/seconds:null, top10:q.result(), wholeWindow:totals.result() });
}
const n = minutes.length, mx = minutes.reduce((s,m)=>s+m.minute,0)/n, my=minutes.reduce((s,m)=>s+m.mean,0)/n;
const xx=minutes.reduce((s,m)=>s+(m.minute-mx)**2,0), yy=minutes.reduce((s,m)=>s+(m.mean-my)**2,0);
const xy=minutes.reduce((s,m)=>s+(m.minute-mx)*(m.mean-my),0);
const result={startUtc:new Date(start*1000).toISOString(),endUtc:new Date(end*1000).toISOString(),
  ctSessionStart:"2026-11-02 17:00 CST",rows,minuteSamples:n,increases,decreases,
  slopeContractsPerMinute:xy/xx,pearsonMinuteVersusTop10:xy/Math.sqrt(xx*yy),
  note:"Top10 and whole saved 400-tick-per-side window; naturally affected by liquidity, prices and clipping. Separate UTC-day snapshot initializations. Not proof of correct/incorrect cancellation."};
fs.writeFileSync("data/research-v2/mbp10-check-01/session-quantity.json",JSON.stringify(result,null,2));
console.log(JSON.stringify({minutes:n,increases,decreases,slope:result.slopeContractsPerMinute,
  correlation:result.pearsonMinuteVersusTop10,hourly:rows.map(r=>[r.utcHour,r.seconds,r.meanTop10Both,r.meanWholeSavedWindow])}));
