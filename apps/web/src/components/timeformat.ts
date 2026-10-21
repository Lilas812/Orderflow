export type DisplayTimeZone = "Asia/Tokyo" | "UTC";

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: DisplayTimeZone, withDate: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${withDate}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("ja-JP", withDate
      ? { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      : { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    cache.set(key, f);
  }
  return f;
}

export const tzLabelOf = (tz: DisplayTimeZone): string => (tz === "UTC" ? "UTC" : "JST");

/** Label-only conversion. Divide in BigInt first; only a millisecond value becomes a Number. */
export function fmtTime(ns: string, withDate: boolean, tz: DisplayTimeZone): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  return formatter(tz, withDate).format(new Date(ms)) + (withDate ? ` ${tzLabelOf(tz)}` : "");
}

/** Legacy fixed-JST behaviour, unchanged for old callers. */
export function fmtJst(ns: string, withDate = false): string {
  return fmtTime(ns, withDate, "Asia/Tokyo");
}
