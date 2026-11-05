import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampView, refPosition, formatUs, elapsedUs } from '../src/lib/range-view.ts';
const b = (startSeq, endSeq, startLine, endLine) => ({ startUs: 1000000, endUs: 1000000, startSeq, endSeq, startLine, endLine });
test('stable raw order survives width change and equal us / sequence', () => {
  const bars = [b(1, 1, 1, 1), b(1, 1, 2, 2), b(2, 3, 3, 4)];
  assert.equal(refPosition(bars, { tsUs: 1000000, seq: 1, line: 2 }), 1.5);
  assert.equal(refPosition(bars, { tsUs: 1000000, seq: 3, line: 4 }), 2.5);
  assert.equal(refPosition([b(1, 3, 1, 4)], { tsUs: 1000000, seq: 3, line: 4 }), .5);
});
test('view bounds and microsecond display never lose raw precision', () => {
  assert.deepEqual(clampView(-100, 200, 50), [0, 50]);
  assert.deepEqual(clampView(90, 120, 100), [70, 100]);
  assert.match(formatUs(1790726400002976, 'CT'), /\.002976 CT$/);
  assert.match(formatUs(1790726400002976, 'JST'), /\.002976 JST$/);
  assert.match(elapsedUs(1000001), /1\.000001秒/);
});
