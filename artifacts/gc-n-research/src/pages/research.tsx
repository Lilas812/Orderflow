import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useResearchIndex, useSessionData } from '@/hooks/use-research';
import { ResearchChart } from '@/components/research-chart';
import { LevelTable } from '@/components/level-table';
import { Legend } from '@/components/legend';
import { type Tz, bucketProfile, formatQty, selectLevels } from '@/lib/research';

const INITIAL_DATE = '2026-10-16';

function NumField(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max?: number;
  onChange: (n: number) => void;
  hint?: string;
}) {
  const [raw, setRaw] = useState(String(props.value));
  const invalid = raw.trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) < props.min;
  return (
    <label htmlFor={props.id} className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{props.label}</span>
      <input
        id={props.id}
        data-testid={`input-${props.id}`}
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        step={1}
        value={raw}
        aria-invalid={invalid}
        onChange={(e) => {
          setRaw(e.target.value);
          const n = Math.floor(Number(e.target.value));
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= props.min) {
            props.onChange(props.max ? Math.min(props.max, n) : n);
          }
        }}
        onBlur={() => setRaw(String(props.value))}
        className={`tabular h-8 w-24 rounded-sm border bg-card px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          invalid ? 'border-destructive' : 'border-input'
        }`}
      />
      {props.hint && <span className="text-[10px] text-muted-foreground">{props.hint}</span>}
    </label>
  );
}

