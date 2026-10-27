import { parseBubbleMin } from "../chart/trade-geometry.ts";
import { parseBigOrderOptions } from "./big-orders.ts";

export interface SettingsValues {
  heatTopPct: number; bubbleMin: number; bigTopPct: number; bigMinSec: number;
  timeZone: "Asia/Tokyo" | "America/Chicago";
}
export type SettingsKey = keyof SettingsValues;
export type SettingsSource = "保存" | "初期値" | "URL";
export interface SettingsDocument { version: 1; values: SettingsValues; updatedAt: number | null; }
export const DEFAULT_SETTINGS: Readonly<SettingsValues> = Object.freeze({
  heatTopPct: 1, bubbleMin: 10, bigTopPct: 2, bigMinSec: 5, timeZone: "Asia/Tokyo",
});
export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

export function validateSettings(values: unknown): Record<string, string> {
  const errors: Record<string, string> = Object.create(null);
  if (!values || typeof values !== "object" || Array.isArray(values)) return { values: "5項目のオブジェクトが必要です" };
  const v = values as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!SETTINGS_KEYS.includes(key as SettingsKey)) errors[key] = "余分な項目です";
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

export function defaultDocument(): SettingsDocument {
  return { version: 1, values: { ...DEFAULT_SETTINGS }, updatedAt: null };
}
export function validDocument(v: unknown): v is SettingsDocument {
  const d = v as SettingsDocument | null;
  return !!d && d.version === 1 && Object.keys(validateSettings(d.values)).length === 0
    && (d.updatedAt === null || (Number.isSafeInteger(d.updatedAt) && d.updatedAt >= 0));
}

export function resolveSettings(doc: SettingsDocument, search: string) {
  const values = { ...doc.values };
  const sources = Object.fromEntries(SETTINGS_KEYS.map(k => [k, doc.updatedAt === null ? "初期値" : "保存"])) as Record<SettingsKey, SettingsSource>;
  const params = new URLSearchParams(search), big = parseBigOrderOptions(search), bubble = parseBubbleMin(search);
  const invalid: string[] = [];
  const overridden: Partial<Record<SettingsKey, boolean>> = {};
  for (const [param, key, option] of [
    ["bubbleMin", "bubbleMin", bubble], ["bigTop", "bigTopPct", big.top], ["bigMinSec", "bigMinSec", big.minSec],
  ] as const) if (params.has(param)) {
    values[key] = option.value;
    sources[key] = option.invalid ? "初期値" : "URL";
    overridden[key] = true;
    if (option.invalid) invalid.push(`${param} 無効`);
  }
  return { values, sources, invalid, overridden };
}
export function settingsChanges(a: SettingsValues, b: SettingsValues) {
  return { heat: a.heatTopPct !== b.heatTopPct, bubbles: a.bubbleMin !== b.bubbleMin,
    big: a.bigTopPct !== b.bigTopPct || a.bigMinSec !== b.bigMinSec, time: a.timeZone !== b.timeZone };
}

async function requestSettings(values?: SettingsValues): Promise<SettingsDocument> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const url = `${import.meta.env.BASE_URL}api/settings`;
    const res = await fetch(url, { method: values ? "PUT" : "GET", cache: "no-store", signal: controller.signal,
      ...(values ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) } : {}) });
    const result = await res.json();
    if (!res.ok) throw Error(Object.values(result.fields ?? {}).join(" / ") || "設定を保存できませんでした");
    if (!validDocument(result)) throw Error("設定の応答が不正です");
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw Error("設定の通信が10秒でタイムアウトしました");
    throw error;
  } finally { clearTimeout(timer); }
}
export const fetchSettings = () => requestSettings();
export const putSettings = (values: SettingsValues) => requestSettings(values);
