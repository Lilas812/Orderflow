import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { observeLine, buildOverview, ctSessionBounds, aggregateCandles, overlapSegments } from '../src/lib/overview.ts';

const M=60000;
const bar=(t,o,h,l,c)=>({timeMs:t*M,openTicks:o,highTicks:h,lowTicks:l,closeTicks:c,quantity:1,count:1});
const rule={reactionTicks:20,windowMinutes:5,toleranceTicks:1};
const coverage=[{start:0,end:100*M}];
const observe=(bars,end=100*M,cov=coverage)=>observeLine(bars,100,1*M,end,rule,cov);
const previous=bar(0,106,107,105,106);
const touch=bar(1,106,106,100,102);

test('approach side determines reaction, above and below symmetrically',()=>{
  assert.equal(observe([previous,touch,bar(2,105,120,104,119)])[0].outcome,'reaction');
  const down=observe([bar(0,94,95,93,94),bar(1,94,100,94,98),bar(2,95,96,80,81)]);
  assert.equal(down[0].approach,'below');
  assert.equal(down[0].outcome,'reaction');
});
test('same minute both thresholds and touch-before-extreme ambiguity are never guessed',()=>{
  assert.equal(observe([previous,touch,bar(2,102,122,78,101)])[0].outcome,'ambiguous');
  assert.equal(observe([previous,bar(1,106,125,100,104)])[0].outcome,'ambiguous');
  assert.equal(observe([previous,bar(1,100,120,99,110)])[0].approach,'unknown');
  assert.equal(observe([previous,bar(1,106,125,100,121)])[0].outcome,'reaction');
});
test('continuous contact and overlapping observation windows are counted once',()=>{
  const continuous=[previous,touch,...Array.from({length:20},(_,i)=>bar(i+2,100,101,99,100))];
  assert.equal(observe(continuous).length,1);
  const events=observe([previous,touch,bar(2,105,120,104,119),
    bar(3,106,106,100,102),bar(4,106,107,105,106),bar(7,106,106,100,102)]);
  assert.equal(events.length,2);
  assert(events[1].timeMs>=events[0].endMs);
});
test('confirmed breakout followed by a separate return is a retest',()=>{
  const events=observe([previous,touch,bar(2,98,99,80,82),bar(3,94,95,93,94),
    bar(7,94,100,94,98),bar(8,95,96,80,81)]);
  assert.equal(events.length,2);
  assert.equal(events[0].outcome,'breakout');
  assert.equal(events[1].retest,true);
  assert.equal(events[1].approach,'below');
});
test('truncated or missing observation is not counted as a failed reaction',()=>{
  assert.equal(observe([previous,touch,bar(2,103,105,102,104)],3*M)[0].outcome,'unobserved');
  const cov=[{start:0,end:3*M},{start:4*M,end:100*M}];
  assert.equal(observe([previous,touch,bar(4,105,120,104,119)],100*M,cov)[0].outcome,'unobserved');
});
test('five minute OHLCV conserves quantity and leaves missing groups empty',()=>{
  const input=[bar(0,100,110,90,105),bar(4,105,120,95,110),bar(10,111,112,110,111)];
  const out=aggregateCandles(input,5);
  assert.equal(out.length,2);
  assert.deepEqual(out[0],{...input[0],highTicks:120,lowTicks:90,closeTicks:110,quantity:2,count:2});
  assert.equal(out[1].timeMs,10*M);
  assert.equal(input[0].quantity,1);
});
test('CT17 boundary and DST autumn 25-hour session',()=>{
  assert.equal(ctSessionBounds('2026-10-16').startMs,Date.parse('2026-10-15T22:00:00Z'));
  const autumn=ctSessionBounds('2026-11-01');
  assert.equal(autumn.endMs-autumn.startMs,25*60*M);
});

const dataDir=new URL('../public/research-data/',import.meta.url);
const sessions=readdirSync(dataDir).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort().map(f=>JSON.parse(readFileSync(new URL(f,dataDir))));
const config={from:'2026-10-01',to:'2026-10-31',chartMinutes:5,overlay:'visible',
  summary:'visible',summarySession:'2026-10-30',topN:3,minQty:1,bucketTicks:1,
  retention:'all',rule:{...rule,windowMinutes:15}};

test('real month uses only ended source sessions; lines never predate formation',()=>{
  const out=buildOverview(sessions,config);
  assert(out.lines.length>40);
  assert(out.candles.length>5000);
  for(const line of out.lines){
    const s=sessions.find(s=>s.session===line.sourceSession);
    assert(line.startMs>=s.sessionEndMs);
    assert(!line.events.some(e=>e.timeMs<line.startMs || e.timeMs>=line.endMs));
    assert(line.events.every((e,i)=>!i || e.timeMs>=line.events[i-1].endMs));
  }
  assert(!out.lines.some(l=>l.sourceSession==='2026-10-30'),'Incomplete final session must not form a line');
  const qty=out.profile.reduce((n,p)=>n+p.quantity,0);
  assert.equal(qty,sessions.filter(s=>s.session>=config.from).reduce((n,s)=>n+s.summary.nQuantity,0));
});
test('future N changes cannot alter an already formed source line',()=>{
  const baseline=buildOverview(sessions,config);
  const changed=structuredClone(sessions);
  const later=changed.find(s=>s.session==='2026-10-22');
  later.ownProfile=[{priceTicks:99999,quantity:999999,count:999}];
  const second=buildOverview(changed,config);
  assert.deepEqual(
    baseline.lines.filter(l=>l.sourceSession==='2026-10-02'),
    second.lines.filter(l=>l.sourceSession==='2026-10-02'));
});
test('retention is independent of source filter and expires at actual session boundaries',()=>{
  const out=buildOverview(sessions,{...config,overlay:'previous',retention:1});
  const line=out.lines.find(l=>l.sourceSession==='2026-10-02');
  assert.equal(line.startMs,ctSessionBounds('2026-10-05').startMs);
  assert.equal(line.endMs,ctSessionBounds('2026-10-05').endMs);
  const three=buildOverview(sessions,{...config,retention:3});
  assert.equal(three.lines.find(l=>l.sourceSession==='2026-10-02').endMs,
    ctSessionBounds('2026-10-07').endMs);
  const all=buildOverview(sessions,{...config,overlay:'previous'});
  assert(all.lines.find(l=>l.sourceSession==='2026-10-02').endMs>line.endMs);
});
test('same-price strength changes only after formation, and falls again at expiry',()=>{
  const first={priceTicks:100,bucketTicks:1,startMs:10,endMs:40};
  const second={priceTicks:100,bucketTicks:1,startMs:20,endMs:30};
  assert.deepEqual(overlapSegments(first,[first,second]),[
    {startMs:10,endMs:20,count:1},{startMs:20,endMs:30,count:2},{startMs:30,endMs:40,count:1},
  ]);
});
test('both ratios have explicit independent denominators; invalid input rejected',()=>{
  const out=buildOverview(sessions,config);
  const row=out.daily.find(s=>s.date==='2026-10-16');
  assert.equal(row.ratioTraditional,1301/(127921-1301));
  assert.equal(row.ratioAll,1301/127921);
  assert.throws(()=>buildOverview(sessions,{...config,rule:{...rule,toleranceTicks:20}}),/許容幅/);
});
