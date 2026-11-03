import { test } from "node:test";
import assert from "node:assert/strict";
import { localCandidates, localDateTime, replayPreferences } from "../src/replay/time.ts";
import { LayerScheduler } from "../src/chart/layer-scheduler.ts";
test("JST and CT date input roundtrip, including DST folds and missing hours", () => {
  const sec = Date.parse("2026-10-29T17:42:00Z") / 1000;
  assert.equal(localDateTime(sec, "jst"), "2026-10-30T02:42:00");
  assert.equal(localDateTime(sec, "ct"), "2026-10-29T12:42:00");
  for (const zone of ["jst", "ct"] as const) assert.equal(localCandidates(localDateTime(sec, zone), zone)[0]?.sec, sec);
  assert.equal(localCandidates("2026-11-01T01:30:00", "ct").length, 2);
  assert.deepEqual(localCandidates("2026-11-01T01:30:00", "ct").map(v => v.offset), ["UTC-05:00", "UTC-06:00"]);
  assert.deepEqual(localCandidates("2026-03-08T02:30:00", "ct"), []);
  assert.deepEqual(localCandidates("2026-02-30T12:00:00", "jst"), []);
});
test("tab preferences tolerate blocked or invalid storage without settings PUT", () => {
  assert.deepEqual(replayPreferences({ getItem: () => { throw Error("blocked"); } }), { speed: 1, step: 1 });
  assert.deepEqual(replayPreferences({ getItem: k => k.endsWith("speed") ? "60" : "10" }), { speed: 60, step: 10 });
  assert.deepEqual(replayPreferences({ getItem: () => "999" }), { speed: 1, step: 1 });
});
test("high-speed replay paints depth despite a trade batch every RAF; live latest-first can be restored", () => {
  const queue:(()=>void)[]=[],calls:string[]=[];
  const scheduler=new LayerScheduler(f=>queue.push(f),{
    depth:()=>calls.push("depth"),trades:()=>calls.push("trades"),book:()=>{},
    after:()=>{},
  },true);
  scheduler.setLatestFirst(false);
  for(let i=0;i<60;i++){scheduler.request("all");queue.shift()!();}
  assert.equal(calls.filter(v=>v==="depth").length,60);
  scheduler.setLatestFirst(true);calls.length=0;scheduler.request("all");queue.shift()!();
  assert.deepEqual(calls,["trades"]);queue.shift()!();assert(calls.includes("depth"));
});
