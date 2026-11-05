import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { readStore, mutateStore, exportCsv } from './range-store.mjs';
import { rangeMiddleware, sameOrigin, rangeKey } from './range-plugin.mjs';

const mark = () => ({ symbol: 'NQ', contract: 'NQZ26', kind: 'top', note: '天候ではなく天井,\n"主観"',
  hindsight: 'hindsight', ref: { tsUs: 1790726400002976, seq: 100000001, priceTicks: 122848,
    file: 'trades/NQ/2026-09-30/00.jsonl.gz', line: 1, source: { inputSha256: 'a'.repeat(64), row: 1 } },
  context: { width: 40, guides: false, reversalTicks: 40, inputHash: 'b'.repeat(64) } });
async function dir(t) { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'range-store-')); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; }
test('create edit delete undo reload independent readers and exact export', async t => {
  const d = await dir(t); let s = await readStore(d); assert.equal(s.revision, 0);
  s = await mutateStore(d, { revision: 0, action: 'create', mark: mark() });
  const id = s.marks[0].id; assert.equal((await readStore(d)).marks[0].ref.tsUs, 1790726400002976);
  s = await mutateStore(d, { revision: 1, action: 'edit', id, kind: 'bottom', note: '修正' });
  assert.equal(s.marks[0].id, id);
  s = await mutateStore(d, { revision: 2, action: 'delete', id }); assert.equal(s.marks.length, 0);
  s = await mutateStore(d, { revision: 3, action: 'undo' }); assert.equal(s.marks[0].kind, 'bottom');
  s = await mutateStore(d, { revision: 4, action: 'undo' }); assert.equal(s.marks[0].kind, 'top');
  s = await mutateStore(d, { revision: 5, action: 'criteria', text: '私の基準' });
  assert.equal((await readStore(d)).criteria, '私の基準');
  assert.match(exportCsv(s), /1790726400002976/); assert.match(exportCsv(s), /""主観""/);
  assert.equal(JSON.parse(JSON.stringify(s)).history.length, 6);
  assert.deepEqual((await readStore(d)).marks[0].ref, mark().ref);
});
test('CAS concurrency, stale revision and duplicate creates never silently overwrite', async t => {
  const d = await dir(t);
  const results = await Promise.allSettled([1, 2].map(i => mutateStore(d, { revision: 0, action: 'criteria', text: String(i) })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(mutateStore(d, { revision: 0, action: 'criteria', text: 'stale' }), e => e.status === 409);
  await mutateStore(d, { revision: 1, action: 'create', mark: mark() });
  await assert.rejects(mutateStore(d, { revision: 2, action: 'create', mark: mark() }), e => e.status === 409);
  assert.equal((await readStore(d)).revision, 2);
});
test('corruption and write failure explicit, source unchanged, locks released', async t => {
  const d = await dir(t);
  await fs.writeFile(path.join(d, 'marks.json'), '{broken');
  await assert.rejects(readStore(d), /読み込めません/);
  await assert.rejects(mutateStore(d, { revision: 0, action: 'criteria', text: '' }));
  assert.equal(await fs.readFile(path.join(d, 'marks.json'), 'utf8'), '{broken');
  await fs.unlink(path.join(d, 'marks.json')); await fs.mkdir(path.join(d, 'marks.json'));
  await assert.rejects(mutateStore(d, { revision: 0, action: 'criteria', text: 'x' }));
  await assert.rejects(fs.stat(path.join(d, '.marks-lock')), e => e.code === 'ENOENT');
});
test('invalid contract, time, path and evidence rejected', async t => {
  const d = await dir(t);
  for (const patch of [{ contract: 'NQH27' }, { ref: { ...mark().ref, tsUs: 1.5 } }, { ref: { ...mark().ref, file: '../../private' } }]) {
    await assert.rejects(mutateStore(d, { revision: 0, action: 'create', mark: { ...mark(), ...patch } }));
  }
  await assert.rejects(mutateStore(d, { revision: 0, action: 'create', mark: mark() }, async () => { throw Error('unproven'); }));
  assert.equal((await readStore(d)).marks.length, 0);
  assert.throws(() => rangeKey('../NQ', 1, 1)); assert.throws(() => rangeKey('GC', 1.5, 20));
});
test('HTTP isolation origin CRUD independent clients exports and unknown paths', async t => {
  const d = await dir(t), middleware = rangeMiddleware('/gc-n-research/', { storeDir: d, prove: async () => {} });
  const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/gc-n-research/range-api/marks`;
  const post = (command, from = origin) => fetch(url, { method: 'POST', headers: { Origin: from, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  assert.equal((await post({ revision: 0, action: 'criteria', text: 'cross' }, 'https://evil.invalid')).status, 403);
  assert.equal((await post({ revision: 0, action: 'create', mark: mark() })).status, 200);
  const s = await (await fetch(url)).json(); assert.equal(s.marks.length, 1);
  assert.equal((await post({ revision: 0, action: 'criteria', text: 'stale' })).status, 409);
  assert.equal((await post({ revision: 1, action: 'criteria', text: '端末共通' })).status, 200);
  assert.equal((await (await fetch(url)).json()).criteria, '端末共通');
  const exported = await (await fetch(`${origin}/gc-n-research/range-api/export?format=json`)).json();
  assert.equal(exported.history.length, 2);
  assert.match(await (await fetch(`${origin}/gc-n-research/range-api/export?format=csv`)).text(), /1790726400002976/);
  assert.equal((await fetch(`${origin}/gc-n-research/range-api/../../private`)).status, 404);
  assert.equal(sameOrigin({ headers: { origin, host: new URL(origin).host, 'content-type': 'application/json' } }), true);
});
