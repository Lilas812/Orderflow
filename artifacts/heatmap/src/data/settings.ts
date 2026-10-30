import { requestSettingsDocument } from "./settings-request.ts";
import { parseBubbleMin } from "../chart/trade-geometry.ts";
import { parseBigOrderOptions } from "./big-orders.ts";

export interface SettingsValues {
  heatUpperMode: "auto" | "size"; heatUpperSize: number;
  heatLowerMode: "off" | "pct" | "size"; heatLowerPct: number; heatLowerSize: number; heatGamma: number;
  heatTopPct: number; bubbleMin: number; bigTopPct: number; bigMinSec: number;
  timeZone: "Asia/Tokyo" | "America/Chicago";
  bubbleScale: number; bookBarPct: number; bookBarOpacity: number;
  heatStyle: "glow" | "block"; bigOrdersVisible: boolean;
}
export type SettingsKey = keyof SettingsValues;
export type SettingsSource = "保存" | "初期値" | "URL";
export interface SettingsDocument { version: 4; values: SettingsValues; updatedAt: number | null; }
export const DEFAULT_SETTINGS: Readonly<SettingsValues> = Object.freeze({
  heatUpperMode: "auto", heatUpperSize: 100, heatLowerMode: "pct", heatLowerPct: 80, heatLowerSize: 5, heatGamma: .5,
  heatTopPct: 5, bubbleMin: 10, bigTopPct: 2, bigMinSec: 5, timeZone: "Asia/Tokyo",
  bubbleScale: 1, bookBarPct: 10, bookBarOpacity: .5,
  heatStyle: "glow", bigOrdersVisible: false,
});
/** Settings version written by this frontend (SPEC 9: Phase 14 = 4). Older files are migrated by the server. */
export const SETTINGS_VERSION = 4;
export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

export function validateSettings(values: unknown): Record<string, string> {
  const errors: Record<string, string> = Object.create(null);
  if (!values || typeof values !== "object" || Array.isArray(values)) return { values: "16項目のオブジェクトが必要です" };
  const v = values as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!SETTINGS_KEYS.includes(key as SettingsKey)) errors[key] = "余分な項目です";
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
  if (typeof v.bigOrdersVisible !== "boolean") errors.bigOrdersVisible = "表示するかを選んでください";
  return errors;
}

export function defaultDocument(): SettingsDocument {
  return { version: SETTINGS_VERSION, values: { ...DEFAULT_SETTINGS }, updatedAt: null };
}
export function validDocument(v: unknown): v is SettingsDocument {
  const d = v as SettingsDocument | null;
  return !!d && d.version === SETTINGS_VERSION && Object.keys(validateSettings(d.values)).length === 0
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
  return { heat: (["heatTopPct", "heatUpperMode", "heatUpperSize", "heatLowerMode", "heatLowerPct", "heatLowerSize", "heatGamma"] as const)
      .some(k => a[k] !== b[k]), bubbles: a.bubbleMin !== b.bubbleMin || a.bubbleScale !== b.bubbleScale,
    // Phase 14: bars are gone, so bookBarPct / bookBarOpacity no longer redraw anything.
    style: a.heatStyle !== b.heatStyle, layout: a.bigOrdersVisible !== b.bigOrdersVisible,
    big: a.bigTopPct !== b.bigTopPct || a.bigMinSec !== b.bigMinSec, time: a.timeZone !== b.timeZone };
}

async function requestSettings(values?: SettingsValues): Promise<SettingsDocument> {
  return requestSettingsDocument(`${import.meta.env.BASE_URL}api/settings`, values, raw => validDocument(raw) ? raw : null);
}
export const fetchSettings = () => requestSettings();
export const putSettings = (values: SettingsValues) => requestSettings(values);
