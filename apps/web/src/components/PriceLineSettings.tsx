import type { SettingsController } from "../hooks/useSettings";
import { ColorField, NumField } from "./SettingsFields";

export function PriceLineSettings({ c }: { c: SettingsController }) {
  const p = c.draft.priceLine;
  const set = (patch: Partial<typeof p>) => c.update((d) => ({ ...d, priceLine: { ...d.priceLine, ...patch } }));
  return (
    <div className="sd-section" data-testid="settings-panel-priceLine">
      <label className="sf-check"><input type="checkbox" data-testid="settings-priceLine-visible" checked={p.visible}
        onChange={(e) => set({ visible: e.target.checked })} /> Show price line</label>
      <ColorField fkey="priceLine.color" testid="settings-priceLine-color" label="Line color" value={p.color} ctl={c} onCommit={(h) => set({ color: h })} />
      <NumField fkey="priceLine.width" testid="settings-priceLine-width" label="Line width" unit="px, 1 to 4" value={p.width}
        min={1} max={4} sliderMax={4} step={0.1} ctl={c} onCommit={(v) => set({ width: v })} />
      <NumField fkey="priceLine.opacity" testid="settings-priceLine-opacity" label="Opacity" unit="0 to 1" value={p.opacity}
        min={0} max={1} sliderMax={1} step={0.05} ctl={c} onCommit={(v) => set({ opacity: v })} />
      <p className="note">Affects only the drawn line and isolated points. Trades, gaps and scope boundaries are unchanged.</p>
    </div>
  );
}
