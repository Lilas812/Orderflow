import type { RangeBar, TradeRef } from './range-types';
export function clampView(start: number, end: number, length: number): [number, number] {
  const span = Math.min(length, Math.max(Math.min(3, length), end - start));
  const a = Math.max(0, Math.min(Math.max(0, length - span), start));
  return [a, a + span];
}
export function refPosition(bars: RangeBar[], ref: TradeRef) {
  const beforeEnd = (b: RangeBar) => b.endUs < ref.tsUs || (b.endUs === ref.tsUs
    && (b.endSeq < ref.seq || (b.endSeq === ref.seq && b.endLine < ref.line)));
  let l = 0, r = bars.length;
  while (l < r) {
    const m = (l + r) >>> 1;
    if (beforeEnd(bars[m])) l = m + 1; else r = m;
  }
  for (let i = l; i < bars.length && bars[i].startUs <= ref.tsUs; i++) {
    const b = bars[i];
    if (b.endUs >= ref.tsUs) {
      // Trade time stays intact even where it is no longer an extreme.
      return i + (b.endUs === b.startUs ? 0.5 : Math.max(0, Math.min(1, (ref.tsUs - b.startUs) / (b.endUs - b.startUs))));
    }
  }
  return l + 0.5;
}
export function formatUs(us: number, tz: 'CT' | 'JST') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz === 'CT' ? 'America/Chicago' : 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .format(new Date(Math.floor(us / 1000))) + `.${String(us % 1_000_000).padStart(6, '0')} ${tz}`;
}
export function elapsedUs(us: number) {
  const n = Math.abs(us);
  const hours = Math.floor(n / 3_600_000_000), minutes = Math.floor(n / 60_000_000) % 60;
  return `${hours}時間 ${minutes}分 ${((n % 60_000_000) / 1_000_000).toFixed(6)}秒`;
}