export default function ResearchPage() {
  const idx = useResearchIndex();
  const [requested, setRequested] = useState<string | null>(null);
  const [topN, setTopN] = useState(3);
  const [minQty, setMinQty] = useState(1);
  const [bucket, setBucket] = useState(1);
  const [tz, setTz] = useState<Tz>('CT');

  const sessions = useMemo(
    () => [...(idx.data?.sessions ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [idx.data],
  );
  const date =
    requested ??
    (sessions.length ? (sessions.some((s) => s.date === INITIAL_DATE) ? INITIAL_DATE : sessions[sessions.length - 1].date) : null);
  const pos = sessions.findIndex((s) => s.date === date);
  const item = pos >= 0 ? sessions[pos] : null;
  const unavailable = !!date && sessions.length > 0 && !item;

  const sq = useSessionData(item);
  // Guard: only use data that belongs to the selected session.
  const data = sq.data && item && sq.data.session === item.date ? sq.data : null;
  const mismatch = !!sq.data && !!item && sq.data.session !== item.date;

  const profile = useMemo(() => (data ? bucketProfile(data.profile, bucket) : []), [data, bucket]);
  const levels = useMemo(() => (data ? selectLevels(data.profile, topN, minQty, bucket) : []), [data, topN, minQty, bucket]);

  const go = (d: number) => {
    if (pos < 0) return;
    const n = sessions[pos + d];
    if (n) setRequested(n.date);
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-border bg-card px-4 py-2.5">
        <div className="mr-2">
          <h1 className="text-[15px] font-semibold leading-tight tracking-tight">
            <span className="tabular mr-2 rounded-sm bg-foreground px-1.5 py-0.5 text-[12px] text-background">
              {idx.data?.instrument ?? 'GCZ6'}
            </span>
            前セッションN約定 集中価格リサーチ
          </h1>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            目視検証用。売買シグナル・バックテストではありません。N = 不明アグレッサー約定(B/Aは不使用)。
          </p>
        </div>

        <div className="flex items-end gap-1" role="group" aria-label="セッション選択">
          <button
            aria-label="前のセッション"
            data-testid="button-prev-session"
            disabled={pos <= 0}
            onClick={() => go(-1)}
            className="h-8 rounded-sm border border-input bg-card px-1.5 hover:bg-accent disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <label className="flex flex-col gap-0.5" htmlFor="session-date">
            <span className="text-[11px] text-muted-foreground">セッション(終了日・CT)</span>
            <input
              id="session-date"
              data-testid="input-session-date"
              type="date"
              value={date ?? ''}
              min={sessions[0]?.date}
              max={sessions[sessions.length - 1]?.date}
              list="session-dates"
              disabled={!sessions.length}
              onChange={(e) => e.target.value && setRequested(e.target.value)}
              className="tabular h-8 rounded-sm border border-input bg-card px-2 text-sm"
            />
            <datalist id="session-dates">
              {sessions.map((s) => (
                <option key={s.date} value={s.date} />
              ))}
            </datalist>
          </label>
          <button
            aria-label="次のセッション"
            data-testid="button-next-session"
            disabled={pos < 0 || pos >= sessions.length - 1}
            onClick={() => go(1)}
            className="h-8 rounded-sm border border-input bg-card px-1.5 hover:bg-accent disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          {pos >= 0 && (
            <span className="tabular ml-1 self-center text-[11px] text-muted-foreground" data-testid="text-session-position">
              {pos + 1}/{sessions.length}
            </span>
          )}
        </div>

        <div className="flex items-end gap-3" role="group" aria-label="集中価格の抽出条件">
          <NumField id="top-n" label="上位N本" value={topN} min={0} max={50} onChange={setTopN} />
          <NumField id="min-qty" label="最小数量" value={minQty} min={0} onChange={setMinQty} />
          <NumField id="bucket-ticks" label="価格バケット(tick)" value={bucket} min={1} max={100} onChange={setBucket} hint={`= ${(bucket * 0.1).toFixed(1)}`} />
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted-foreground" id="tz-label">時刻表示</span>
          <div role="radiogroup" aria-labelledby="tz-label" className="flex h-8 overflow-hidden rounded-sm border border-input">
            {(['CT', 'JST'] as Tz[]).map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={tz === t}
                data-testid={`button-tz-${t.toLowerCase()}`}
                onClick={() => setTz(t)}
                className={`tabular px-3 text-xs ${tz === t ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-accent'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
        <section className="flex min-h-[520px] flex-1 flex-col overflow-hidden rounded-sm border border-card-border bg-card lg:min-h-0" aria-label="チャート">
          <SessionStrip item={item} data={data} />
          <div className="min-h-0 flex-1">
            {idx.isLoading ? (
              <ChartSkeleton label="インデックス読込中…" />
            ) : idx.isError ? (
              <ErrorState message={(idx.error as Error).message} onRetry={() => idx.refetch()} />
            ) : !sessions.length ? (
              <Empty title="セッションデータがありません" body="research-data/index.json にセッションが含まれていません。" />
            ) : unavailable ? (
              <Empty
                testId="status-date-unavailable"
                title={`${date} は利用できません`}
                body="このセッションのデータはありません(週末・休場・未収録)。別の日付は自動選択しません。前後ボタンか日付欄で利用可能なセッションを選んでください。"
              />
            ) : sq.isError ? (
              <ErrorState message={(sq.error as Error).message} onRetry={() => sq.refetch()} />
            ) : mismatch ? (
              <ErrorState message={`ファイル内容のセッション(${sq.data?.session})が要求(${item?.date})と一致しません。`} onRetry={() => sq.refetch()} />
            ) : !data ? (
              <ChartSkeleton label={`${date} 読込中…`} />
            ) : (
              <ResearchChart key={data.session} data={data} profile={profile} bucketTicks={bucket} levels={levels} tz={tz} />
            )}
          </div>
          <Legend />
        </section>

        <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-[300px]" aria-label="集中価格と要約">
          <LevelTable levels={data ? levels : null} topN={topN} minQty={minQty} bucket={bucket} />
          <SummaryCard data={data} />
          {idx.data && (
            <div className="rounded-sm border border-card-border bg-card p-3 text-[10px] leading-relaxed text-muted-foreground">
              <div>{idx.data.source}</div>
              <div>tick {idx.data.tickSize} · {idx.data.timezone} · セッション 17:00→翌17:00 CT</div>
              <div className="tabular break-all" title="sourceSha256">sha256 {idx.data.sourceSha256}</div>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function SessionStrip({ item, data }: { item: { date: string; previousDate: string | null; partial: boolean; previousPartial: boolean } | null; data: { previousSession: string | null } | null }) {
  if (!item) return <div className="h-8 border-b border-border" />;
  const prev = data?.previousSession ?? item.previousDate;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-1.5 text-xs" data-testid="text-session-strip">
      <span>
        <span className="text-muted-foreground">前セッション </span>
        <span className="tabular font-medium" data-testid="text-previous-session">{prev ?? 'なし'}</span>
        {item.previousPartial && <Flag>部分</Flag>}
      </span>
      <span className="text-muted-foreground">→</span>
      <span>
        <span className="text-muted-foreground">選択セッション </span>
        <span className="tabular font-medium" data-testid="text-current-session">{item.date}</span>
        {item.partial && <Flag>部分</Flag>}
      </span>
      {!prev && <span className="text-destructive">前セッションが無いため集中価格は表示されません</span>}
    </div>
  );
}

function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-1.5 rounded-sm border border-chart-3/60 bg-accent px-1 text-[10px] text-accent-foreground" data-testid="badge-partial">
      {children}
    </span>
  );
}

function SummaryCard({ data }: { data: import('@/lib/research').SessionData | null }) {
  const rows: [string, string][] = data
    ? [
        ['選択 全約定 件数', formatQty(data.summary.tradeCount)],
        ['選択 全約定 数量', formatQty(data.summary.quantity)],
        ['選択 N 件数', formatQty(data.summary.nCount)],
        ['選択 N 数量', formatQty(data.summary.nQuantity)],
        ['前 N 件数', formatQty(data.summary.previousNCount)],
        ['前 N 数量', formatQty(data.summary.previousNQuantity)],
        ['1分足 本数', formatQty(data.candles.length)],
        ['プロファイル価格数', formatQty(data.profile.length)],
      ]
    : [];
  return (
    <div className="rounded-sm border border-card-border bg-card p-3" data-testid="panel-summary">
      <h2 className="mb-2 text-xs font-semibold">要約</h2>
      {data ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[11px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="tabular text-right" data-testid={`text-summary-${k}`}>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="space-y-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-3 rounded-sm bg-muted" />
          ))}
        </div>
      )}
    </div>
  );
}

function ChartSkeleton({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[400px] gap-2.5 p-3" data-testid="status-loading" aria-busy="true">
      <div className="flex w-[22%] flex-col justify-center gap-1">
        {[38, 54, 72, 90, 66, 48, 80, 34, 58, 42].map((w, i) => (
          <div key={i} className="h-2 rounded-sm bg-muted" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="relative flex-1 rounded-sm bg-muted/60">
        <span className="absolute left-3 top-3 text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-3 p-6 text-center" role="alert" data-testid="status-error">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="max-w-md text-sm">{message}</p>
      <button onClick={onRetry} data-testid="button-retry" className="inline-flex items-center gap-1.5 rounded-sm bg-primary px-3 py-1.5 text-xs text-primary-foreground">
        <RefreshCw className="h-3.5 w-3.5" />再試行
      </button>
    </div>
  );
}

function Empty({ title, body, testId }: { title: string; body: string; testId?: string }) {
  return (
    <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-2 p-6 text-center" role="status" data-testid={testId ?? 'status-empty'}>
      <div className="h-px w-16 bg-chart-1" />
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
