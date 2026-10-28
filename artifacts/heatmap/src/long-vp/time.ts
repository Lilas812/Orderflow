/** Exchange calendar helpers. All boundaries are computed in America/New_York so DST is exact. */
const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export interface EtParts { date: string; hour: number; minute: number; }

function rawParts(ms: number) {
  const o: Record<string, string> = {};
  for (const p of ET.formatToParts(ms)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
export function etParts(sec: number): EtParts {
  const p = rawParts(Math.floor(sec) * 1000);
  return { date: `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`, hour: p.h, minute: p.mi };
}
function offsetMs(ms: number) {
  const p = rawParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** Unix seconds of the given ET wall clock time. */
export function atEt(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const first = wall - offsetMs(wall);
  return (wall - offsetMs(first)) / 1000;
}
export function shiftDate(date: string, days: number): string {
  const t = new Date(date + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
export const weekday = (date: string) => new Date(date + "T12:00:00Z").getUTCDay();
export const isTradingDate = (date: string) => weekday(date) !== 0 && weekday(date) !== 6;

/** Trading date (ending CT date) containing sec; ET 18:00 starts the next date. Null on weekend. */
export function tradingDateAt(sec: number): string | null {
  const p = etParts(sec);
  const date = p.hour >= 18 ? shiftDate(p.date, 1) : p.date;
  return isTradingDate(date) ? date : null;
}
/** Latest trading date whose session has started at or before sec. */
export function latestTradingDate(sec: number): string {
  const p = etParts(sec);
  let date = p.hour >= 18 ? shiftDate(p.date, 1) : p.date;
  while (!isTradingDate(date)) date = shiftDate(date, -1);
  return date;
}
/** First trading date at or after sec. */
export function nextTradingDate(sec: number): string {
  const p = etParts(sec);
  let date = p.hour >= 18 ? shiftDate(p.date, 1) : p.date;
  while (!isTradingDate(date)) date = shiftDate(date, 1);
  return date;
}
export const dayStartSec = (date: string) => atEt(shiftDate(date, -1), 18);
export const dayEndSec = (date: string) => atEt(date, 18);
/** Sunday date of the week holding this trading date. */
export const weekKey = (date: string) => shiftDate(date, -weekday(date));
export const weekStartSec = (date: string) => atEt(weekKey(date), 18);
/** Week ends Friday ET 17:00 (CT 16:00). */
export const weekEndSec = (date: string) => atEt(shiftDate(weekKey(date), 5), 17);
export function isRthSec(sec: number): boolean {
  const p = etParts(sec);
  if (!isTradingDate(p.date)) return false;
  return sec >= atEt(p.date, 9, 30) && sec < atEt(p.date, 16);
}
export function tradingDatesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) if (isTradingDate(d)) out.push(d);
  return out;
}
export function shiftTradingDays(date: string, n: number): string {
  let d = date, left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) { d = shiftDate(d, step); if (isTradingDate(d)) left--; }
  return d;
}
