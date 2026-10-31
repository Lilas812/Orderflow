/** Research-only, deterministic OHLC observations; never a trading signal.
 * Display timestamps use the existing research minute JSON convention (ms).
 * Quantity and prices remain integer lots / ticks; source trades are unchanged.
 */
import { bucketProfile, selectLevels, MINUTE_MS } from './research.ts';
import type { Candle, ProfileRow, SessionData } from './research.ts';

export type OverviewSession = SessionData & {
  ownProfile: ProfileRow[];
  availableStartMs: number;
  availableEndMs: number;
};
export type WindowMode = 'previous' | '5' | '10' | '20' | 'visible';
export type OverviewConfig = {
  from: string; to: string; chartMinutes: 1 | 5;
  overlay: WindowMode; summary: 'session' | '5' | '10' | '20' | 'visible';
  summarySession: string; topN: number; minQty: number; bucketTicks: number;
  retention: 1 | 3 | 5 | 'all';
  rule: { reactionTicks: number; windowMinutes: number; toleranceTicks: number };
};
export type TouchEvent = {
  timeMs: number; endMs: number;
  outcome: 'reaction' | 'breakout' | 'ambiguous' | 'unobserved' | 'neutral';
  approach: 'above' | 'below' | 'unknown'; retest: boolean; reason: string;
};
export type ResearchLine = {
  id: string; sourceSession: string; priceTicks: number; bucketTicks: number;
  quantity: number; count: number; startMs: number; endMs: number;
  sourcePartial: boolean; historyShort: boolean; events: TouchEvent[];
  stats: { touches: number; reactions: number; breakouts: number; retests: number;
    ambiguous: number; unobserved: number; neutral: number };
};
export type DaySummary = {
  date: string; partial: boolean; tradeCount: number; quantity: number;
  nCount: number; nQuantity: number; ratioTraditional: number | null; ratioAll: number | null;
  topLevels: { priceTicks: number; quantity: number }[];
  touchesAfter: number; selected: boolean; availableStartMs: number; availableEndMs: number;
};
export type OverviewModel = {
  candles: Candle[]; profile: ProfileRow[]; lines: ResearchLine[]; daily: DaySummary[];
  timeStartMs: number; timeEndMs: number; warnings: string[];
};

/** Overlap strength changes only when another line actually forms/expires. */
export function overlapSegments(line: ResearchLine, lines: ResearchLine[]) {
  const same = lines.filter(l => l.priceTicks === line.priceTicks &&
    l.bucketTicks === line.bucketTicks && l.startMs < line.endMs && l.endMs > line.startMs);
  const cuts = [...new Set([line.startMs, line.endMs, ...same.flatMap(l =>
    [Math.max(l.startMs, line.startMs), Math.min(l.endMs, line.endMs)])])].sort((a, b) => a - b);
  return cuts.slice(0, -1).map((startMs, i) => ({
    startMs, endMs: cuts[i + 1],
    count: same.filter(l => l.startMs <= startMs && l.endMs > startMs).length,
  }));
}

function local17(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const desired = Date.UTC(y, m - 1, d, 17);
  let time = desired;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(time);
    const get = (key: string) => Number(parts.find(p => p.type === key)?.value);
    time += desired - Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  }
  return time;
}

export function ctSessionBounds(date: string): { startMs: number; endMs: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
    throw Error('日付は実在する YYYY-MM-DD で指定してください');
  const previous = new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
  return { startMs: local17(previous), endMs: local17(date) };
}

export function aggregateCandles(bars: Candle[], minutes: 1 | 5): Candle[] {
  if (minutes === 1) return bars;
  const result: Candle[] = [];
  for (const c of bars) {
    const timeMs = Math.floor(c.timeMs / (MINUTE_MS * minutes)) * MINUTE_MS * minutes;
    const prev = result[result.length - 1];
    if (prev?.timeMs === timeMs) {
      prev.highTicks = Math.max(prev.highTicks, c.highTicks);
      prev.lowTicks = Math.min(prev.lowTicks, c.lowTicks);
      prev.closeTicks = c.closeTicks;
      prev.quantity += c.quantity;
      prev.count += c.count;
    } else result.push({ ...c, timeMs });
  }
  return result;
}

