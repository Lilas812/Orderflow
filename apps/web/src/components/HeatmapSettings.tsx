import type { BookSide } from "@workspace/core/events";
import type { ScaleSettings } from "@workspace/core/heatmap-scale";
import type { SettingsController } from "../hooks/useSettings";
import { ColorField, NumField } from "./SettingsFields";
import type { HeatmapActionsRef } from "./SettingsContext";

const sec = (ns: string) => (Number(BigInt(ns) / 1_000_000n) / 1000).toFixed(1);

export function HeatmapSettings({ c, actionsRef }: { c: SettingsController; actionsRef: HeatmapActionsRef }) {
  const a = actionsRef.current;
  const s: ScaleSettings = c.draft.heatmap.scale;
  const pal = c.draft.heatmap.palettes;
  if (!a) return <p className="note" data-testid="settings-heatmap-unavailable">Heatmap actions are not registered yet.</p>;
  const set = (patch: Partial<ScaleSettings>) => a.update(patch);
  const setColor = (side: BookSide, end: "low" | "high", hex: string) =>
    c.update((d) => ({ ...d, heatmap: { ...d.heatmap, palettes: { ...d.heatmap.palettes, [side]: { ...d.heatmap.palettes[side], [end]: hex } } } }));
  return (
    <div className="sd-section" data-testid="settings-panel-heatmap">
      <p className="note">Scale / calibration: Heatmap MOCK scenes. R09/R10 bubble backdrops keep their fixed ABS verification scale and width; only the palette is shared.</p>
      <NumField fkey="heatmap.minimumVolume" testid="settings-heatmap-minimumVolume" label="Minimum liquidity volume" unit="contracts"
        value={s.minimumVolume} min={0} sliderMax={5000} step={1} integer ctl={c} onCommit={(v) => set({ minimumVolume: v })}
        hint="Cells below this are hidden. Source depth is unchanged." />
      <div className="sf">
        <label htmlFor="settings-heatmap-width">Price bin width <span className="sf-unit">(ticks)</span></label>
        <select id="settings-heatmap-width" data-testid="settings-heatmap-width" value={s.width}
          onChange={(e) => set({ width: Number(e.target.value) as ScaleSettings["width"] })}>
          {[1, 2, 4, 8].map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>
      <div className="sf">
        <label htmlFor="settings-heatmap-mode">Scale mode</label>
        <select id="settings-heatmap-mode" data-testid="settings-heatmap-mode" value={s.mode}
          onChange={(e) => set({ mode: e.target.value as ScaleSettings["mode"] })}>
          <option value="ABSOLUTE">ABSOLUTE</option><option value="RELATIVE">RELATIVE</option>
        </select>
      </div>
      <NumField fkey="heatmap.absoluteMaxQty" testid="settings-heatmap-absoluteMaxQty" label="Absolute maximum quantity" unit="contracts"
        value={s.absoluteMaxQty} min={1} sliderMax={5000} step={1} integer positive ctl={c} onCommit={(v) => set({ absoluteMaxQty: v })} />
      <NumField fkey="heatmap.minIntensity" testid="settings-heatmap-minIntensity" label="Minimum intensity" unit="0 to 1"
        value={s.minIntensity} min={0} max={1} sliderMax={1} step={0.01} ctl={c} sig={String(s.maxIntensity)}
        extra={(v) => (v >= s.maxIntensity ? "Must be less than maximum intensity" : null)} onCommit={(v) => set({ minIntensity: v })} />
      <NumField fkey="heatmap.maxIntensity" testid="settings-heatmap-maxIntensity" label="Maximum intensity" unit="0 to 1"
        value={s.maxIntensity} min={0} max={1} sliderMax={1} step={0.01} ctl={c} sig={String(s.minIntensity)}
        extra={(v) => (v <= s.minIntensity ? "Must be greater than minimum intensity" : null)} onCommit={(v) => set({ maxIntensity: v })} />
      <NumField fkey="heatmap.liquidityContrast" testid="settings-heatmap-liquidityContrast" label="Liquidity contrast" unit="0.25 to 4"
        value={s.liquidityContrast} min={0.25} max={4} sliderMax={4} step={0.05} ctl={c} onCommit={(v) => set({ liquidityContrast: v })} />
      <NumField fkey="heatmap.topContrast" testid="settings-heatmap-topContrast" label="Top contrast" unit="0.25 to 4"
        value={s.topContrast} min={0.25} max={4} sliderMax={4} step={0.05} ctl={c} onCommit={(v) => set({ topContrast: v })} />
      <div className="sf-inline">
        <label className="sf-check"><input type="checkbox" data-testid="settings-heatmap-fixedBaseline" checked={s.fixedBaseline}
          onChange={(e) => set({ fixedBaseline: e.target.checked })} /> Fixed baseline</label>
        <button type="button" className="btn" data-testid="settings-heatmap-recalibrate" disabled={!s.fixedBaseline || !a.canRecalibrate}
          onClick={a.recalibrate}>Recalibrate</button>
      </div>
      {s.fixedBaseline && !a.canRecalibrate && a.recalibrateReason && <p className="sf-hint" data-testid="settings-heatmap-recalibrate-reason">{a.recalibrateReason}</p>}
      {a.captureError && <p className="sf-err" role="alert" data-testid="settings-heatmap-capture-error">{a.captureError}</p>}
      <div className="sd-status" data-testid="settings-heatmap-status">
        {a.status.map((st) => {
          const cand = st.candidate, rec = st.record;
          return (
            <div key={st.side} data-testid={`settings-heatmap-status-${st.side.toLowerCase()}`} data-reference={st.reference === null ? "null" : String(st.reference)}>
              <b>{st.side}</b> reference {st.reference === null ? "none (NO_BASELINE)" : st.reference}
              {cand && <> / {cand.status} (covered {sec(cand.coveredDurationNs)}s of 300.0s)</>}
              {cand?.status === "WARMING UP" && <div className="sf-warn">Provisional: under 300 s of history, even when fixed.</div>}
              {s.fixedBaseline && <div className="sf-hint">{rec === undefined ? "Fixed: not captured for this mode/width. Recalibrate." : rec === null ? "Fixed: captured with no baseline." : `Fixed ${rec.mode}/${rec.width} ref ${rec.refQty}`}</div>}
              {st.error && <div className="sf-err" role="alert">{st.error}</div>}
            </div>
          );
        })}
      </div>
      <fieldset className="sd-fieldset">
        <legend>Bid / Ask palette (resting liquidity)</legend>
        {(["BID", "ASK"] as const).map((side) => (["low", "high"] as const).map((end) => (
          <ColorField key={side + end} fkey={`heatmap.palettes.${side}.${end}`} testid={`settings-heatmap-palette-${side.toLowerCase()}-${end}`}
            label={`${side} ${end}`} value={pal[side][end]} ctl={c} onCommit={(hex) => setColor(side, end, hex)} />
        )))}
      </fieldset>
    </div>
  );
}
