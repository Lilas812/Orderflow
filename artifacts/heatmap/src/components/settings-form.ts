import { DEFAULT_SETTINGS, validateSettings } from "../data/settings.ts";
import type { SettingsKey, SettingsValues } from "../data/settings.ts";

/** Saved for compatibility only and never shown (SPEC 7.2 / 9, Phase 14). */
export const HIDDEN_KEYS = ["bookBarPct", "bookBarOpacity"] as const;
export type HiddenKey = typeof HIDDEN_KEYS[number];
export type VisibleKey = Exclude<SettingsKey, HiddenKey>;
export type FormInputs = Record<VisibleKey, string>;
export interface FieldSpec { key: VisibleKey; group: string; label: string; kind: "number" | "integer" | "zone" | "choice" | "toggle"; min?: number; max?: number; step?: number; choices?: Record<string, string>; }

export const FIELD_SPECS: readonly FieldSpec[] = [
  { key: "heatUpperMode", group: "ヒートマップ", label: "上限の決め方", kind: "choice", choices: { auto: "自動（上位 %）", size: "枚数" } },
  { key: "heatTopPct", group: "ヒートマップ", label: "上限：上位 %", kind: "number", min: .1, max: 10, step: .1 },
  { key: "heatUpperSize", group: "ヒートマップ", label: "上限：枚数", kind: "integer", min: 1, max: 100000, step: 1 },
  { key: "heatLowerMode", group: "ヒートマップ", label: "下限の決め方", kind: "choice", choices: { off: "なし", pct: "下位 %", size: "枚数" } },
  { key: "heatLowerPct", group: "ヒートマップ", label: "下限：下位 %", kind: "number", min: .1, max: 90, step: .1 },
  { key: "heatLowerSize", group: "ヒートマップ", label: "下限：枚数", kind: "integer", min: 0, max: 100000, step: 1 },
  { key: "heatGamma", group: "ヒートマップ", label: "コントラスト（1 = 直線）", kind: "number", min: .3, max: 3, step: .1 },
  { key: "heatStyle", group: "ヒートマップ", label: "描き方", kind: "choice", choices: { glow: "線＋グロー", block: "四角いマス" } },
  { key: "bubbleMin", group: "約定バブル", label: "閾値（枚）", kind: "integer", min: 1, max: 1000, step: 1 },
  { key: "bubbleScale", group: "約定バブル", label: "大きさ（倍率）", kind: "number", min: .5, max: 3, step: .1 },
  { key: "bigOrdersVisible", group: "大口板", label: "表示する", kind: "toggle", choices: { true: "出す", false: "出さない" } },
  { key: "bigTopPct", group: "大口板", label: "閾値（上位 %）", kind: "number", min: .1, max: 20, step: .1 },
  { key: "bigMinSec", group: "大口板", label: "継続時間（秒）", kind: "integer", min: 1, max: 600, step: 1 },
  { key: "timeZone", group: "時間軸", label: "時刻の表示", kind: "zone" },
];
export const ZONE_LABELS: Record<SettingsValues["timeZone"], string> = { "Asia/Tokyo": "日本時間", "America/Chicago": "米国中部時間" };

export function rangeText(spec: FieldSpec): string {
  const def = DEFAULT_SETTINGS[spec.key];
  if (spec.kind === "zone") return `初期値 ${ZONE_LABELS[def as SettingsValues["timeZone"]]}`;
  if (spec.kind === "choice" || spec.kind === "toggle") return `初期値 ${spec.choices![String(def)]}`;
  return `${spec.min}〜${spec.max}${spec.kind === "integer" ? "（整数）" : `（${spec.step}刻み）`}・初期値 ${def}`;
}

export const VISIBLE_FIELD_COUNT = 14;
export const toInputs = (v: SettingsValues): FormInputs =>
  Object.fromEntries(FIELD_SPECS.map(s => [s.key, String(v[s.key])])) as FormInputs;

/** 文字列入力を値へ。空や数字でない欄は NaN にして検査させる。 */
export function parseInputs(inputs: FormInputs, hidden?: Pick<SettingsValues, HiddenKey>): Record<string, unknown> {
  const out: Record<string, unknown> = hidden ? { bookBarPct: hidden.bookBarPct, bookBarOpacity: hidden.bookBarOpacity } : {};
  for (const s of FIELD_SPECS) {
    const raw = inputs[s.key].trim();
    out[s.key] = s.kind === "toggle" ? (raw === "true" ? true : raw === "false" ? false : raw)
      : s.kind === "zone" || s.kind === "choice" ? raw : (raw === "" || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw) ? NaN : Number(raw));
  }
  return out;
}

export function fieldVisible(key: VisibleKey, inputs: FormInputs): boolean {
  if (key === "heatTopPct") return inputs.heatUpperMode === "auto";
  if (key === "heatUpperSize") return inputs.heatUpperMode === "size";
  if (key === "heatLowerPct") return inputs.heatLowerMode === "pct";
  if (key === "heatLowerSize") return inputs.heatLowerMode === "size";
  return true;
}

export type FormStatus = "loading" | "ready" | "load-error" | "saving";

/** DOM から独立した設定フォームの状態。保存・反映は外部コールバックだけが行う。 */
export class SettingsForm {
  status: FormStatus = "loading";
  inputs: FormInputs = toInputs(DEFAULT_SETTINGS as SettingsValues);
  /** Hidden legacy values are carried through unchanged from the loaded document. */
  hidden: Pick<SettingsValues, HiddenKey> = { bookBarPct: DEFAULT_SETTINGS.bookBarPct, bookBarOpacity: DEFAULT_SETTINGS.bookBarOpacity };
  message = "";
  loaded = false;
  begin() {
    this.status = "loading"; this.message = ""; this.loaded = false;
    this.inputs = toInputs(DEFAULT_SETTINGS as SettingsValues);
  }
  loadOk(v: SettingsValues) { this.inputs = toInputs(v); this.hidden = { bookBarPct: v.bookBarPct, bookBarOpacity: v.bookBarOpacity }; this.status = "ready"; this.loaded = true; this.message = ""; }
  loadFail(reason: string) { this.status = "load-error"; this.loaded = false; this.message = `設定を読み込めませんでした：${reason}`; }
  set(key: VisibleKey, value: string) { this.inputs = { ...this.inputs, [key]: value }; }
  resetDefaults() { if (this.loaded) this.inputs = toInputs(DEFAULT_SETTINGS as SettingsValues); }
  errors(): Partial<Record<SettingsKey, string>> {
    return validateSettings(parseInputs(this.inputs, this.hidden)) as Partial<Record<SettingsKey, string>>;
  }
  canSave() { return this.status === "ready" && this.loaded && Object.keys(this.errors()).length === 0; }
  /** 保存開始。送る値を返す（不可なら null）。 */
  startSave(): SettingsValues | null {
    if (!this.canSave()) return null;
    this.status = "saving"; this.message = "";
    return parseInputs(this.inputs, this.hidden) as unknown as SettingsValues;
  }
  saveFail(reason: string) { this.status = "ready"; this.message = `保存できませんでした：${reason}`; }
}
