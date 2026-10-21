import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_SETTINGS, cancelSettings, cloneSettings, commitSettings, createSettingsSession,
  editSettings, hexToRgb, validateDisplaySettings, validateSettingsSnapshot,
} from "./settingsSchema";
import { captureBaseline } from "./heatmapScale";

const defaults = () => cloneSettings(DEFAULT_DISPLAY_SETTINGS);
describe("R13 strict versioned display settings", () => {
  it("accepts defaults matching R07/R08/R09 and no fake data", () => {
    expect(validateDisplaySettings(defaults())).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(defaults().heatmap.scale.minimumVolume).toBe(50);
    expect(defaults().bubbles.filters).toEqual({
      volume: { enabled: true, minimum: 15 }, absoluteDelta: { enabled: true, minimum: 10 },
      imbalancePercent: { enabled: true, minimum: 40 },
    });
  });
  it.each([undefined, null, [], 1, "{}", { ...DEFAULT_DISPLAY_SETTINGS, schemaVersion: 2 },
    { ...DEFAULT_DISPLAY_SETTINGS, schemaVersion: "1" }])("rejects invalid root/version %j", input => {
    expect(() => validateDisplaySettings(input)).toThrow();
  });
  it.each(["apiKey", "events", "credentials", "viewportHistory", "__proto__"])("rejects extra root key %s", key => {
    const s = JSON.parse(JSON.stringify(DEFAULT_DISPLAY_SETTINGS));
    Object.defineProperty(s, key, { value: "forbidden", enumerable: true });
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it("rejects unknown nested keys and missing required keys", () => {
    const s = defaults() as any;
    s.viewport.history = "forbidden"; expect(() => validateDisplaySettings(s)).toThrow();
    delete s.viewport.history; delete s.heatmap.scale.mode;
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it.each([
    ["minimumVolume", -1], ["minimumVolume", 1.5], ["minimumVolume", "5"], ["minimumVolume", null],
    ["absoluteMaxQty", 0], ["absoluteMaxQty", Infinity], ["absoluteMaxQty", 2 ** 53],
    ["width", 3], ["width", "2"], ["mode", "NORMAL"], ["fixedBaseline", 1],
    ["minIntensity", -0.1], ["maxIntensity", 2], ["liquidityContrast", 0.24], ["topContrast", 4.01],
    ["topContrast", NaN],
  ])("rejects heatmap %s=%s", (key, value) => {
    const s = defaults() as any; s.heatmap.scale[key] = value;
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it("rejects inverted or identical intensity limits", () => {
    const s = defaults() as any;
    s.heatmap.scale.minIntensity = 1;
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it.each(["red", "#abc", "#12345678", "url(evil)", "", 1])("rejects invalid color %j", value => {
    const s = defaults() as any; s.heatmap.palettes.BID.low = value;
    expect(() => validateDisplaySettings(s)).toThrow();
    s.heatmap.palettes.BID.low = "#010203"; s.bubbles.colors.buy = value;
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it.each([
    ["volume", "minimum", -1], ["absoluteDelta", "minimum", 1.5], ["volume", "enabled", "true"],
    ["volume", "minimum", 2 ** 53], ["imbalancePercent", "minimum", 100.1],
  ])("rejects bubble filter %s.%s", (key, field, value) => {
    const s = defaults() as any; s.bubbles.filters[key][field] = value;
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it.each([
    ["minDiameter", 3.9], ["maxDiameter", 101], ["volumeReference", 0],
    ["volumeReference", 1.5], ["mode", "VIEWPORT"], ["fixedDiameter", 0],
  ])("rejects invalid sizing %s", (key, value) => {
    const s = defaults() as any; s.bubbles.sizing[key] = value;
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it("rejects min diameter greater than max diameter", () => {
    const s = defaults() as any; s.bubbles.sizing.minDiameter = 30;
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it.each([
    ["initialMinutes", 0], ["initialMinutes", 361], ["initialMinutes", 1.5],
    ["autoMarginPercent", -1], ["autoMarginPercent", 50.1], ["timeZone", "local"],
  ])("rejects invalid viewport %s", (key, value) => {
    const s = defaults() as any; s.viewport[key] = value;
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it("accepts all explicit UI boundary ranges and hex case without rounding quantities", () => {
    const s = defaults() as any;
    s.heatmap.scale.minimumVolume = Number.MAX_SAFE_INTEGER;
    s.heatmap.scale.width = 8; s.heatmap.scale.liquidityContrast = 0.25;
    s.heatmap.scale.topContrast = 4; s.heatmap.palettes.ASK.high = "#abcdef";
    s.bubbles.sizing.minDiameter = 4; s.bubbles.sizing.maxDiameter = 100;
    s.bubbles.filters.imbalancePercent.minimum = 70.37037;
    s.viewport.initialMinutes = 360; s.viewport.autoMarginPercent = 50; s.viewport.timeZone = "UTC";
    expect(validateDisplaySettings(s)).toBe(s);
    expect(hexToRgb("#aBcDeF")).toEqual([171, 205, 239]);
  });
  it.each([["width", 0.9], ["width", 4.1], ["opacity", -0.1], ["opacity", 1.1], ["visible", "yes"]])(
    "rejects invalid price line %s", (key, value) => {
      const s = defaults() as any; s.priceLine[key] = value;
      expect(() => validateDisplaySettings(s)).toThrow();
    });
  it("preserves provisional fixed baseline metadata and exact nanoseconds", () => {
    const s = defaults() as any;
    s.heatmap.scale.mode = "RELATIVE"; s.heatmap.scale.fixedBaseline = true;
    const record = captureBaseline(s.heatmap.scale, { side: "BID", width: 1, refQty: 80,
      asOfNs: "1767225600000000123", window: { startNs: "1767225300000000123", endNs: "1767225600000000123" },
      status: "WARMING UP", reason: "Partial 300s", coveredDurationNs: "10000000000", coverageRatio: 1 / 30,
      positiveWeightNs: "10000000000" })!;
    s.heatmap.baselines["RELATIVE|BID|1"] = record;
    expect(cloneSettings(s).heatmap.baselines["RELATIVE|BID|1"]).toEqual(record);
    expect(record.status).toBe("WARMING UP");
    const saved = createSettingsSession({ revision: 1, persisted: true, settings: s });
    const next = cloneSettings(s) as any;
    next.heatmap.scale.fixedBaseline = false; next.heatmap.baselines = {};
    expect(cancelSettings(editSettings(saved, next)).preview.heatmap.baselines["RELATIVE|BID|1"]).toEqual(record);
    s.heatmap.baselines["RELATIVE|BID|1"] = { ...record, asOfNs: 1767225600000000123 };
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it("rejects malformed baseline key, mismatched scope and incomplete metadata", () => {
    const s = defaults() as any;
    s.heatmap.baselines["RELATIVE|BID|3"] = null; expect(() => validateDisplaySettings(s)).toThrow();
    delete s.heatmap.baselines["RELATIVE|BID|3"];
    s.heatmap.baselines["ABSOLUTE|BID|1"] = { side: "ASK" };
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it("rejects a non-plain baseline object", () => {
    const s = defaults() as any; s.heatmap.baselines = new Date();
    expect(() => validateDisplaySettings(s)).toThrow();
  });
  it("validates persisted/revision relationship without accepting unknown envelope fields", () => {
    expect(validateSettingsSnapshot({ revision: 0, persisted: false, settings: defaults() }).persisted).toBe(false);
    for (const extra of [{ revision: 0, persisted: true }, { revision: -1, persisted: false }, { revision: 1.5, persisted: true }]) {
      expect(() => validateSettingsSnapshot({ ...extra, settings: defaults() })).toThrow();
    }
    expect(() => validateSettingsSnapshot({ revision: 1, persisted: true, settings: defaults(), secret: "" })).toThrow();
  });
});

describe("R13 SAVED / DRAFT / PREVIEW transactions", () => {
  const first = () => createSettingsSession({ revision: 1, persisted: true, settings: defaults() });
  it("preview/cancel 50 → 0 → 50 and color/fixed-baseline state roll back together", () => {
    const start = first(), next = defaults() as any;
    next.heatmap.scale.minimumVolume = 0; next.bubbles.colors.buy = "#FF0000";
    next.heatmap.scale.fixedBaseline = true;
    const edited = editSettings(start, next);
    expect(edited.preview.heatmap.scale.minimumVolume).toBe(0);
    expect(edited.saved.heatmap.scale.minimumVolume).toBe(50);
    expect(cancelSettings(edited)).toEqual(start);
    expect(edited.saved).not.toBe(edited.draft);
    expect(edited.preview).not.toBe(edited.draft);
  });
  it("only the confirmed snapshot updates SAVED, survives JSON restore, revision advances", () => {
    const next = defaults() as any; next.heatmap.scale.minimumVolume = 0;
    const edited = editSettings(first(), next), snapshot = { revision: 2, persisted: true, settings: next };
    const committed = commitSettings(edited, snapshot, next);
    expect(committed.saved.heatmap.scale.minimumVolume).toBe(0);
    expect(createSettingsSession(JSON.parse(JSON.stringify(snapshot)))).toEqual(committed);
  });
  it("edits made while saving remain DRAFT/PREVIEW, cancel uses the newly saved snapshot", () => {
    const sent = defaults() as any; sent.heatmap.scale.minimumVolume = 0;
    const additional = cloneSettings(sent) as any; additional.heatmap.scale.minimumVolume = 80;
    const edited = editSettings(editSettings(first(), sent), additional);
    const committed = commitSettings(edited, { revision: 2, persisted: true, settings: sent }, sent);
    expect(committed.saved.heatmap.scale.minimumVolume).toBe(0);
    expect(committed.draft.heatmap.scale.minimumVolume).toBe(80);
    expect(committed.preview.heatmap.scale.minimumVolume).toBe(80);
    expect(cancelSettings(committed).preview.heatmap.scale.minimumVolume).toBe(0);
  });
  it("does not share mutable references with UI or HTTP callers", () => {
    const sent = defaults() as any, start = first(), edited = editSettings(start, sent);
    sent.heatmap.scale.minimumVolume = 0;
    expect(edited.preview.heatmap.scale.minimumVolume).toBe(50);
    expect(start.saved.heatmap.scale.minimumVolume).toBe(50);
  });
});
