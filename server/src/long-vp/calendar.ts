/** ET wall-clock dates, never a fixed UTC offset. All public timestamps are Unix microseconds. */
export const ZONE = "America/New_York";
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
export function parts(us: number) {
  const p = Object.fromEntries(formatter.formatToParts(new Date(us / 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
export function shiftDate(date: string, days: number) {
  return new Date(Date.parse(date + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}
export function atET(date: string, hour: number, minute = 0): number {
  const target = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(guess * 1000);
    const wall = Date.parse(`${p.date}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00Z`);
    const correction = target - wall;
    if (!correction) return guess * 1000;
    guess += correction;
  }
  throw Error("invalid_et_wall_clock");
}
export function session(date: string) {
  return { date, startUs: atET(shiftDate(date, -1), 18), endUs: atET(date, 17) };
}
export function sessionAt(us: number) {
  const p = parts(us);
  if (p.hour === 17) return null; // CME maintenance, not part of either trading session.
  return session(p.hour >= 18 ? shiftDate(p.date, 1) : p.date);
}
export function batchDate(us: number) {
  const p = parts(us);
  return us >= atET(p.date, 17, 10) ? p.date : shiftDate(p.date, -1);
}
export function nextBatchUs(us: number) {
  const p = parts(us), today = atET(p.date, 17, 10);
  return today > us ? today : atET(shiftDate(p.date, 1), 17, 10);
}
