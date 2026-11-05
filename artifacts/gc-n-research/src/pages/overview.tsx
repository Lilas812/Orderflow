import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react';
import { useResearchIndex } from '@/hooks/use-research';
import { useAllSessions } from '@/hooks/use-overview';
import { type Tz } from '@/lib/research';
import { type OverviewConfig, buildOverview } from '@/lib/overview';
import { OverviewChart } from '@/components/overview-chart';
import { DailyPanel, LineDetails, LineTable } from '@/components/overview-panels';

type Preset = 'month' | 1 | 3 | 5 | 10 | 20 | 'custom';

function monthRange(date: string) {
  const [y, m] = date.slice(0, 7).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${date.slice(0, 7)}-01`, to: `${date.slice(0, 7)}-${String(last).padStart(2, '0')}` };
}

function Seg<T extends string | number>({ id, label, value, options, onChange }: { id: string; label: string; value: T; options: { v: NoInfer<T>; l: string }[]; onChange: (v: NoInfer<T>) => void }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground" id={`${id}-label`}>{label}</span>
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex h-7 overflow-hidden rounded-sm border border-input">
        {options.map((o) => (
          <button key={String(o.v)} role="radio" aria-checked={value === o.v} data-testid={`button-${id}-${o.v}`} onClick={() => onChange(o.v)}
            className={`tabular px-2 text-[11px] ${value === o.v ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-accent'}`}>{o.l}</button>
        ))}
      </div>
    </div>
  );
}

function Num({ id, label, value, min, max, onChange }: { id: string; label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [raw, setRaw] = useState(String(value));
  const bad = raw.trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) < min;
  return (
    <label className="flex flex-col gap-0.5" htmlFor={id}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input id={id} data-testid={`input-${id}`} type="number" min={min} max={max} step={1} value={raw} aria-invalid={bad}
        onChange={(e) => { setRaw(e.target.value); const n = Math.floor(Number(e.target.value)); if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min) onChange(Math.min(max, n)); }}
        onBlur={() => setRaw(String(value))}
        className={`tabular h-7 w-16 rounded-sm border bg-card px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${bad ? 'border-destructive' : 'border-input'}`} />
    </label>
  );
}

const sel = 'tabular h-7 rounded-sm border border-input bg-card px-1.5 text-xs';

