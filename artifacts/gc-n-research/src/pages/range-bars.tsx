import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { RangeChart } from '@/components/range-chart';
import { exportUrl, getMarks, getRange, RevisionConflict, saveMark } from '@/lib/range-api';
import type { ExtremeKind, MarkCommand, MarkStore, RangeData, RangeMark, SymbolName, TradeRef } from '@/lib/range-types';
import { formatUs } from '@/lib/range-view';
import './range-bars.css';

export default function RangePage() {
  const [symbol, setSymbol] = useState<SymbolName>('NQ'), [width, setWidth] = useState(40), [rawWidth, setRawWidth] = useState('40');
  const [reversal, setReversal] = useState(40), [rawReversal, setRawReversal] = useState('10');
  const [data, setData] = useState<RangeData | null>(null), [store, setStore] = useState<MarkStore | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState(''), [conflict, setConflict] = useState(false);
  const [guides, setGuides] = useState(false), [volume, setVolume] = useState(true), [tz, setTz] = useState<'CT' | 'JST'>('CT');
  const [mode, setMode] = useState<ExtremeKind | 'auto'>('auto'), [selected, setSelected] = useState(0);
  const [jump, setJump] = useState<{ session: string; serial: number } | null>(null);
  const [pending, setPending] = useState<{ ref: TradeRef; highRef: TradeRef; lowRef: TradeRef; kind?: ExtremeKind } | null>(null);
  const [note, setNote] = useState(''), [edit, setEdit] = useState<RangeMark | null>(null);
  const [editRevision, setEditRevision] = useState(0);
  const [criteria, setCriteria] = useState(''), [dirty, setDirty] = useState(false), [reload, setReload] = useState(0);
  const busy = useRef(false), dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const storeRef = useRef(store); storeRef.current = store;
  const refresh = useCallback(async (force = false) => {
    const next = await getMarks();
    if (storeRef.current && next.revision < storeRef.current.revision) return;
    if (force || !dirtyRef.current) { setCriteria(next.criteria); setDirty(false); }
    else if (storeRef.current && next.revision !== storeRef.current.revision) {
      setConflict(true); setStatus('別端末で更新されました。未保存の基準メモを保全して再読込してください。');
      return;
    }
    setStore(next);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setData(null); setSelected(0); setPending(null); setEdit(null);
    getRange(symbol, width, reversal, controller.signal).then(d => { setData(d); setLoading(false); })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message); setLoading(false); } });
    return () => controller.abort();
  }, [symbol, width, reversal, reload]);
  useEffect(() => {
    let active = true;
    const load = async () => { try { if (active && !busy.current) await refresh(); } catch (e) { if (active) setError((e as Error).message); } };
    void load(); const interval = setInterval(load, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [refresh]);
  const mutate = useCallback(async (command: MarkCommand, expectedRevision?: number) => {
    if (!storeRef.current || busy.current || conflict) return false;
    busy.current = true; setStatus('保存中…');
    try {
      const next = await saveMark(expectedRevision ?? storeRef.current.revision, command);
      setStore(next); storeRef.current = next; setStatus(`保存済み revision ${next.revision}`);
      if (command.action === 'criteria') setDirty(false);
      if (command.action === 'undo' && !dirtyRef.current) setCriteria(next.criteria);
      return true;
    } catch (e) {
      if (e instanceof RevisionConflict) setConflict(true);
      setStatus(`保存失敗／結果未確認：${(e as Error).message}`); return false;
    } finally { busy.current = false; }
  }, [conflict]);
  const go = useCallback((delta: number) => {
    if (!data) return;
    const current = jump?.session ?? data.bars[selected]?.session ?? data.sessions[0]?.date;
    const index = data.sessions.findIndex(s => s.date === current);
    const s = data.sessions[Math.max(0, Math.min(data.sessions.length - 1, index + delta))];
    if (s) { setJump({ session: s.date, serial: Date.now() }); setSelected(s.first); }
  }, [data, jump, selected]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === 't') setMode('top');
      if (e.key.toLowerCase() === 'b') setMode('bottom');
      if (e.key.toLowerCase() === 'z') { e.preventDefault(); void mutate({ action: 'undo' }); }
      if (e.key === '[' || e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      if (e.key === ']' || e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [mutate, go]);
  const bar = data?.bars[selected];
  const marks = useMemo(() => store?.marks.filter(m => m.symbol === symbol) ?? [], [store, symbol]);
  const requestMark = (highRef: TradeRef, kind?: ExtremeKind, lowRef = highRef) => {
    setPending({ ref: kind === 'bottom' ? lowRef : highRef, highRef, lowRef, kind }); setNote(''); setEdit(null);
  };
  const savePending = async () => {
    if (!data || !pending?.kind) return;
    const ok = await mutate({ action: 'create', mark: { symbol, contract: data.contract, kind: pending.kind,
      ref: pending.ref, note, hindsight: 'hindsight', context: { width, guides, reversalTicks: reversal, inputHash: data.inputHash } } });
    if (ok) setPending(null);
  };
  const choose = (s: SymbolName) => {
    setSymbol(s); setWidth(s === 'NQ' ? 40 : 20); setRawWidth(s === 'NQ' ? '40' : '20');
    setReversal(s === 'NQ' ? 40 : 20); setRawReversal(s === 'NQ' ? '10' : '2'); setJump(null);
  };
  const apply = () => {
    const w = Number(rawWidth), ticks = Number(rawReversal) / (symbol === 'NQ' ? .25 : .1), rt = Math.round(ticks);
    if (!Number.isSafeInteger(w) || w <= 0 || !Number.isSafeInteger(rt) || rt <= 0 || Math.abs(ticks - rt) > 1e-7) {
      setError('幅は正の整数ticks、反転ポイントはtick単位の正値で指定してください。'); return;
    }
    setWidth(w); setReversal(rt);
  };
  return <div className="range-page">
    <header><div><h1>レンジバー俯瞰 <small>購入原約定・ローカル研究専用</small></h1>
      <p>本人の天底基準による hindsight 記録。補助線・マークは売買シグナルや客観的正解ではありません。</p></div>
      <nav><Link href="/">日別</Link><Link href="/overview">N価格の期間俯瞰</Link></nav></header>
    <div className="range-toolbar">
      <label>銘柄<select data-testid="range-symbol" value={symbol} onChange={e => choose(e.target.value as SymbolName)}><option>NQ</option><option>GC</option></select></label>
      <label>幅 ticks<input data-testid="range-width" type="number" min="1" step="1" value={rawWidth} onChange={e => setRawWidth(e.target.value)} /></label>
      <label>反転ポイント<input data-testid="range-reversal" type="number" min={symbol === 'NQ' ? .25 : .1} step={symbol === 'NQ' ? .25 : .1} value={rawReversal} onChange={e => setRawReversal(e.target.value)} /></label>
      <button onClick={apply}>幅を適用</button>
      <label><input data-testid="range-guides" type="checkbox" checked={guides} onChange={e => setGuides(e.target.checked)} />反転補助線（初期OFF）</label>
      <label><input data-testid="range-volume" type="checkbox" checked={volume} onChange={e => setVolume(e.target.checked)} />出来高下段</label>
      <label>日時<select data-testid="range-tz" value={tz} onChange={e => setTz(e.target.value as 'CT' | 'JST')}><option>CT</option><option>JST</option></select></label>
      <button onClick={() => go(-1)}>前セッション</button><button onClick={() => go(1)}>次セッション</button>
      <label>CT終了日ジャンプ<input data-testid="range-date" type="date" value={jump?.session ?? bar?.session ?? ''} onChange={e => {
        const s = data?.sessions.find(s => s.date === e.target.value);
        if (s) { setJump({ session: s.date, serial: Date.now() }); setSelected(s.first); setError(''); }
        else setError('指定セッションは利用できません。別の日へ置き換えていません。');
      }} /></label>
    </div>
    <div className="range-toolbar">
      <span>クリック／タップ：</span>
      <button aria-pressed={mode === 'auto'} onClick={() => setMode('auto')}>高安で自動選択</button>
      <button aria-pressed={mode === 'top'} onClick={() => setMode('top')}>T 天井</button>
      <button aria-pressed={mode === 'bottom'} onClick={() => setMode('bottom')}>B 底</button>
      <button data-testid="range-undo" disabled={!store || conflict} onClick={() => void mutate({ action: 'undo' })}>Z 取り消し</button>
      <button onClick={() => { void refresh(true).then(() => { setConflict(false); setStatus('再読込済み'); }).catch(e => setError(e.message)); }}>保存を再読込</button>
      <a href={exportUrl('json')} download>JSON（履歴・基準含む）</a><a href={exportUrl('csv')} download>CSV（マーク）</a>
    </div>
    {(error || conflict) && <div className="range-alert" role="alert">{error || status}{conflict && <strong> 競合中は保存できません。未保存入力を控えて「保存を再読込」を押してください。</strong>} <button onClick={() => { setError(''); setReload(x => x + 1); }}>データ再取得</button></div>}
    <p role="status" data-testid="range-save-status">{status || (store ? `保存データ読込済み（revision ${store.revision}）` : '保存データ読込中…')}</p>
    {loading && <div className="range-loading">原約定のハッシュ照合／生成中。初回・幅変更時は数分かかる場合があります。既存受信へ接続しません。</div>}
    {data && <><div className="range-summary">{data.contract} ／ {data.width}ticks＝{(data.width * data.tickSize).toFixed(2)}ポイント ／ {data.bars.length.toLocaleString()}足 ／ 原約定 {data.totals.count.toLocaleString()}件 ／ 買 {data.totals.buy.toLocaleString()}・売 {data.totals.sell.toLocaleString()}・N {data.totals.unknown.toLocaleString()}枚<br />
      CT開始日 2026-09-29〜10-29（終了日ラベル 09-30〜10-30）。購入外の冒頭・末尾は欠け。取得済み無約定時間に足を補完しません。</div>
      <RangeChart key={`${symbol}-${width}-${reversal}-${data.inputHash}`} data={data} marks={marks} guides={guides} volume={volume} tz={tz} mode={mode}
        selected={selected} onSelect={setSelected} onMark={requestMark} jump={jump} />
      {bar && <section className="range-details" data-testid="range-details"><h2>選択足 {selected + 1} ／ CT終了日 {bar.session} {bar.partial ? `部分足 (${bar.reason})` : '幅到達足'}</h2>
        <p>{formatUs(bar.startUs, tz)} → {formatUs(bar.endUs, tz)}</p>
        <p>O {(bar.open * data.tickSize).toFixed(2)} ／ H {(bar.high * data.tickSize).toFixed(2)} ／ L {(bar.low * data.tickSize).toFixed(2)} ／ C {(bar.close * data.tickSize).toFixed(2)}</p>
        <p>買 {bar.buy} ／ 売 {bar.sell} ／ N {bar.unknown} 枚・{bar.count}件</p>
        <p>高値初出 {formatUs(bar.highRef.tsUs, tz)} ／ 安値初出 {formatUs(bar.lowRef.tsUs, tz)}</p>
        <button data-testid="range-add-top" disabled={!store || conflict} onClick={() => requestMark(bar.highRef, 'top', bar.lowRef)}>この足の天を記録</button>
        <button data-testid="range-add-bottom" disabled={!store || conflict} onClick={() => requestMark(bar.highRef, 'bottom', bar.lowRef)}>この足の底を記録</button>
      </section>}</>}
    {pending && <section className="range-editor" role="dialog" aria-label="hindsightマークを作成">
      <h2>hindsight マークを作成</h2><p>原約定 {formatUs(pending.ref.tsUs, tz)} ／ {pending.ref.priceTicks} ticks</p>
      {!pending.kind && <p>高安が近い／一致しています。種類を明示してください。底を選ぶ場合はその足の安値初出約定を使います。</p>}
      <label>種類<select data-testid="range-mark-kind" value={pending.kind ?? ''} onChange={e => {
        const kind = e.target.value as ExtremeKind; if (!kind) return;
        setPending({ ...pending, kind, ref: kind === 'top' ? pending.highRef : pending.lowRef });
      }}><option value="">選択してください</option><option value="top">天井 top</option><option value="bottom">底 bottom</option></select></label>
      <label>任意メモ<textarea data-testid="range-mark-note" value={note} onChange={e => setNote(e.target.value)} /></label>
      <button data-testid="range-mark-save" disabled={!pending.kind || !store || conflict} onClick={() => void savePending()}>サーバーへ保存</button>
      <button onClick={() => setPending(null)}>閉じる</button>
    </section>}
    <div className="range-bottom">
      <section><h2>独立hindsightマーク {marks.length}件</h2>
        <p>幅を変えて極値でなくなっても、元の価格・約定時刻のまま残ります。</p>
        <div className="range-mark-list">{marks.map(m => <article key={m.id} data-testid="range-mark-row">
          <strong>{m.kind === 'top' ? 'T 天井' : 'B 底'} {m.ref.priceTicks}ticks</strong> {formatUs(m.ref.tsUs, tz)}
          <p>{m.note || 'メモなし'} ／ 作成幅 {m.context.width}ticks・補助線 {m.context.guides ? 'ON' : 'OFF'}・hindsight</p>
          {data && m.context.inputHash !== data.inputHash && <strong>入力manifestが異なるためチャート位置は未照合です。元マークは保持しています。</strong>}
          <button onClick={() => { setEdit(m); setEditRevision(store?.revision ?? 0); setNote(m.note); setPending(null); }}>編集</button>
          <button onClick={() => { if (confirm('このマークを削除します。履歴は残り、取り消し可能です。')) void mutate({ action: 'delete', id: m.id }); }}>削除</button>
        </article>)}</div>
        {edit && <div className="range-editor"><h3>編集（原約定は固定）</h3>
          <select value={edit.kind} onChange={e => setEdit({ ...edit, kind: e.target.value as ExtremeKind })}><option value="top">天井</option><option value="bottom">底</option></select>
          <textarea value={note} onChange={e => setNote(e.target.value)} />
          <button onClick={async () => { if (await mutate({ action: 'edit', id: edit.id, kind: edit.kind, note }, editRevision)) setEdit(null); }}>編集を保存</button><button onClick={() => setEdit(null)}>閉じる</button>
        </div>}
      </section>
      <section><h2>本人の基準メモ（端末間で共有）</h2><textarea data-testid="range-criteria" value={criteria} onChange={e => { setCriteria(e.target.value); setDirty(true); }} placeholder="自分が天底と判断する基準…" />
        <button data-testid="range-criteria-save" disabled={!dirty || !store || conflict} onClick={() => void mutate({ action: 'criteria', text: criteria })}>基準メモを保存</button>
        <span>{dirty ? ' 未保存' : ' サーバー反映済み'}</span>
        <details><summary>変更履歴（全銘柄） revision {store?.revision ?? '—'}</summary><div className="range-history">{[...(store?.history ?? [])].reverse().map(h =>
          <div key={h.revision}><strong>#{h.revision} {h.action}</strong> {formatUs(h.atUs, tz)}<pre>{JSON.stringify(h, null, 2)}</pre></div>)}</div></details>
      </section>
    </div>
    <footer>T／B＝種類切替、Z＝直近変更の取り消し、←／→ または [／]＝前後セッション。入力欄ではショートカット無効。保存データは5秒ごとに再取得します。</footer>
  </div>;
}
