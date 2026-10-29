export interface SettingsValues {
  heatUpperMode: "auto" | "size"; heatUpperSize: number;
  heatLowerMode: "off" | "pct" | "size"; heatLowerPct: number; heatLowerSize: number; heatGamma: number;
  heatTopPct: number; bubbleMin: number; bigTopPct: number; bigMinSec: number;
  timeZone: "Asia/Tokyo" | "America/Chicago";
  bubbleScale: number; bookBarPct: number; bookBarOpacity: number;
  heatStyle: "glow" | "block"; bigOrdersVisible: boolean;
}
export interface SettingsDocument { version: 4; values: SettingsValues; updatedAt: number | null; }
export const defaults: Readonly<SettingsValues> = Object.freeze({
  heatUpperMode: "auto", heatUpperSize: 100, heatLowerMode: "pct", heatLowerPct: 80, heatLowerSize: 5, heatGamma: .5,
  heatTopPct: 5, bubbleMin: 10, bigTopPct: 2, bigMinSec: 5, timeZone: "Asia/Tokyo",
  bubbleScale: 1, bookBarPct: 10, bookBarOpacity: .5,
  heatStyle: "glow", bigOrdersVisible: false,
});
export function validateSettings(values: unknown): Record<string, string> {
  const errors: Record<string, string> = Object.create(null);
  if (!values || typeof values !== "object" || Array.isArray(values)) return { values: "16項目のオブジェクトが必要です" };
  const v = values as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!(key in defaults) || !Object.hasOwn(defaults, key)) errors[key] = "余分な項目です";
  for (const [key, min, max, factor] of [
    ["heatUpperSize", 1, 100000, 1], ["heatLowerPct", .1, 90, 10],
    ["heatLowerSize", 0, 100000, 1], ["heatGamma", .3, 3, 10],
    ["heatTopPct", .1, 10, 10], ["bubbleMin", 1, 1000, 1],
    ["bigTopPct", .1, 20, 10], ["bigMinSec", 1, 600, 1],
    ["bubbleScale", .5, 3, 10], ["bookBarPct", 5, 20, 1],
    ["bookBarOpacity", .1, 1, 20],
  ] as const) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isFinite(n)) errors[key] = "数字を入力してください";
    else if (n < min || n > max) errors[key] = `${min}〜${max}の範囲で入力してください`;
    else if (Math.abs(n * factor - Math.round(n * factor)) > Number.EPSILON * 256)
      errors[key] = factor === 1 ? "整数で入力してください" : `${1 / factor}刻みで入力してください`;
  }
  if (v.timeZone !== "Asia/Tokyo" && v.timeZone !== "America/Chicago") errors.timeZone = "時刻の表示を選んでください";
  if (v.heatUpperMode !== "auto" && v.heatUpperMode !== "size") errors.heatUpperMode = "上限の決め方を選んでください";
  if (!["off", "pct", "size"].includes(v.heatLowerMode as string)) errors.heatLowerMode = "下限の決め方を選んでください";
  if (v.heatStyle !== "glow" && v.heatStyle !== "block") errors.heatStyle = "描き方を選んでください";
  if (typeof v.bigOrdersVisible !== "boolean") errors.bigOrdersVisible = "表示の有無を選んでください";
  return errors;
}
export function validDocument(v: unknown): v is SettingsDocument {
  const d = v as SettingsDocument | null;
  return !!d && typeof d === "object" && !Array.isArray(d) && d.version === 4
    && Object.keys(d).length === 3 && Object.keys(validateSettings(d.values)).length === 0
    && (d.updatedAt === null || (Number.isSafeInteger(d.updatedAt) && d.updatedAt >= 0));
}
/** Normalize only exact legacy schemas; GET never rewrites or archives them. */
export function readDocument(value: unknown): SettingsDocument | null {
  if (validDocument(value)) return value;
  const d = value as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || Array.isArray(d) || ![1, 2, 3].includes(d.version as number)
    || Object.keys(d).length !== 3 || !d.values || typeof d.values !== "object" || Array.isArray(d.values)) return null;
  const v = d.values as Record<string, unknown>;
  const legacy = ["heatTopPct", "bubbleMin", "bigTopPct", "bigMinSec", "timeZone",
    ...(d.version !== 1 ? ["bubbleScale", "bookBarPct", "bookBarOpacity"] : []),
    ...(d.version === 3 ? ["heatUpperMode", "heatUpperSize", "heatLowerMode", "heatLowerPct", "heatLowerSize", "heatGamma"] : [])];
  if (Object.keys(v).length !== legacy.length || !legacy.every(k => Object.hasOwn(v, k))) return null;
  const values = { ...defaults, heatTopPct: 1, heatLowerMode: "off", heatLowerPct: 20, heatGamma: 1, ...v };
  if (values.heatTopPct === 1 && values.heatLowerMode === "off" && values.heatLowerPct === 20 && values.heatGamma === 1) {
    values.heatTopPct = defaults.heatTopPct; values.heatLowerMode = defaults.heatLowerMode;
    values.heatLowerPct = defaults.heatLowerPct; values.heatGamma = defaults.heatGamma;
  }
  const normalized = { version: 4, values, updatedAt: d.updatedAt };
  return validDocument(normalized) ? normalized : null;
}
export function validateBody(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { _body: "valuesを含むオブジェクトが必要です" };
  const b = body as Record<string, unknown>;
  return { ...Object.fromEntries(Object.keys(b).filter(k => k !== "values").map(k => [k, "余分な項目です"])),
    ...validateSettings(b.values) };
}
