import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readStore, mutateStore, exportCsv, StoreError } from './range-store.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const privateDir = path.join(root, 'data/research-range-bars');
let queue = Promise.resolve();
const pending = new Map();
const completed = new Map();

export function rangeKey(symbol, width, reversalTicks) {
  if (!['NQ', 'GC'].includes(symbol) || !Number.isSafeInteger(width) || width < 1
    || !Number.isSafeInteger(reversalTicks) || reversalTicks < 1)
    throw new StoreError('銘柄・幅・反転幅は正の整数ticksを指定してください');
  return `${symbol}-${width}-${reversalTicks}`;
}
function enqueue(symbol, width, reversalTicks) {
  const key = rangeKey(symbol, width, reversalTicks);
  if (pending.has(key)) return;
  // Every request revalidates input and output hashes, even an existing cache.
  const job = queue.then(() => new Promise((resolve, reject) => {
    const child = spawn('python', [path.join(root, 'artifacts/gc-n-research/scripts/range_generate.py'),
      '--symbol', symbol, '--width', String(width), '--reversal-ticks', String(reversalTicks)],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = '';
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { error = (error + b).slice(-4000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(`生成失敗: ${error}`)));
  }));
  pending.set(key, { state: 'generating' });
  queue = job.then(file => { completed.set(key, { file, ready: true }); pending.delete(key); },
    error => { pending.set(key, { state: 'failed', error: error.message }); });
}
async function readOutput(file) {
  const s = await fs.readFile(file, 'utf8');
  const data = JSON.parse(s);
  // Python-generated outputHash is validated by generator; original file read is after that check.
  if (!data.outputHash || !data.bars || !data.inputHash) throw new StoreError('不完全な派生キャッシュ', 500);
  return data;
}
async function proveMark(m) {
  const key = rangeKey(m.symbol, m.context.width, m.context.reversalTicks);
  const entry = completed.get(key);
  if (!entry) throw new StoreError('作成時のバーを先に読み込んでください');
  const data = await readOutput(entry.file);
  if (data.inputHash !== m.context.inputHash || data.contract !== m.contract) throw new StoreError('入力世代が一致しません', 409);
  const ref = JSON.stringify(m.ref);
  if (!data.bars.some(b => JSON.stringify(b.highRef) === ref || JSON.stringify(b.lowRef) === ref))
    throw new StoreError('入力原約定の極値と照合できません');
}
function json(res, status, body) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body));
}
export function sameOrigin(req) {
  try {
    const origin = new URL(req.headers.origin);
    const host = req.headers['x-forwarded-host']?.split(',')[0].trim() || req.headers.host;
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === host
      && req.headers['sec-fetch-site'] !== 'cross-site'
      && req.headers['content-type']?.split(';')[0] === 'application/json';
  } catch { return false; }
}
async function body(req) {
  let data = '';
  for await (const b of req) {
    data += b;
    if (Buffer.byteLength(data) > 256000) throw new StoreError('リクエストが大きすぎます', 413);
  }
  try { return JSON.parse(data); } catch { throw new StoreError('不正なJSON'); }
}
export function rangeMiddleware(base = '/gc-n-research/', options = {}) {
  const storeDir = options.storeDir ?? privateDir, prove = options.prove ?? proveMark;
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://local.invalid');
    if (!url.pathname.startsWith(`${base}range-api/`)) return next();
    try {
      const route = url.pathname.slice(`${base}range-api/`.length);
      if (req.method === 'GET' && route === 'marks') return json(res, 200, await readStore(storeDir));
      if (req.method === 'POST' && route === 'marks') {
        if (!sameOrigin(req)) throw new StoreError('同一originのJSON書込だけ許可します', 403);
        return json(res, 200, await mutateStore(storeDir, await body(req), prove));
      }
      if (req.method === 'GET' && route === 'export') {
        const format = url.searchParams.get('format');
        if (!['json', 'csv'].includes(format)) throw new StoreError('formatはjson/csv');
        const s = await readStore(storeDir);
        res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="range-hindsight.${format}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.end(format === 'json' ? JSON.stringify(s, null, 2) : exportCsv(s));
      }
      if (req.method === 'GET' && route === 'bars') {
        const symbol = url.searchParams.get('symbol'), width = Number(url.searchParams.get('width')),
          reversal = Number(url.searchParams.get('reversalTicks'));
        const key = rangeKey(symbol, width, reversal);
        if (completed.get(key)?.ready) {
          const entry = completed.get(key); entry.ready = false;
          const data = await readOutput(entry.file);
          // Revalidate again on the next load, not every polling retry of this request.
          return json(res, 200, data);
        }
        const state = pending.get(key);
        if (state?.state === 'failed') { pending.delete(key); throw new StoreError(state.error, 500); }
        enqueue(symbol, width, reversal);
        return json(res, 202, { state: 'generating', message: '原約定とハッシュを照合して生成中。低優先度・直列実行。' });
      }
      throw new StoreError('研究専用APIが見つかりません', 404);
    } catch (e) { json(res, e.status ?? 500, { error: e.message ?? '研究APIエラー' }); }
  };
}
export default function rangePlugin() {
  return { name: 'local-only-range-research', apply: 'serve',
    configureServer(server) { server.middlewares.use(rangeMiddleware(server.config.base)); } };
}