type Interval = { start: number; end: number };
function covered(start: number, end: number, intervals: Interval[]) {
  let cursor = start;
  for (const i of intervals) {
    if (i.end <= cursor) continue;
    if (i.start > cursor) return false;
    cursor = Math.max(cursor, i.end);
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

/** A full observation window is reserved per accepted touch. No overlapping
 * windows, no counting a continuous contact twice. OHLC order ambiguity is
 * deliberately conservative, including the touch bar's pre-touch excursion.
 */
export function observeLine(
  bars: Candle[], price: number, start: number, end: number,
  rule: OverviewConfig['rule'], coverage: Interval[],
): TouchEvent[] {
  const events: TouchEvent[] = [];
  const tolerance = Math.max(0, rule.toleranceTicks);
  const move = Math.max(tolerance + 1, rule.reactionTicks);
  const duration = Math.max(1, rule.windowMinutes) * MINUTE_MS;
  let inContact = false, blockedUntil = -Infinity, previous: Candle | undefined;
  let pendingRetest = false;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.timeMs >= end) break;
    if (bar.timeMs < start) { previous = bar; continue; }
    const hits = bar.highTicks >= price - tolerance && bar.lowTicks <= price + tolerance;
    const newContact = hits && !inContact;
    inContact = hits;
    if (!newContact || bar.timeMs < blockedUntil) { previous = bar; continue; }
    const horizon = bar.timeMs + duration;
    blockedUntil = horizon;
    // An opening price within/opposite the band cannot establish the
    // intrabar approach side from the previous close alone.
    const above = previous && previous.closeTicks > price + tolerance && bar.openTicks > price + tolerance;
    const below = previous && previous.closeTicks < price - tolerance && bar.openTicks < price - tolerance;
    const approach = above ? 'above' : below ? 'below' : 'unknown';
    const event: TouchEvent = {
      timeMs: bar.timeMs, endMs: Math.min(horizon, end), approach, retest: pendingRetest,
      outcome: 'neutral', reason: '観測窓内で閾値到達なし（無約定時間を含む）',
    };
    pendingRetest = false;
    if (approach === 'unknown') {
      event.outcome = 'ambiguous';
      event.reason = '帯内始値・前足不足・接近側不整合のため足内の接近方向を確定できない';
    } else {
      const direction = above ? 1 : -1;
      for (let j = i; j < bars.length; j++) {
        const next = bars[j];
        if (next.timeMs >= Math.min(horizon, end)) break;
        if (!covered(bar.timeMs, next.timeMs + MINUTE_MS, coverage)) {
          event.outcome = 'unobserved'; event.reason = '観測窓に未収録区間がある'; break;
        }
        const reaction = direction > 0 ? next.highTicks >= price + move : next.lowTicks <= price - move;
        const breakout = direction > 0 ? next.lowTicks <= price - move : next.highTicks >= price + move;
        if (reaction && breakout) {
          event.outcome = 'ambiguous'; event.reason = '同じ1分足で反応・突破の両閾値に到達し順序不明'; break;
        }
        if (j === i && reaction) {
          // The high/low might have occurred before the first touch. A close
          // beyond the reaction threshold proves a subsequent return; else
          // do not guess from a later bar.
          const confirmedClose = direction * (next.closeTicks - price) >= move;
          event.outcome = confirmedClose ? 'reaction' : 'ambiguous';
          event.reason = confirmedClose ? 'タッチ足の終値が接近側の反応閾値へ到達' :
            'タッチ足の極値がタッチ前か後か不明';
          break;
        }
        if (breakout || reaction) {
          event.outcome = breakout ? 'breakout' : 'reaction';
          event.reason = breakout ? '接近側の反対方向へ閾値到達' : '接近側へ閾値到達';
          break;
        }
      }
      if (event.outcome === 'neutral' &&
          (horizon > end || !covered(bar.timeMs, horizon, coverage))) {
        event.outcome = 'unobserved'; event.reason = '判定時間末端が有効期間・表示期間・収録範囲を超える';
      }
    }
    if (event.outcome === 'breakout') pendingRetest = true;
    events.push(event);
    previous = bar;
  }
  return events;
}

function stats(events: TouchEvent[]): ResearchLine['stats'] {
  return {
    touches: events.length,
    reactions: events.filter(e => e.outcome === 'reaction').length,
    breakouts: events.filter(e => e.outcome === 'breakout').length,
    retests: events.filter(e => e.retest).length,
    ambiguous: events.filter(e => e.outcome === 'ambiguous').length,
    unobserved: events.filter(e => e.outcome === 'unobserved').length,
    neutral: events.filter(e => e.outcome === 'neutral').length,
  };
}

