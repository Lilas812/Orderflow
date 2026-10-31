// Pure types & helpers for the GCZ6 N research chart. No side effects.

export interface SessionIndexItem {
  date: string;
  previousDate: string | null;
  partial: boolean;
  previousPartial: boolean;
  file: string;
  tradeCount: number;
  quantity: number;
  nCount: number;
  nQuantity: number;
}

export interface ResearchIndex {
  instrument: string;
  tickSize: number;
  timezone: string;
  source: string;
  sessions: SessionIndexItem[];
  sourceSha256: string;
}

export interface ProfileRow {
  priceTicks: number;
  quantity: number;
  count: number;
}

export interface Candle {
  timeMs: number;
  openTicks: number;
  highTicks: number;
  lowTicks: number;
  closeTicks: number;
  quantity: number;
  count: number;
}

export interface SessionData {
  session: string;
  previousSession: string | null;
  partial: boolean;
  previousPartial: boolean;
  sessionStartMs: number;
  sessionEndMs: number;
  profile: ProfileRow[];
  candles: Candle[];
  summary: {
    tradeCount: number;
    quantity: number;
    nCount: number;
    nQuantity: number;
    previousNCount: number;
    previousNQuantity: number;
  };
}

export interface Level {
  rank: number;
  /** lowest tick of the bucket */
  priceTicks: number;
  bucketTicks: number;
  quantity: number;
  count: number;
}

export const MINUTE_MS = 60_000;

export function formatPrice(ticks: number, tickSize = 0.1): string {
  return (ticks * tickSize).toFixed(1);
}

export function formatQty(n: number): string {
  return n.toLocaleString('en-US');
}

/** Aggregate previous-session profile rows into price buckets (bucket=1 → raw ticks). */
export function bucketProfile(profile: ProfileRow[], bucketTicks: number): ProfileRow[] {
  const b = Math.max(1, Math.floor(bucketTicks));
  if (b === 1) return profile;
  const map = new Map<number, ProfileRow>();
  for (const r of profile) {
    const key = Math.floor(r.priceTicks / b) * b;
    const cur = map.get(key);
    if (cur) {
      cur.quantity += r.quantity;
      cur.count += r.count;
    } else map.set(key, { priceTicks: key, quantity: r.quantity, count: r.count });
  }
  return [...map.values()].sort((a, c) => a.priceTicks - c.priceTicks);
}

/**
 * Select top-N concentration levels SOLELY from the previous-session profile.
 * Quantity ties go to the higher price, matching the existing research.
 */
export function selectLevels(
  profile: ProfileRow[],
  topN: number,
  minQty: number,
  bucketTicks: number,
): Level[] {
  const b = Math.max(1, Math.floor(bucketTicks));
  return bucketProfile(profile, b)
    .filter((r) => r.quantity >= minQty)
    .sort((a, c) => c.quantity - a.quantity || c.priceTicks - a.priceTicks)
    .slice(0, Math.max(0, Math.floor(topN)))
    .map((r, i) => ({ rank: i + 1, priceTicks: r.priceTicks, bucketTicks: b, quantity: r.quantity, count: r.count }));
}

/** Center price (ticks, possibly fractional) of a bucketed level. */
export function levelCenter(l: Level): number {
  return l.priceTicks + (l.bucketTicks - 1) / 2;
}

export type Tz = 'CT' | 'JST';
export const TZ_NAME: Record<Tz, string> = { CT: 'America/Chicago', JST: 'Asia/Tokyo' };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: Tz, kind: 'hm' | 'full'): Intl.DateTimeFormat {
  const k = tz + kind;
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ_NAME[tz],
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      ...(kind === 'full' ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
    });
    fmtCache.set(k, f);
  }
  return f;
}

export function formatTime(ms: number, tz: Tz): string {
  return fmt(tz, 'hm').format(ms).replace(/^24/, '00');
}

export function formatDateTime(ms: number, tz: Tz): string {
  const parts = fmt(tz, 'full').formatToParts(ms);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hh = g('hour') === '24' ? '00' : g('hour');
  return `${g('year')}-${g('month')}-${g('day')} ${hh}:${g('minute')} ${tz}`;
}

/** Binary search a candle whose minute contains ms. Missing minute → null (gap). */
export function candleAt(candles: Candle[], ms: number): Candle | null {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = candles[mid];
    if (ms < c.timeMs) hi = mid - 1;
    else if (ms >= c.timeMs + MINUTE_MS) lo = mid + 1;
    else return c;
  }
  return null;
}

/** Nice grid step in ticks so that labels are ≥ minPx apart. */
export function niceTickStep(pxPerTick: number, minPx = 28): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  for (const s of steps) if (s * pxPerTick >= minPx) return s;
  return steps[steps.length - 1];
}

export function niceTimeStepMin(pxPerMin: number, minPx = 72): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360];
  for (const s of steps) if (s * pxPerMin >= minPx) return s;
  return 720;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
