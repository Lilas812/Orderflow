/**
 * Long-term VP settings schema. Shared by the browser and the server
 * (the server imports this file directly), so it must stay dependency free.
 */
export interface SettingsValues {
  showPrice: boolean;
  priceStyle: "line" | "candles";
  showVp: boolean;
  vpPeriod: "day" | "week";
  rthOnly: boolean;
  vpNormalization: "period" | "global";
  vpWidthPct: number;
  vpTickGroup: number;
  showVah: boolean;
  showPoc: boolean;
  showVal: boolean;
  showValueArea: boolean;
  showPocExtension: boolean;
  showWeeklyVwap: boolean;
  showWeeklyCvd: boolean;
}
export type SettingsKey = keyof SettingsValues;
export interface SettingsDocument { version: 1; values: SettingsValues; updatedAt: number | null; }

export const defaults: Readonly<SettingsValues> = Object.freeze({
  showPrice: true, priceStyle: "line", showVp: true, vpPeriod: "day", rthOnly: false,
  vpNormalization: "period", vpWidthPct: 40, vpTickGroup: 1,
  showVah: true, showPoc: true, showVal: true, showValueArea: true, showPocExtension: true,
  showWeeklyVwap: true, showWeeklyCvd: true,
});
export const SETTINGS_KEYS = Object.keys(defaults) as SettingsKey[];

const BOOLEAN_KEYS = ["showPrice", "showVp", "rthOnly", "showVah", "showPoc", "showVal", "showValueArea",
  "showPocExtension", "showWeeklyVwap", "showWeeklyCvd"] as const;
const CHOICES = { priceStyle: ["line", "candles"], vpPeriod: ["day", "week"], vpNormalization: ["period", "global"] } as const;
export const INTEGER_RANGES = { vpWidthPct: [10, 80], vpTickGroup: [1, 40] } as const;

/** Returns field -> message. Empty object means valid. All fields are required. */
export function validateSettings(values: unknown): Record<string, string> {
  const errors: Record<string, string> = Object.create(null);
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    errors.values = `${SETTINGS_KEYS.length}項目のオブジェクトが必要です`;
    return errors;
  }
  const v = values as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!SETTINGS_KEYS.includes(key as SettingsKey)) errors[key] = "余分な項目です";
  for (const key of BOOLEAN_KEYS) if (typeof v[key] !== "boolean") errors[key] = "オンかオフを選んでください";
  for (const [key, choices] of Object.entries(CHOICES)) {
    if (!(choices as readonly unknown[]).includes(v[key])) errors[key] = "選択肢から選んでください";
  }
  for (const [key, [min, max]] of Object.entries(INTEGER_RANGES)) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isFinite(n)) errors[key] = "数字を入力してください";
    else if (!Number.isInteger(n)) errors[key] = "整数で入力してください";
    else if (n < min || n > max) errors[key] = `${min}〜${max}の範囲で入力してください`;
  }
  return errors;
}

export function defaultDocument(): SettingsDocument {
  return { version: 1, values: { ...defaults }, updatedAt: null };
}

/** Parses a stored or received document; returns null on any deviation. */
export function readDocument(value: unknown): SettingsDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (d.version !== 1) return null;
  if (Object.keys(validateSettings(d.values)).length > 0) return null;
  const updatedAt = d.updatedAt;
  if (updatedAt !== null && !(typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) && updatedAt >= 0)) return null;
  const values = Object.fromEntries(SETTINGS_KEYS.map(k => [k, (d.values as Record<string, unknown>)[k]])) as unknown as SettingsValues;
  return { version: 1, values, updatedAt: updatedAt as number | null };
}
