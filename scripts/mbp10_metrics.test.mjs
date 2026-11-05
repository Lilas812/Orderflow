import test from "node:test";
import assert from "node:assert/strict";
import { decodeMbp10, SecondSampler, BookMetrics } from "./mbp10_metrics.mjs";

function record() {
  const r=Buffer.alloc(368);r[0]=92;r[1]=10;r.writeUInt32LE(123,4);
  r.writeBigUInt64LE(1793682000000000001n,8);r.writeBigUInt64LE(1793682000000000002n,32);
  for(let j=0;j<10;j++){
    const o=48+j*32;r.writeBigInt64LE(BigInt(39000-j)*100000000n,o);
    r.writeBigInt64LE(BigInt(39002+j)*100000000n,o+8);r.writeUInt32LE(j+1,o+16);r.writeUInt32LE(j+2,o+20);
  }
  return r;
}
function row(ns, extra={}) { return {tsEvent:ns,tsRecv:ns,flags:0,bids:[100,2],asks:[102,3],...extra}; }
test("DBN exact ns, tick scale, size and 10 levels",()=>{
  const d=decodeMbp10(record());assert.equal(d.tsEvent,1793682000000000001n);
  assert.deepEqual(d.bids.slice(0,4),[39000,1,38999,2]);assert.equal(d.asks.length,20);
});
test("schema and fractional tick rejection, undefined depth excluded",()=>{
  const r=record();r[1]=1;assert.throws(()=>decodeMbp10(r));
  r[1]=10;r.writeBigInt64LE(3900000000001n,48);assert.throws(()=>decodeMbp10(r));
  r.writeBigInt64LE(9223372036854775807n,48);assert.equal(decodeMbp10(r).bids.length,18);
});
test("end-of-second boundaries, ns precision and stable equal timestamp",()=>{
  const s=new SecondSampler(10,13);
  s.accept(row(10999999998n));s.accept(row(10999999999n,{bids:[101,4]}));
  s.accept(row(10999999999n,{bids:[101,5]}));s.accept(row(10999999998n,{bids:[99,9]}));
  s.accept(row(12000000000n));s.accept(row(13000000000n,{bids:[99,99]}));
  const result=s.finish();assert.equal(result.rows.get(10).bids[1],5);
  assert.equal(result.rows.get(11).bids[1],5);assert.equal(result.rows.get(12).bids[0],100);
  assert.equal(result.carriedSeconds,1);assert.equal(result.rows.has(13),false);
});
test("bad quality breaks carry until next known good frame; no initial gap fill",()=>{
  const s=new SecondSampler(10,16);s.accept(row(11000000000n));s.accept(row(12000000000n,{flags:4}));
  s.accept(row(14000000000n));const r=s.finish();
  assert.deepEqual([...r.rows.keys()],[11,14,15]);assert.equal(r.badSeconds,1);
});
test("MBP rows do not need F_LAST; full depth is already materialized",()=>{
  const s=new SecondSampler(10,11);s.accept(row(10500000000n));
  const r=s.finish();assert.equal(r.rows.size,1);assert.equal(r.withLastFlag,0);
});
test("normal session clear then valid quote within the second uses the end state",()=>{
  const s=new SecondSampler(10,12);s.accept(row(10000000000n,{bids:[],asks:[]}));
  s.accept(row(10900000000n));const r=s.finish();
  assert.equal(r.rows.size,2);assert.equal(r.badSeconds,0);assert.equal(r.emptyOrCrossedRows,1);
});
test("prices/quantities: exact case and missing-as-zero versus common price",()=>{
  const ref={bids:[100,2],asks:[102,3]}, m=new BookMetrics();m.add(ref,ref);
  let r=m.result();assert.equal(r.allPricesAndSizesExactRate,1);assert.equal(r.sizeAtReferencePriceMissingAsZero.meanAbsoluteError,0);
  const other=new BookMetrics();other.add({bids:[99,4],asks:[102,6]},ref);r=other.result();
  assert.equal(r.bbo.bothRate,0);assert.equal(r.bbo.askRate,1);assert.equal(r.prices.overlapDivReference,.5);
  assert.equal(r.sizeAtReferencePriceMissingAsZero.meanAbsoluteError,2.5);
  assert.equal(r.sizeAtCommonTop10Prices.meanSignedError,3);
  assert.equal(r.sizeAtUnionTop10PricesMissingAsZero.n,3);
});
