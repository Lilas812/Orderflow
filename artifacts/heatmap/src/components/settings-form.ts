import { DEFAULT_SETTINGS, validateSettings } from "../data/settings.ts";
import type { SettingsKey, SettingsValues } from "../data/settings.ts";

export type FormInputs = Record<SettingsKey, string>;
export interface FieldSpec { key: SettingsKey; group: string; label: string; kind: "number" | "integer" | "zone"; min?: number; max?: number; step?: number; }

export const FIELD_SPECS: readonly FieldSpec[] = [
  { key: "heatTopPct", group: "ヒートマップ", label: "色の基準（上位 %）", kind: "number", min: .1, max: 10, step: .1 },
  { key: "bubbleMin", group: "約定バブル", label: "閾値（枚）", kind: "integer", min: 1, max: 1000, step: 1 },
  { key: "bubbleScale", group: "約定バブル", label: "大きさ（倍率）", kind: "number", min: .5, max: 3, step: .1 },
  { key: "bookBarPct", group: "現在の板", label: "棒の最大の長さ（ヒートマップの幅の %）", kind: "integer", min: 5, max: 20, step: 1 },
  { key: "bookBarOpacity", group: "現在の板", label: "棒の不透明度", kind: "number", min: .1, max: 1, step: .05 },
  { key: "bigTopPct", group: "大口板", label: "閾値（上位 %）", kind: "number", min: .1, max: 20, step: .1 },
  { key: "bigMinSec", group: "大口板", label: "継続時間（秒）", kind: "integer", min: 1, max: 600, step: 1 },
  { key: "timeZone", group: "時間軸", label: "時刻の表示", kind: "zone" },
];
export const ZONE_LABELS: Record<SettingsValues["timeZone"], string> = { "Asia/Tokyo": "日本時間", "America/Chicago": "米国中部時間" };

export function rangeText(spec: FieldSpec): string {
  const def = DEFAULT_SETTINGS[spec.key];
  if (spec.kind === "zone") return `初期値 ${ZONE_LABELS[def as SettingsValues["timeZone"]]}`;
  return `${spec.min}〜${spec.max}${spec.kind === "integer" ? "（整数）" : `（${spec.step}刻み）`}・初期値 ${def}`;
}

export const toInputs = (v: SettingsValues): FormInputs =>
  Object.fromEntries(FIELD_SPECS.map(s => [s.key, String(v[s.key])])) as FormInputs;

/** 文字列入力を値へ。空や数字でない欄は NaN にして検査させる。 */
export function parseInputs(inputs: FormInputs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of FIELD_SPECS) {
    const raw = inputs[s.key].trim();
    out[s.key] = s.kind === "zone" ? raw : (raw === "" || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw) ? NaN : Number(raw));
  }
  return out;
}

export type FormStatus = "loading" | "ready" | "load-error" | "saving";

/** DOM から独立した設定フォームの状態。保存・反映は外部コールバックだけが行う。 */
export class SettingsForm {
  status: FormStatus = "loading";
  inputs: FormInputs = toInputs(DEFAULT_SETTINGS as SettingsValues);
  message = "";
  loaded = false;
  begin() {
    this.status = "loading"; this.message = ""; this.loaded = false;
    this.inputs = toInputs(DEFAULT_SETTINGS as SettingsValues);
  }
  loadOk(v: SettingsValues) { this.inputs = toInputs(v); this.status = "ready"; this.loaded = true; this.message = ""; }
  loadFail(reason: string) { this.status = "load-error"; this.loaded = false; this.message = `設定を読み込めませんでした：${reason}`; }
  set(key: SettingsKey, value: string) { this.inputs = { ...this.inputs, [key]: value }; }
  resetDefaults() { if (this.loaded) this.inputs = toInputs(DEFAULT_SETTINGS as SettingsValues); }
  errors(): Partial<Record<SettingsKey, string>> {
    return validateSettings(parseInputs(this.inputs)) as Partial<Record<SettingsKey, string>>;
  }
  canSave() { return this.status === "ready" && this.loaded && Object.keys(this.errors()).length === 0; }
  /** 保存開始。送る値を返す（不可なら null）。 */
  startSave(): SettingsValues | null {
    if (!this.canSave()) return null;
    this.status = "saving"; this.message = "";
    return parseInputs(this.inputs) as unknown as SettingsValues;
  }
  saveFail(reason: string) { this.status = "ready"; this.message = `保存できませんでした：${reason}`; }
}
