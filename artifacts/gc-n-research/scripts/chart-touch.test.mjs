import test from 'node:test';
import assert from 'node:assert/strict';
import { touchView } from '../src/lib/chart-touch.ts';
const v = { t0: 0, t1: 1000, p0: 100, p1: 200 };
const plot = { x0: 0, x1: 200, top: 0, bottom: 200 };
test('one finger pans without changing scale', () => {
  assert.deepEqual(touchView(v, [{x:100,y:100}], [{x:120,y:120}], plot, true),
    {t0:-100,t1:900,p0:110,p1:210});
});
test('pinch doubles both scales around the stationary midpoint', () => {
  assert.deepEqual(touchView(v,[{x:75,y:100},{x:125,y:100}],
    [{x:50,y:100},{x:150,y:100}],plot,true), {t0:250,t1:750,p0:125,p1:175});
});
test('moving pinch centroid preserves its data anchor', () => {
  const a=touchView(v,[{x:75,y:100},{x:125,y:100}],
    [{x:70,y:120},{x:170,y:120}],plot,true);
  assert.equal(a.t0+(120/200)*(a.t1-a.t0),500);
  assert.equal(a.p0+((200-120)/200)*(a.p1-a.p0),150);
});
test('single profile touch pans price only; pinch can still zoom time', () => {
  const a=touchView(v,[{x:-20,y:100}],[{x:0,y:120}],plot,false);
  assert.deepEqual(a,{t0:0,t1:1000,p0:110,p1:210});
});
test('coincident fingers and empty gestures stay finite', () => {
  const p=[{x:100,y:100},{x:100,y:100}];
  assert.deepEqual(touchView(v,p,p,plot,true),v);
  assert.deepEqual(touchView(v,[],[],plot,true),v);
});