export function buildOverview(input: OverviewSession[], config: OverviewConfig): OverviewModel {
  if (![config.topN, config.minQty, config.bucketTicks, config.rule.reactionTicks,
      config.rule.windowMinutes, config.rule.toleranceTicks].every(Number.isInteger) ||
      config.topN < 0 || config.minQty < 0 || config.bucketTicks < 1 ||
      config.rule.windowMinutes < 1 || config.rule.toleranceTicks < 0 ||
      config.rule.reactionTicks <= config.rule.toleranceTicks)
    throw Error('数量・ティック・時間は整数。反応幅はタッチ許容幅より大きくしてください。');
  const start = ctSessionBounds(config.from).startMs;
  const end = ctSessionBounds(config.to).endMs;
  if (end <= start) throw Error('終了日は開始日以降を指定してください');
  const sessions = [...input].sort((a, b) => a.session.localeCompare(b.session));
  const visible = sessions.filter(s => s.session >= config.from && s.session <= config.to);
  const allBars = sessions.flatMap(s => s.candles).sort((a, b) => a.timeMs - b.timeMs);
  const coverage = sessions.map(s => ({ start: s.availableStartMs, end: s.availableEndMs }));
  const warnings: string[] = [
    '簡易OHLC観察であり、反応回数は統計的優位性・売買シグナルを意味しません。',
    '判定は1分足。連続タッチをまとめ、観測窓の重複を除外。足内順序が不明なら判定不能。',
    '左の合算プロファイルは振り返り用。ラインは由来セッション終了後だけに生成。',
  ];
  if (!visible.length) warnings.push('指定範囲に収録された取引セッションがありません。');
  if (!covered(start, end, coverage))
    warnings.push('表示範囲には部分収録・未収録区間（週末等を含む）が存在します。未収録と無約定は同一視しません。');
  const lookback = config.overlay === 'visible' ? Infinity :
    config.overlay === 'previous' ? 1 : Number(config.overlay);
  const chosen = new Set<number>();
  for (const target of visible) {
    const index = sessions.indexOf(target);
    if (config.overlay === 'visible') chosen.add(index);
    else {
      if (index < lookback) warnings.push(`開始前履歴不足：${target.session}の過去${lookback}セッションは全数そろっていません。`);
      for (let j = Math.max(0, index - lookback); j < index; j++) chosen.add(j);
    }
  }
  // The origin filter must never silently shorten the explicitly chosen life.
  // Older selected lines survive until the user's retention expires.
  const ageLimit = config.retention === 'all' ? Infinity : config.retention;
  const observedEnd = Math.max(0, ...sessions.map(s => s.availableEndMs));
  const lines: ResearchLine[] = [];
  for (const index of chosen) {
    const source = sessions[index];
    // A truncated final session has no end-of-session profile yet.
    if (source.availableEndMs < source.sessionEndMs) continue;
    const next = sessions[index + 1];
    if (!next) continue;
    const lineStart = Math.max(source.sessionEndMs, next.sessionStartMs);
    const expiry = Number.isFinite(ageLimit) ? sessions[index + ageLimit]?.sessionEndMs : undefined;
    const lineEnd = Math.min(end, expiry ?? observedEnd, observedEnd);
    if (lineStart >= lineEnd || lineEnd <= start) continue;
    for (const level of selectLevels(source.ownProfile, config.topN, config.minQty, config.bucketTicks)) {
      const center = level.priceTicks + (level.bucketTicks - 1) / 2;
      const events = observeLine(allBars, center, lineStart, lineEnd, config.rule, coverage)
        .filter(event => event.timeMs >= start);
      lines.push({
        id: `${source.session}:${level.priceTicks}:${level.bucketTicks}`,
        sourceSession: source.session, priceTicks: level.priceTicks,
        bucketTicks: level.bucketTicks, quantity: level.quantity, count: level.count,
        startMs: lineStart, endMs: lineEnd, sourcePartial: source.partial,
        historyShort: source.availableStartMs > source.sessionStartMs,
        events, stats: stats(events),
      });
    }
  }
  let profileSessions: OverviewSession[];
  if (config.summary === 'visible') profileSessions = visible;
  else if (config.summary === 'session')
    profileSessions = sessions.filter(s => s.session === config.summarySession);
  else {
    const anchor = config.summarySession || config.to;
    const preceding = sessions.filter(s => s.session <= anchor);
    profileSessions = preceding.slice(-Number(config.summary));
    if (profileSessions.length < Number(config.summary)) warnings.push('左の合算に必要な開始前セッションが不足しています。');
  }
  const merged = new Map<number, ProfileRow>();
  for (const session of profileSessions) for (const row of session.ownProfile) {
    const current = merged.get(row.priceTicks);
    if (current) { current.quantity += row.quantity; current.count += row.count; }
    else merged.set(row.priceTicks, { ...row });
  }
  const profile = bucketProfile([...merged.values()], config.bucketTicks).sort((a, b) => a.priceTicks - b.priceTicks);
  const daily = sessions.map(s => ({
    date: s.session, partial: s.partial, ...s.summary,
    ratioTraditional: s.summary.quantity > s.summary.nQuantity ?
      s.summary.nQuantity / (s.summary.quantity - s.summary.nQuantity) : null,
    ratioAll: s.summary.quantity > 0 ? s.summary.nQuantity / s.summary.quantity : null,
    topLevels: selectLevels(s.ownProfile, config.topN, config.minQty, config.bucketTicks)
      .map(l => ({ priceTicks: l.priceTicks, quantity: l.quantity })),
    touchesAfter: lines.filter(l => l.sourceSession === s.session).reduce((sum, l) => sum + l.stats.touches, 0),
    selected: s.session >= config.from && s.session <= config.to,
    availableStartMs: s.availableStartMs, availableEndMs: s.availableEndMs,
  }));
  return {
    candles: aggregateCandles(allBars.filter(c => c.timeMs >= start && c.timeMs < end), config.chartMinutes),
    profile, lines, daily, timeStartMs: start, timeEndMs: end, warnings: [...new Set(warnings)],
  };
}