export default function OverviewPage() {
  const idx = useResearchIndex();
  const items = useMemo(() => [...(idx.data?.sessions ?? [])].sort((a, b) => a.date.localeCompare(b.date)), [idx.data]);
  const dates = useMemo(() => items.map((i) => i.date), [items]);
  const latest = dates[dates.length - 1] ?? null;
  const all = useAllSessions(items);

  const [preset, setPreset] = useState<Preset>('month');
  const [anchor, setAnchor] = useState<string | null>(null);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [chartMinutes, setChartMinutes] = useState<1 | 5>(5);
  const [overlay, setOverlay] = useState<OverviewConfig['overlay']>('visible');
  const [summary, setSummary] = useState<OverviewConfig['summary']>('visible');
  const [summarySession, setSummarySession] = useState<string>('');
  const [topN, setTopN] = useState(3);
  const [minQty, setMinQty] = useState(1);
  const [bucketTicks, setBucketTicks] = useState(1);
  const [retention, setRetention] = useState<OverviewConfig['retention']>('all');
  const [reactionTicks, setReactionTicks] = useState(20);
  const [windowMinutes, setWindowMinutes] = useState(15);
  const [toleranceTicks, setToleranceTicks] = useState(1);
  const [tz, setTz] = useState<Tz>('CT');
  const [pick, setPick] = useState<{ ids: string[]; i: number } | null>(null);

  const end = anchor && dates.includes(anchor) ? anchor : latest;
  const range = useMemo(() => {
    if (!latest || !end) return null;
    if (preset === 'custom' && custom) return custom;
    if (preset === 'month' || preset === 'custom') return monthRange(end);
    const pos = dates.indexOf(end);
    return { from: dates[Math.max(0, pos - preset + 1)], to: end };
  }, [preset, custom, dates, latest, end]);
  const rangeInvalid = !!range && range.from > range.to;
  const summaryDay = summarySession && dates.includes(summarySession) ? summarySession : (range?.to && dates.filter((d) => d <= range.to).pop()) || latest || '';

  const config: OverviewConfig | null = range && !rangeInvalid
    ? { from: range.from, to: range.to, chartMinutes, overlay, summary, summarySession: summaryDay, topN, minQty, bucketTicks, retention, rule: { reactionTicks, windowMinutes, toleranceTicks } }
    : null;
  const configKey = JSON.stringify(config);
  const model = useMemo(() => {
    if (!all.sessions || !config) return null;
    try { return { m: buildOverview(all.sessions, config), err: null as string | null }; }
    catch (e) { return { m: null, err: (e as Error).message }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.dataKey, configKey]);

  const lines = model?.m?.lines ?? [];
  const group = useMemo(() => (pick ? pick.ids.map((id) => lines.find((l) => l.id === id)).filter((l): l is NonNullable<typeof l> => !!l) : []), [pick, lines]);
  const selected = group[pick?.i ?? 0] ?? null;
  const selectFromTable = (id: string) => {
    const l = lines.find((x) => x.id === id);
    if (!l) return;
    const same = lines.filter((x) => x.priceTicks === l.priceTicks && x.bucketTicks === l.bucketTicks).sort((a, b) => a.startMs - b.startMs);
    setPick({ ids: same.map((x) => x.id), i: same.findIndex((x) => x.id === id) });
  };

  const setRange = (k: 'from' | 'to', v: string) => {
    if (!v || !range) return;
    setPick(null);
    setPreset('custom');
    setCustom({ ...range, [k]: v });
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-end gap-x-5 gap-y-2 border-b border-border bg-card px-4 py-2.5">
        <div className="mr-2">
          <h1 className="text-[15px] font-semibold leading-tight tracking-tight">
            <span className="tabular mr-2 rounded-sm bg-foreground px-1.5 py-0.5 text-[12px] text-background">{idx.data?.instrument ?? 'GCZ6'}</span>
            N約定 集中価格 期間俯瞰
          </h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">過去のN価格が後で再訪されたかを目視で確かめる記録。売買シグナルではなく、統計的優位性も示しません。</p>
        </div>
        <Link href="/" data-testid="link-daily" className="inline-flex h-7 items-center gap-1 rounded-sm border border-input bg-card px-2 text-[11px] hover:bg-accent">
          <ArrowLeft className="h-3.5 w-3.5" />日次リサーチ
        </Link>
        {import.meta.env.DEV && import.meta.env.VITE_RANGE_RESEARCH_ENABLED === '1'
          && <Link href="/range-bars" className="text-xs underline">レンジバー研究</Link>}
        <Seg id="tz" label="時刻表示" value={tz} options={[{ v: 'CT', l: 'CT' }, { v: 'JST', l: 'JST' }]} onChange={setTz} />
      </header>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border bg-card/60 px-4 py-2" role="group" aria-label="期間と表示">
        <Seg id="preset" label="期間プリセット" value={preset}
          options={[{ v: 'month', l: '暦月' }, { v: 1, l: '1' }, { v: 3, l: '3' }, { v: 5, l: '5' }, { v: 10, l: '10' }, { v: 20, l: '20' }, ...(preset === 'custom' ? [{ v: 'custom' as Preset, l: '任意' }] : [])]}
          onChange={(p) => { setPreset(p); setPick(null); }} />
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground">基準セッション</span>
          <select className={sel} data-testid="select-anchor" value={end ?? ''} onChange={(e) => { setAnchor(e.target.value); setPick(null); if (preset === 'custom') setPreset('month'); }}>
            {dates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5"><span className="text-[11px] text-muted-foreground">開始(CT)</span>
          <input type="date" data-testid="input-from" className={sel} value={range?.from ?? ''} onChange={(e) => setRange('from', e.target.value)} /></label>
        <label className="flex flex-col gap-0.5"><span className="text-[11px] text-muted-foreground">終了(CT)</span>
          <input type="date" data-testid="input-to" className={sel} value={range?.to ?? ''} onChange={(e) => setRange('to', e.target.value)} /></label>
        <Seg id="bars" label="ローソク足" value={chartMinutes} options={[{ v: 1, l: '1分' }, { v: 5, l: '5分' }]} onChange={setChartMinutes} />
        <Seg id="overlay" label="ライン起点" value={overlay} options={[{ v: 'previous', l: '前日' }, { v: '5', l: '5' }, { v: '10', l: '10' }, { v: '20', l: '20' }, { v: 'visible', l: '表示期間' }]} onChange={(v) => { setOverlay(v); setPick(null); }} />
        <Seg id="retention" label="保持(セッション)" value={retention} options={[{ v: 1, l: '1' }, { v: 3, l: '3' }, { v: 5, l: '5' }, { v: 'all', l: '全' }]} onChange={setRetention} />
        <Num id="top-n" label="上位N本" value={topN} min={0} max={50} onChange={setTopN} />
        <Num id="min-qty" label="最小数量" value={minQty} min={0} max={1_000_000} onChange={setMinQty} />
        <Num id="bucket" label="バケットtick" value={bucketTicks} min={1} max={100} onChange={setBucketTicks} />
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border bg-card/60 px-4 py-2" role="group" aria-label="記述ルールと左プロファイル">
        <Num id="reaction-ticks" label="反応幅tick" value={reactionTicks} min={1} max={1000} onChange={setReactionTicks} />
        <Seg id="window" label="観測窓(分)" value={windowMinutes} options={[{ v: 5, l: '5' }, { v: 15, l: '15' }, { v: 30, l: '30' }]} onChange={setWindowMinutes} />
        <Num id="tolerance" label="許容tick" value={toleranceTicks} min={0} max={100} onChange={setToleranceTicks} />
        <span className="mx-1 hidden h-8 w-px bg-border sm:block" />
        <Seg id="summary" label="左プロファイル(回顧のみ・ライン非生成)" value={summary} options={[{ v: 'session', l: '単日' }, { v: '5', l: '5' }, { v: '10', l: '10' }, { v: '20', l: '20' }, { v: 'visible', l: '表示期間' }]} onChange={setSummary} />
        <label className="flex flex-col gap-0.5"><span className="text-[11px] text-muted-foreground">プロファイル基準日</span>
          <select className={sel} data-testid="select-summary-session" value={summaryDay} onChange={(e) => setSummarySession(e.target.value)}>
            {dates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select></label>
      </div>

      <main className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {idx.isLoading ? <Skeleton label="インデックス読込中…" />
          : idx.isError ? <ErrorBox msg={(idx.error as Error).message} onRetry={() => idx.refetch()} />
          : !items.length ? <Notice title="セッションデータがありません" body="research-data/index.json にセッションが含まれていません。" />
          : all.errors.length ? <ErrorBox msg={`全${all.total}ファイル中 ${all.errors.length} 件が利用できないため、部分的な結果は表示しません。`} list={all.errors} onRetry={all.retry} />
          : !all.complete ? <Skeleton label={`セッション読込中… ${all.loaded}/${all.total}`} />
          : rangeInvalid ? <Notice title="期間が不正です" body="開始日が終了日より後になっています。" />
          : model?.err ? <Notice title="条件を確認してください" body={model.err} />
          : model?.m ? (
            <>
              <Warnings warnings={[...model.m.warnings, ...(range && latest && range.to > latest ? [`${latest} 以降 ${range.to} までは未収録(データなし区間として表示)`] : []), ...(range && dates[0] && range.from < dates[0] ? [`${range.from} から ${dates[0]} の前までは未収録`] : [])]} />
              <div className="flex flex-col gap-3 xl:flex-row">
                <section className="flex min-h-[520px] min-w-0 flex-1 flex-col overflow-hidden rounded-sm border border-card-border bg-card xl:h-[640px]" aria-label="チャート">
                  <OverviewChart key={`${range?.from}|${range?.to}|${chartMinutes}`} model={model.m} chartMinutes={chartMinutes} bucketTicks={bucketTicks} tz={tz} selectedId={selected?.id ?? null} onPick={(ids) => setPick({ ids, i: 0 })} />
                  <ChartLegend />
                </section>
                <aside className="flex w-full shrink-0 flex-col gap-3 xl:w-[360px]">
                  {selected && <LineDetails group={group} index={pick?.i ?? 0} onIndex={(i) => setPick((p) => (p ? { ...p, i } : p))} onClose={() => setPick(null)} tz={tz} />}
                  <LineTable lines={lines} selectedId={selected?.id ?? null} onSelect={selectFromTable} tz={tz} />
                </aside>
              </div>
              <DailyPanel daily={model.m.daily} from={range?.from} to={range?.to} onSelectDay={(d) => { setSummarySession(d); setSummary('session'); }} />
            </>
          ) : <Skeleton label="集計中…" />}
      </main>
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded-sm border border-chart-3/50 bg-accent/50 px-3 py-1.5 text-[11px] text-accent-foreground" role="note" data-testid="panel-warnings">
      <div>記述統計のみ。接触・反応・突破の件数は将来の値動きの予測や優位性を意味しません。</div>
      {warnings.map((w, i) => <div key={i} data-testid={`text-warning-${i}`}>· {w}</div>)}
    </div>
  );
}

function ChartLegend() {
  const item = 'inline-flex items-center gap-1.5';
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground" data-testid="legend-overview">
      <span className={item}><span className="h-0.5 w-5 bg-chart-1" />N集中価格(起点→有効終了)</span>
      <span className={item}><span className="h-0.5 w-5 bg-chart-1 opacity-30" />古い起点ほど淡色</span>
      <span className={item}><span className="h-[3px] w-5 bg-chart-1" />太さ=同価格で既に形成済みの同時有効本数</span>
      <span className={item}><span className="w-5 border-t border-dashed border-chart-1" />sourcePartial / historyShort</span>
      <span className={item}><span className="h-2.5 w-3 bg-[rgba(91,101,115,0.18)]" />未収録・休場等（無約定とは区別）</span>
      <span className={item}><span className="h-2.5 w-3 bg-[rgba(196,145,46,0.3)]" />部分セッション</span>
      <span>スマホ：2本指で拡大・縮小、1本指で移動、ラインをタップで詳細。ページ移動はチャート外をスクロール。PC：ホイール=時間ズーム · Shift+ホイール/右軸ドラッグ=価格 · ドラッグ=移動 · ダブルクリック=フィット</span>
    </div>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <div className="flex min-h-[520px] gap-2.5 rounded-sm border border-card-border bg-card p-3" data-testid="status-loading" aria-busy="true">
      <div className="flex w-[16%] flex-col justify-center gap-1">
        {[38, 54, 72, 90, 66, 48, 80, 34, 58, 42].map((w, i) => <div key={i} className="h-2 rounded-sm bg-muted" style={{ width: `${w}%` }} />)}
      </div>
      <div className="relative flex-1 rounded-sm bg-muted/60"><span className="absolute left-3 top-3 text-xs text-muted-foreground">{label}</span></div>
    </div>
  );
}

function ErrorBox({ msg, list, onRetry }: { msg: string; list?: string[]; onRetry?: () => void }) {
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-3 rounded-sm border border-card-border bg-card p-6 text-center" role="alert" data-testid="status-error">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="max-w-lg text-sm">{msg}</p>
      {list && <ul className="tabular max-h-40 max-w-lg overflow-auto text-left text-[11px] text-muted-foreground">{list.map((l) => <li key={l}>{l}</li>)}</ul>}
      {onRetry && <button onClick={onRetry} data-testid="button-retry" className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs text-primary-foreground"><RefreshCw className="h-3.5 w-3.5" />再試行</button>}
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center gap-2 rounded-sm border border-card-border bg-card p-6 text-center" role="status" data-testid="status-empty">
      <div className="h-px w-16 bg-chart-1" /><p className="text-sm font-semibold">{title}</p><p className="max-w-md text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
