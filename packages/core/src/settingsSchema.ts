import { DEFAULT_SCALE, validateScale, type ScaleSettings, type ScaleBaseline } from "./heatmapScale";
import { DEFAULT_BUBBLE_FILTERS, validateBubbleFilters, type BubbleFilters } from "./bubbleAggregate";
import { DEFAULT_BUBBLE_SIZING, bubbleDiameter, type BubbleSizing } from "./bubbleSizing";

export interface DisplaySettings {
  readonly schemaVersion: 1;
  readonly heatmap: {
    readonly scale: ScaleSettings;
    readonly palettes: Readonly<Record<"BID" | "ASK", { readonly low: string; readonly high: string }>>;
    readonly baselines: Readonly<Record<string, ScaleBaseline | null>>;
  };
  readonly bubbles: {
    readonly filters: BubbleFilters; readonly sizing: BubbleSizing;
    readonly density: "ALL" | "STANDARD" | "HIGH_COMPRESSION";
    readonly colors: { readonly buy: string; readonly sell: string; readonly neutral: string };
  };
  readonly priceLine: { readonly visible: boolean; readonly color: string; readonly width: number; readonly opacity: number };
  readonly viewport: { readonly initialMinutes: number; readonly autoMarginPercent: number; readonly timeZone: "Asia/Tokyo" | "UTC" };
}
export interface SettingsSnapshot {
  readonly revision: number; readonly persisted: boolean; readonly settings: DisplaySettings;
}
/** Transport boundary is replaceable by an Electron-local implementation. */
export interface SettingsTransport {
  load(): Promise<SettingsSnapshot>;
  save(settings: DisplaySettings, expectedRevision: number): Promise<SettingsSnapshot>;
}
export const MAX_SETTINGS_BYTES = 64 * 1024;
export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  schemaVersion: 1,
  heatmap: { scale: { ...DEFAULT_SCALE }, palettes: {
    BID: { low: "#061C13", high: "#43FA55" }, ASK: { low: "#1B092A", high: "#B235FA" },
  }, baselines: {} },
  bubbles: { filters: DEFAULT_BUBBLE_FILTERS, sizing: DEFAULT_BUBBLE_SIZING,
    density: "STANDARD", colors: { buy: "#43FA55", sell: "#B235FA", neutral: "#9CA3B4" } },
  priceLine: { visible: true, color: "#E8DFF6", width: 1.3, opacity: 1 },
  viewport: { initialMinutes: 30, autoMarginPercent: 15, timeZone: "Asia/Tokyo" },
};
function fail(ok: unknown, path: string): asserts ok {
  if (!ok) throw new TypeError(`Invalid settings: ${path}`);
}
function object(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  fail(value !== null && typeof value === "object" && !Array.isArray(value), path);
  const o = value as Record<string, unknown>;
  fail(Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null, path);
  fail(Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k)), `${path} keys`);
  return o;
}
function number(value: unknown, min: number, max: number, path: string, integer = false): void {
  fail(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    && (!integer || Number.isSafeInteger(value)), path);
}
function color(value: unknown, path: string): void { fail(typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value), path); }
function decimal(value: unknown, path: string): asserts value is string {
  fail(typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value) && value.length < 32, path);
}
/** Strict allow-list. Unknown keys (including credentials/events) never reach disk. */
export function validateDisplaySettings(input: unknown): DisplaySettings {
  const root = object(input, ["schemaVersion", "heatmap", "bubbles", "priceLine", "viewport"], "root");
  fail(root.schemaVersion === 1, "unsupported schemaVersion");
  const h = object(root.heatmap, ["scale", "palettes", "baselines"], "heatmap");
  object(h.scale, ["minimumVolume", "width", "mode", "absoluteMaxQty", "minIntensity", "maxIntensity",
    "liquidityContrast", "topContrast", "fixedBaseline"], "heatmap.scale");
  validateScale(h.scale as ScaleSettings);
  const palettes = object(h.palettes, ["BID", "ASK"], "heatmap.palettes");
  for (const side of ["BID", "ASK"]) {
    const p = object(palettes[side], ["low", "high"], `palette.${side}`);
    color(p.low, `${side}.low`); color(p.high, `${side}.high`);
  }
  fail(h.baselines !== null && typeof h.baselines === "object" && !Array.isArray(h.baselines), "baselines");
  const records = h.baselines as Record<string, unknown>;
  fail(Object.getPrototypeOf(records) === Object.prototype || Object.getPrototypeOf(records) === null, "baseline object");
  fail(Object.keys(records).length <= 16, "baseline count");
  for (const [key, value] of Object.entries(records)) {
    fail(/^(ABSOLUTE|RELATIVE)\|(BID|ASK)\|(1|2|4|8)$/.test(key), "baseline key");
    if (value === null) continue;
    const r = object(value, ["mode", "side", "width", "refQty", "asOfNs", "window", "status"], "baseline");
    fail(`${r.mode}|${r.side}|${r.width}` === key, "baseline scope");
    number(r.refQty, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, "baseline.refQty");
    decimal(r.asOfNs, "baseline.asOfNs");
    const w = object(r.window, ["startNs", "endNs"], "baseline.window");
    decimal(w.startNs, "baseline.startNs"); decimal(w.endNs, "baseline.endNs");
    fail(w.endNs === r.asOfNs && BigInt(w.endNs) - BigInt(w.startNs) === 300_000_000_000n, "baseline 300s window");
    fail(r.status === "READY" || r.status === "WARMING UP", "baseline.status");
  }
  const b = object(root.bubbles, ["filters", "sizing", "density", "colors"], "bubbles");
  const filters = object(b.filters, ["volume", "absoluteDelta", "imbalancePercent"], "bubbles.filters");
  for (const key of ["volume", "absoluteDelta", "imbalancePercent"]) {
    const f = object(filters[key], ["enabled", "minimum"], `filter.${key}`);
    fail(typeof f.enabled === "boolean", `${key}.enabled`);
    number(f.minimum, 0, key === "imbalancePercent" ? 100 : Number.MAX_SAFE_INTEGER, `${key}.minimum`, key !== "imbalancePercent");
  }
  validateBubbleFilters(b.filters as BubbleFilters);
  const sizing = object(b.sizing, ["mode", "minDiameter", "maxDiameter", "volumeReference", "fixedDiameter"], "bubbles.sizing");
  number(sizing.minDiameter, 4, 40, "minDiameter");
  number(sizing.maxDiameter, 8, 100, "maxDiameter");
  number(sizing.fixedDiameter, Number.MIN_VALUE, 100, "fixedDiameter");
  bubbleDiameter(0, b.sizing as BubbleSizing);
  fail(["ALL", "STANDARD", "HIGH_COMPRESSION"].includes(b.density as string), "bubble density");
  const colors = object(b.colors, ["buy", "sell", "neutral"], "bubble colors");
  for (const [key, value] of Object.entries(colors)) color(value, `bubble color.${key}`);
  const p = object(root.priceLine, ["visible", "color", "width", "opacity"], "priceLine");
  fail(typeof p.visible === "boolean", "priceLine.visible"); color(p.color, "priceLine.color");
  number(p.width, 1, 4, "priceLine.width"); number(p.opacity, 0, 1, "priceLine.opacity");
  const v = object(root.viewport, ["initialMinutes", "autoMarginPercent", "timeZone"], "viewport");
  number(v.initialMinutes, 1, 360, "viewport.initialMinutes", true);
  number(v.autoMarginPercent, 0, 50, "viewport.autoMarginPercent", true);
  fail(v.timeZone === "Asia/Tokyo" || v.timeZone === "UTC", "viewport.timeZone");
  return input as DisplaySettings;
}
export function cloneSettings(settings: DisplaySettings): DisplaySettings {
  validateDisplaySettings(settings);
  return JSON.parse(JSON.stringify(settings)) as DisplaySettings;
}
export function hexToRgb(hex: string): readonly [number, number, number] {
  color(hex, "color");
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
/** Validate the server envelope separately from editable settings. */
export function validateSettingsSnapshot(input: unknown): SettingsSnapshot {
  const s = object(input, ["revision", "persisted", "settings"], "snapshot");
  number(s.revision, 0, Number.MAX_SAFE_INTEGER, "revision", true);
  fail(typeof s.persisted === "boolean" && (s.persisted ? s.revision !== 0 : s.revision === 0), "persisted/revision");
  validateDisplaySettings(s.settings);
  return input as SettingsSnapshot;
}

/** Three independent snapshots: changing preview can never mutate SAVED. */
export interface SettingsSession {
  readonly saved: DisplaySettings; readonly draft: DisplaySettings; readonly preview: DisplaySettings;
  readonly revision: number; readonly persisted: boolean;
}
export function createSettingsSession(snapshot: SettingsSnapshot): SettingsSession {
  validateSettingsSnapshot(snapshot);
  return { saved: cloneSettings(snapshot.settings), draft: cloneSettings(snapshot.settings),
    preview: cloneSettings(snapshot.settings), revision: snapshot.revision, persisted: snapshot.persisted };
}
export function editSettings(session: SettingsSession, next: DisplaySettings): SettingsSession {
  return { ...session, draft: cloneSettings(next), preview: cloneSettings(next) };
}
export function cancelSettings(session: SettingsSession): SettingsSession {
  return { ...session, draft: cloneSettings(session.saved), preview: cloneSettings(session.saved) };
}
export function commitSettings(session: SettingsSession, snapshot: SettingsSnapshot, submitted: DisplaySettings): SettingsSession {
  const committed = createSettingsSession(snapshot);
  // A user may keep editing while a previously submitted snapshot is saving.
  return JSON.stringify(session.draft) === JSON.stringify(submitted) ? committed
    : { ...session, saved: committed.saved, revision: snapshot.revision, persisted: snapshot.persisted };
}
