/** An acknowledgement applies only to the exact revision the user was warned about. */
export function mustConfirmRevision(base: number | undefined, consent: number | undefined, current: number) {
  return current !== base && current !== consent;
}
/** Inclusive UTC-day range "YYYY-MM-DD" -> [fromSec, toSec) integer seconds; null when invalid. */
export function utcDayRange(from: string, to: string) {
  const p = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(s + "T00:00:00Z") / 1000 : NaN;
  const a = p(from), b = p(to);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a) return null;
  return { fromSec: a, toSec: b + 86400 };
}

/** Initial expected direction for a failed mark: rising approach -> intended top (down). */
export const initialFailedDirection = (a: "up" | "down" | null) => a === "up" ? "down" : a === "down" ? "up" : null;

