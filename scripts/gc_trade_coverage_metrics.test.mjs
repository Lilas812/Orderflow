import test from "node:test";
import assert from "node:assert/strict";
import {covered,compareCells,sideOf} from "./gc_trade_coverage_metrics.mjs";
test("coverage includes quiet seconds, excludes endpoints and holes",()=>{
  const r=[[10,13],[20,22]];
  for(const sec of [10,11,12,20,21])assert.equal(covered(r,sec),true);
  for(const sec of [9,13,19,22])assert.equal(covered(r,sec),false);
});
test("fragmented same-price trades preserve volume while counts differ",()=>{
  assert.deepEqual(compareCells(new Map([["p",{size:4,count:4}]]),
    new Map([["p",{size:4,count:1}]])),{overlap:4,missing:0,extra:0,countL1:3});
});
test("missing and extra cannot cancel across prices, unknown stays separate",()=>{
  assert.deepEqual(compareCells(new Map([["p1",{size:3,count:1}]]),
    new Map([["p2",{size:3,count:1}]])),{overlap:0,missing:3,extra:3,countL1:2});
  assert.equal(sideOf("N"),"unknown");assert.equal(sideOf("A"),"sell");
});
