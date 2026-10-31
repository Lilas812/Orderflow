import { useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { type Tz, formatDateTime, formatPrice, formatQty } from '@/lib/research';
import type { DaySummary, ResearchLine } from '@/lib/overview';
import { lineCenter } from '@/components/overview-chart';

const pct = (r: number | null) => (r == null ? '—' : `${(r * 100).toFixed(2)}%`);

function Badge({ children, tone = 'warn' }: { children: React.ReactNode; tone?: 'warn' | 'muted' }) {
  return (
    <span className={`ml-1 rounded-sm border px-1 text-[9px] ${tone === 'warn' ? 'border-chart-3/60 bg-accent text-accent-foreground' : 'border-border bg-muted text-muted-foreground'}`}>
      {children}
    </span>
  );
}

export function LineFlags({ l }: { l: ResearchLine }) {
  return (
    <>
      {l.sourcePartial && <Badge>sourcePartial</Badge>}
      {l.historyShort && <Badge tone="muted">historyShort</Badge>}
    </>
  );
}

export function DailyPanel({ daily: allDays, onSelectDay, from, to }: {
  daily: DaySummary[]; onSelectDay: (d: string) => void; from?: string; to?: string;
}) {
  const daily = allDays.filter((d) => d.selected);
  const [mode, setMode] = useState<'calendar' | 'list'>('calendar');
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const dates = daily.map((d) => d.date).sort();
  const first = dates[0], last = dates[dates.length - 1];
  const cells: (string | null)[] = [];
  if (first) {
    const s = new Date((from || first) + 'T00:00:00Z');
    const e = new Date((to || last) + 'T00:00:00Z');
    for (let i = 0; i < s.getUTCDay(); i++) cells.push(null);
    for (let t = s.getTime(); t <= e.getTime(); t += 86_400_000) cells.push(new Date(t).toISOString().slice(0, 10));
  }
  return (
    <section className="rounded-sm border border-card-border bg-card" aria-label="日別" data-testid="panel-daily">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <h2 className="text-xs font-semibold">日別 N 集計</h2>
        <span className="text-[10px] text-muted-foreground">従来比: N/(A+B) · 全体比: N/(A+B+N) · 後続接触 = ライン別の延べ回数（表示期間内）</span>
        <div className="ml-auto flex overflow-hidden rounded-sm border border-input" role="radiogroup" aria-label="表示形式">
          {(['calendar', 'list'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} data-testid={`button-daily-${m}`} onClick={() => setMode(m)} className={`px-2 py-0.5 text-[11px] ${mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}>
              {m === 'calendar' ? 'カレンダー' : 'リスト'}
            </button>
          ))}
        </div>
      </div>
      {!daily.length ? (
        <p className="p-4 text-center text-xs text-muted-foreground" data-testid="status-daily-empty">この期間に収録セッションはありません。</p>
      ) : mode === 'calendar' ? (
        <div className="overflow-x-auto p-2">
          <div className="grid min-w-[720px] grid-cols-7 gap-1">
            {['日', '月', '火', '水', '木', '金', '土'].map((w) => <div key={w} className="text-center text-[10px] text-muted-foreground">{w}</div>)}
            {cells.map((c, i) => {
              const d = c ? byDate.get(c) : undefined;
              if (!c) return <div key={'e' + i} />;
              if (!d) return (
                <div key={c} className="min-h-[92px] rounded-sm border border-dashed border-border bg-muted/40 p-1.5 text-[10px] text-muted-foreground" data-testid={`cell-day-${c}`}>
                  <div className="tabular">{c.slice(5)}</div><div className="mt-1">データなし</div>
                </div>
              );
              return (
                <button key={c} onClick={() => onSelectDay(c)} data-testid={`cell-day-${c}`} className={`min-h-[92px] rounded-sm border p-1.5 text-left text-[10px] hover:bg-accent ${'border-card-border'}`}>
                  <div className="flex items-center"><span className="tabular font-semibold">{c.slice(5)}</span>{d.partial && <Badge>部分</Badge>}</div>
                  <div className="tabular mt-0.5">N {formatQty(d.nQuantity)} lot</div>
                  <div className="tabular text-muted-foreground">A {pct(d.ratioTraditional)} · B {pct(d.ratioAll)}</div>
                  <div className="tabular mt-0.5 text-chart-1">{d.topLevels.slice(0, 3).map((t) => formatPrice(t.priceTicks)).join(' ') || '—'}</div>
                  <div className="tabular text-muted-foreground">後続接触 {d.touchesAfter}</div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full min-w-[640px] text-[11px]">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-right [&>th:first-child]:text-left">
                <th>日付</th><th>N lot</th><th>N 件</th><th>全数量</th><th>N/(A+B)</th><th>N/(A+B+N)</th><th>主要価格</th><th>後続接触</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.date} onClick={() => onSelectDay(d.date)} data-testid={`row-day-${d.date}`} className={`tabular cursor-pointer border-t border-border hover:bg-accent [&>td]:px-2 [&>td]:py-1 [&>td]:text-right [&>td:first-child]:text-left `}>
                  <td>{d.date}{d.partial && <Badge>部分</Badge>}</td>
                  <td>{formatQty(d.nQuantity)}</td><td>{formatQty(d.nCount)}</td><td>{formatQty(d.quantity)}</td>
                  <td>{pct(d.ratioTraditional)}</td><td>{pct(d.ratioAll)}</td>
                  <td className="text-chart-1">{d.topLevels.map((t) => `${formatPrice(t.priceTicks)}(${formatQty(t.quantity)})`).join(' ') || '—'}</td>
                  <td>{d.touchesAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function LineTable({ lines, selectedId, onSelect, tz }: { lines: ResearchLine[]; selectedId: string | null; onSelect: (id: string) => void; tz: Tz }) {
  return (
    <section className="flex min-h-0 flex-col rounded-sm border border-card-border bg-card" aria-label="ライン一覧" data-testid="panel-lines">
      <h2 className="border-b border-border px-3 py-1.5 text-xs font-semibold">ライン一覧 <span className="tabular font-normal text-muted-foreground">{lines.length} 本</span></h2>
      {!lines.length ? (
        <p className="p-4 text-center text-xs text-muted-foreground" data-testid="status-lines-empty">条件に合うラインはありません。上位N本・最小数量・起点モードを見直してください。</p>
      ) : (
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-right [&>th:first-child]:text-left"><th>価格</th><th>起点</th><th>N 数量</th><th>接触</th><th>反応/突破</th></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} onClick={() => onSelect(l.id)} data-testid={`row-line-${l.id}`} className={`tabular cursor-pointer border-t border-border hover:bg-accent [&>td]:px-2 [&>td]:py-1 [&>td]:text-right [&>td:first-child]:text-left ${l.id === selectedId ? 'bg-accent' : ''}`} title={`${formatDateTime(l.startMs, tz)} → ${formatDateTime(l.endMs, tz)}`}>
                  <td className="text-chart-1">{formatPrice(lineCenter(l))}</td>
                  <td>{l.sourceSession.slice(5)}<LineFlags l={l} /></td>
                  <td>{formatQty(l.quantity)}</td>
                  <td>{l.stats.touches}</td>
                  <td>{l.stats.reactions}/{l.stats.breakouts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const OUT: Record<string, string> = { reaction: '反応', breakout: '突破', ambiguous: '曖昧', unobserved: '未観測', neutral: '中立' };
const APP: Record<string, string> = { above: '上から', below: '下から', unknown: '不明' };

export function LineDetails({ group, index, onIndex, onClose, tz }: { group: ResearchLine[]; index: number; onIndex: (i: number) => void; onClose: () => void; tz: Tz }) {
  const l = group[index];
  if (!l) return null;
  const rows: [string, React.ReactNode][] = [
    ['価格(中心)', formatPrice(lineCenter(l))],
    ['バケット', `${formatPrice(l.priceTicks)} 〜 ${formatPrice(l.priceTicks + l.bucketTicks - 1)}`],
    ['起点セッション', l.sourceSession],
    ['N 数量 / 件数', `${formatQty(l.quantity)} / ${formatQty(l.count)}`],
    ['有効開始', formatDateTime(l.startMs, tz)],
    ['有効終了', formatDateTime(l.endMs, tz)],
    ['フラグ', l.sourcePartial || l.historyShort ? <LineFlags l={l} /> : 'なし'],
    ['接触 / 反応 / 突破', `${l.stats.touches} / ${l.stats.reactions} / ${l.stats.breakouts}`],
    ['再接触 / 曖昧 / 未観測 / 中立', `${l.stats.retests} / ${l.stats.ambiguous} / ${l.stats.unobserved} / ${l.stats.neutral}`],
  ];
  return (
    <section className="rounded-sm border border-primary/50 bg-card" aria-label="ライン詳細" data-testid="panel-line-details">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <h2 className="text-xs font-semibold">ライン詳細</h2>
        {group.length > 1 && (
          <div className="ml-2 flex items-center gap-1 text-[11px]">
            <button aria-label="前の起点" data-testid="button-origin-prev" onClick={() => onIndex((index - 1 + group.length) % group.length)} className="rounded-sm border border-input px-1 hover:bg-accent"><ChevronLeft className="h-3 w-3" /></button>
            <span className="tabular" data-testid="text-origin-position">近接ライン {index + 1}/{group.length}</span>
            <button aria-label="次の起点" data-testid="button-origin-next" onClick={() => onIndex((index + 1) % group.length)} className="rounded-sm border border-input px-1 hover:bg-accent"><ChevronRight className="h-3 w-3" /></button>
          </div>
        )}
        <button aria-label="閉じる" data-testid="button-close-details" onClick={onClose} className="ml-auto rounded-sm p-0.5 hover:bg-accent"><X className="h-3.5 w-3.5" /></button>
      </div>
      {group.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-border px-3 py-1.5">
          {group.map((g, i) => (
            <button key={g.id} data-testid={`button-origin-${g.id}`} onClick={() => onIndex(i)} className={`tabular rounded-sm border px-1.5 text-[10px] ${i === index ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent'}`}>
              {g.sourceSession.slice(5)} · {formatPrice(lineCenter(g))}
            </button>
          ))}
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-3 py-2 text-[11px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="tabular text-right">{v}</dd></div>
        ))}
      </dl>
      <div className="max-h-[260px] overflow-auto border-t border-border">
        {!l.events.length ? (
          <p className="p-3 text-center text-[11px] text-muted-foreground" data-testid="status-events-empty">有効期間中の接触はありません。</p>
        ) : (
          <table className="w-full text-[10px]">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-left"><th>時刻</th><th>結果</th><th>接近</th><th>再接触</th><th>理由</th></tr>
            </thead>
            <tbody>
              {l.events.map((e, i) => (
                <tr key={i} className="tabular border-t border-border align-top [&>td]:px-2 [&>td]:py-1" data-testid={`row-event-${i}`}>
                  <td className="whitespace-nowrap">{formatDateTime(e.timeMs, tz)}<div className="text-muted-foreground">→ {formatDateTime(e.endMs, tz).slice(11)}</div></td>
                  <td>{OUT[e.outcome] ?? e.outcome}</td>
                  <td>{APP[e.approach] ?? e.approach}</td>
                  <td>{e.retest ? 'はい' : '—'}</td>
                  <td className="font-sans text-muted-foreground">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
