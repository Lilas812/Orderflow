import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareCanvas} from '../src/lib/chart-canvas.ts';

test('backing store is retained until dimensions or DPR actually change',()=>{
  let width=0,height=0,resets=0,transforms=0;
  const ctx={setTransform(){transforms++;}};
  const cv={
    get width(){return width;},set width(v){width=v;resets++;},
    get height(){return height;},set height(v){height=v;resets++;},
    getContext(type){assert.equal(type,'2d');return ctx;},
  };
  assert.equal(prepareCanvas(cv,400,500,2),ctx);
  assert.equal(resets,2);
  for(let i=0;i<100;i++)prepareCanvas(cv,400,500,2);
  assert.equal(resets,2);
  prepareCanvas(cv,400,500,3);assert.equal(resets,4);
  prepareCanvas(cv,401,500,3);assert.equal(resets,5);
  assert.equal(transforms,103);
});

test('fractional CSS sizes are rounded deterministically',()=>{
  const ctx={setTransform(){}};
  const cv={width:0,height:0,getContext(){return ctx;}};
  prepareCanvas(cv,320.4,460.2,2);
  assert.equal(cv.width,641);assert.equal(cv.height,920);
});
