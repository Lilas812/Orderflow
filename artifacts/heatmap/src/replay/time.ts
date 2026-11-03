import type { DisplayZone } from "../chart/timezone.ts";
export function localDateTime(sec: number, zone: DisplayZone): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone === "ct" ? "America/Chicago" : "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(sec * 1000));
  const p = (t: string) => parts.find(x => x.type === t)!.value;
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}`;
}
/** Round trip candidates: nonexistent local times have none, fall-back folds have two. */
export function localCandidates(text: string, zone: DisplayZone): { sec: number; offset: string }[] {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(text)) return [];
  const normalized = text.length === 16 ? text + ":00" : text;
  const utc = Date.parse(normalized + "Z") / 1000;
  if (!Number.isFinite(utc)) return [];
  const candidates = new Map<number, string>();
  for (const delta of [-86400, 0, 86400]) {
    const reference = utc + delta, local = localDateTime(reference, zone);
    const offsetSec = Date.parse(local + "Z") / 1000 - reference;
    const sec = utc - offsetSec;
    if (localDateTime(sec, zone) === normalized) {
      const min = Math.abs(offsetSec / 60);
      candidates.set(sec, `UTC${offsetSec >= 0 ? "+" : "-"}${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`);
    }
  }
  return [...candidates].sort(([a], [b]) => a - b).map(([sec, offset]) => ({ sec, offset }));
}
export function replayPreferences(storage?: Pick<Storage, "getItem">) {
  try {
    const s = storage ?? window.sessionStorage, speed = Number(s.getItem("replay.speed")), step = Number(s.getItem("replay.step"));
    return { speed: [1, 2, 5, 10, 30, 60].includes(speed) ? speed : 1, step: [1, 10, 60].includes(step) ? step : 1 };
  } catch { return { speed: 1, step: 1 }; }
}
