import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class StoreError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const emptyStore = () => ({ version: 1, revision: 0, marks: [], criteria: '', history: [] });
const int = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const text = (s, limit) => typeof s === 'string' && s.length <= limit;
export function validateMark(m) {
  if (!m || !['NQ', 'GC'].includes(m.symbol) || m.contract !== `${m.symbol}Z26`
    || !['top', 'bottom'].includes(m.kind) || m.hindsight !== 'hindsight' || !text(m.note, 20000))
    throw new StoreError('不正なマーク形式');
  const r = m.ref, c = m.context;
  if (!r || !int(r.tsUs) || !int(r.seq) || !int(r.priceTicks) || !int(r.line, 1)
    || typeof r.file !== 'string' || !new RegExp(`^trades/${m.symbol}/2026-\\d{2}-\\d{2}/\\d{2}\\.jsonl\\.gz$`).test(r.file)
    || !r.source || typeof r.source !== 'object' || Array.isArray(r.source)
    || !/^[a-f0-9]{64}$/.test(r.source.inputSha256 ?? '')
    || !c || !int(c.width, 1) || !int(c.reversalTicks, 1) || typeof c.guides !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(c.inputHash ?? ''))
    throw new StoreError('原約定の由来・作成条件が不正');
}
export function markId(m) {
  return createHash('sha256').update(JSON.stringify([m.symbol, m.contract, m.ref.priceTicks,
    m.ref.tsUs, m.ref.seq, m.ref.file, m.ref.line])).digest('hex');
}
export function validateStore(s) {
  if (!s || s.version !== 1 || !int(s.revision) || !Array.isArray(s.marks) || !Array.isArray(s.history)
    || !text(s.criteria, 100000) || s.history.length !== s.revision)
    throw new StoreError('マーク保存ファイルが破損しています。初期化せず停止します。', 500);
  const ids = new Set();
  try {
    for (const m of s.marks) {
      validateMark(m);
      if (m.id !== markId(m) || ids.has(m.id) || !int(m.createdUs) || !int(m.updatedUs)) throw Error();
      ids.add(m.id);
    }
    for (let i = 0; i < s.history.length; i++) {
      const h = s.history[i];
      if (h.revision !== i + 1 || !int(h.atUs) || !['create', 'edit', 'delete', 'undo', 'criteria'].includes(h.action)) throw Error();
      for (const m of [h.before, h.after]) if (m) { validateMark(m); if (m.id !== markId(m)) throw Error(); }
      if (h.action === 'undo' && (!int(h.targetRevision, 1) || h.targetRevision >= h.revision)) throw Error();
    }
  } catch { throw new StoreError('マークまたは履歴が破損しています。元ファイルを保全して停止します。', 500); }
  return s;
}
export async function readStore(dir) {
  try { return validateStore(JSON.parse(await fs.readFile(path.join(dir, 'marks.json'), 'utf8'))); }
  catch (e) {
    if (e.code === 'ENOENT') return emptyStore();
    if (e instanceof StoreError) throw e;
    throw new StoreError('保存ファイルを読み込めません。破損・権限を確認してください。', 500);
  }
}
export async function mutateStore(dir, command, prove = async () => {}) {
  if (!command || !int(command.revision)) throw new StoreError('revisionが必要です');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, '.marks-lock');
  try { await fs.mkdir(lock); }
  catch (e) {
    if (e.code === 'EEXIST') throw new StoreError('別の保存処理中です。再読込してください。残存ロックは自動削除しません。', 409);
    throw new StoreError('保存ロックを取得できません', 500);
  }
  let temp;
  try {
    const s = await readStore(dir);
    if (s.revision !== command.revision) throw new StoreError('別端末で更新されています。再読込してから編集してください。', 409);
    const now = Date.now() * 1000;
    const h = { revision: s.revision + 1, atUs: now, action: command.action };
    if (command.action === 'create') {
      const m = structuredClone(command.mark);
      validateMark(m);
      await prove(m);
      m.id = markId(m); m.createdUs = m.updatedUs = now;
      if (s.marks.some(x => x.id === m.id)) throw new StoreError('この原約定には既にマークがあります', 409);
      s.marks.push(m); Object.assign(h, { id: m.id, before: null, after: m });
    } else if (command.action === 'edit' || command.action === 'delete') {
      const i = s.marks.findIndex(m => m.id === command.id);
      if (i < 0) throw new StoreError('マークが見つかりません', 404);
      h.id = command.id; h.before = structuredClone(s.marks[i]);
      if (command.action === 'delete') { s.marks.splice(i, 1); h.after = null; }
      else {
        const after = { ...s.marks[i], kind: command.kind, note: command.note, updatedUs: now };
        validateMark(after); s.marks[i] = after; h.after = after;
      }
    } else if (command.action === 'criteria') {
      if (!text(command.text, 100000)) throw new StoreError('基準メモは100,000文字まで');
      h.beforeCriteria = s.criteria; h.afterCriteria = command.text; s.criteria = command.text;
    } else if (command.action === 'undo') {
      const undone = new Set(s.history.filter(x => x.action === 'undo').map(x => x.targetRevision));
      const target = [...s.history].reverse().find(x => x.action !== 'undo' && !undone.has(x.revision));
      if (!target) throw new StoreError('取り消せる変更がありません');
      h.targetRevision = target.revision;
      if (target.action === 'criteria') {
        h.beforeCriteria = s.criteria; h.afterCriteria = target.beforeCriteria; s.criteria = target.beforeCriteria;
      } else {
        h.id = target.id;
        h.before = structuredClone(s.marks.find(x => x.id === target.id) ?? null);
        s.marks = s.marks.filter(x => x.id !== target.id);
        h.after = target.before ? { ...target.before, updatedUs: now } : null;
        if (h.after) s.marks.push(h.after);
      }
    } else throw new StoreError('未対応の操作');
    s.revision++; s.history.push(h); validateStore(s);
    temp = path.join(dir, `.marks-${process.pid}-${now}.tmp`);
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(s)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, path.join(dir, 'marks.json')); temp = undefined;
    const directory = await fs.open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return s;
  } catch (e) {
    if (e instanceof StoreError) throw e;
    throw new StoreError('保存に失敗しました。保存結果を再読込で確認してください。', 500);
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {});
    await fs.rmdir(lock);
  }
}

// All integral values remain base-10 text; JSON carries full history/provenance.
export function exportCsv(s) {
  const columns = ['id', 'symbol', 'contract', 'kind', 'priceTicks', 'tsUs', 'seq', 'file', 'line',
    'note', 'hindsight', 'createdUs', 'updatedUs', 'width', 'guides', 'reversalTicks', 'inputHash', 'sourceJSON'];
  const quote = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return '\ufeff' + [columns, ...s.marks.map(m => [m.id, m.symbol, m.contract, m.kind, m.ref.priceTicks,
    m.ref.tsUs, m.ref.seq, m.ref.file, m.ref.line, m.note, m.hindsight, m.createdUs, m.updatedUs,
    m.context.width, m.context.guides, m.context.reversalTicks, m.context.inputHash, JSON.stringify(m.ref.source)])]
    .map(row => row.map(quote).join(',')).join('\r\n');
}
