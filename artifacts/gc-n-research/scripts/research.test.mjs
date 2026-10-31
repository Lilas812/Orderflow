import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bucketProfile, selectLevels, candleAt, formatDateTime } from '../src/lib/research.ts';

test('previous profile quantity is conserved; threshold and top N deterministic', () => {
  const p = [
    {priceTicks:42000,quantity:10,count:3},
    {priceTicks:42001,quantity:20,count:1},
    {priceTicks:42010,quantity:20,count:8},
  ];
  const original = JSON.stringify(p);
  assert.deepEqual(selectLevels(p,2,11,1).map(x=>x.priceTicks),[42010,42001]);
  assert.deepEqual(selectLevels(p,4,21,1),[]);
  const buckets = bucketProfile(p,10);
  assert.equal(buckets.reduce((sum,x)=>sum+x.quantity,0),50);
  assert.equal(buckets.reduce((sum,x)=>sum+x.count,0),12);
  assert.equal(JSON.stringify(p),original);
});

test('real selected levels contain no current-session N quantities', () => {
  const data = JSON.parse(readFileSync(new URL('../public/research-data/2026-10-16.json', import.meta.url)));
  assert.equal(data.previousSession,'2026-10-15');
  const levels = selectLevels(data.profile,3,1,1);
  assert.deepEqual(levels.map(x=>[x.priceTicks,x.quantity]),[[41625,22],[41757,17],[41784,14]]);
  const before = JSON.stringify(levels);
  data.candles.push({timeMs:0,highTicks:99999,quantity:999999});
  data.summary.nQuantity = 999999;
  assert.equal(JSON.stringify(selectLevels(data.profile,3,1,1)),before);
});

test('missing minute returns a gap, not a carried-forward candle', () => {
  const bars = [{timeMs:0},{timeMs:120000}];
  assert.equal(candleAt(bars,60000),null);
  assert.equal(candleAt(bars,120001),bars[1]);
});

test('time formatting respects date rollover in CT and JST', () => {
  const time=Date.parse('2026-10-16T16:00:00Z');
  assert.match(formatDateTime(time,'CT'),/2026-10-16 11:00 CT/);
  assert.match(formatDateTime(time,'JST'),/2026-10-17 01:00 JST/);
});
