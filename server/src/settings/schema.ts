export interface SettingsValues {
  heatTopPct: number; bubbleMin: number; bigTopPct: number; bigMinSec: number;
  timeZone: "Asia/Tokyo" | "America/Chicago";
}
export interface SettingsDocument { version: 1; values: SettingsValues; updatedAt: number | null; }
export const defaults: Readonly<SettingsValues> = Object.freeze({
  heatTopPct: 1, bubbleMin: 10, bigTopPct: 2, bigMinSec: 5, timeZone: "Asia/Tokyo",
});
export function validateSettings(values: unknown): Record<string, string> {
  const errors: Record<string, string> = Object.create(null);
  if (!values || typeof values !== "object" || Array.isArray(values)) return { values: "5項目のオブジェクトが必要です" };
  const v = values as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!(key in defaults) || !Object.hasOwn(defaults, key)) errors[key] = "余分な項目です";
  for (const [key, min, max, tenth] of [
    ["heatTopPct", .1, 10, true], ["bubbleMin", 1, 1000, false],
    ["bigTopPct", .1, 20, true], ["bigMinSec", 1, 600, false],
  ] as const) {
    const n = v[key], factor = tenth ? 10 : 1;
    if (typeof n !== "number" || !Number.isFinite(n)) errors[key] = "数字を入力してください";
    else if (n < min || n > max) errors[key] = `${min}〜${max}の範囲で入力してください`;
    else if (Math.abs(n * factor - Math.round(n * factor)) > Number.EPSILON * 256)
      errors[key] = tenth ? "0.1刻みで入力してください" : "整数で入力してください";
  }
  if (v.timeZone !== "Asia/Tokyo" && v.timeZone !== "America/Chicago") errors.timeZone = "時刻の表示を選んでください";
  return errors;
}
export function validDocument(v: unknown): v is SettingsDocument {
  const d = v as SettingsDocument | null;
  return !!d && typeof d === "object" && !Array.isArray(d) && d.version === 1
    && Object.keys(d).length === 3 && Object.keys(validateSettings(d.values)).length === 0
    && (d.updatedAt === null || (Number.isSafeInteger(d.updatedAt) && d.updatedAt >= 0));
}
export function validateBody(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { _body: "valuesを含むオブジェクトが必要です" };
  const b = body as Record<string, unknown>;
  return { ...Object.fromEntries(Object.keys(b).filter(k => k !== "values").map(k => [k, "余分な項目です"])),
    ...validateSettings(b.values) };
}
