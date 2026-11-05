import {test} from "node:test";
import assert from "node:assert/strict";
import {paired,frequency,searchLag} from "./gc_alignment_metrics.mjs";
test("lag convention and affine prices",()=>{
  const a=new Float64Array(1000),b=new Float64Array(1000),indices=[];
  for(let i=100;i<800;i++){a[i]=40000+i%37+(i*i%79);b[i+7]=a[i];indices.push(i);}
  assert.equal(paired(a,b,indices,7).correlation,1);
  assert.equal(paired(a,b,indices,7).maeTicks,0);
  const found=searchLag(a,b,indices);
  assert.equal(found.best.shift,7);
});
test("frequency does not count missing seconds as unchanged",()=>{
  const b=Int32Array.from([10,10,0,10,11]),a=Int32Array.from([12,12,0,12,12]);
  assert.deepEqual(frequency(b,a,[0,1,3,4]),{adjacent:2,changed:1,changeRate:.5,maxUnchangedSeconds:2,unchangedRunsAtLeast11Seconds:0});
});
test("undefined correlation on constant series; no false perfect match",()=>{
  const a=Float64Array.from([0,10,10,10]);
  assert.equal(paired(a,a,[1,2,3],0).correlation,null);
});
