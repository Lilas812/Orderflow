import type { SettingsController } from "../hooks/useSettings";
import { NumField } from "./SettingsFields";

export function ViewportSettings({ c }: { c: SettingsController }) {
  const v = c.draft.viewport;
  const set = (patch: Partial<typeof v>) => c.update((d) => ({ ...d, viewport: { ...d.viewport, ...patch } }));
  return (
    <div className="sd-section" data-testid="settings-panel-viewport">
      <NumField fkey="viewport.initialMinutes" testid="settings-viewport-initialMinutes" label="Initial time span" unit="minutes, 1 to 360"
        value={v.initialMinutes} min={1} max={360} sliderMax={360} step={1} integer ctl={c}
        hint="Used for first display and explicit Latest. Never moves the current view." onCommit={(n) => set({ initialMinutes: n })} />
      <NumField fkey="viewport.autoMarginPercent" testid="settings-viewport-autoMarginPercent" label="Price AUTO margin" unit="%, 0 to 50"
        value={v.autoMarginPercent} min={0} max={50} sliderMax={50} step={1} integer ctl={c}
        hint="Applies only while price mode is AUTO. MANUAL is never overridden." onCommit={(n) => set({ autoMarginPercent: n })} />
      <div className="sf">
        <label htmlFor="settings-viewport-timeZone">Time zone (labels only)</label>
        <select id="settings-viewport-timeZone" data-testid="settings-viewport-timeZone" value={v.timeZone}
          onChange={(e) => set({ timeZone: e.target.value as typeof v.timeZone })}>
          <option value="Asia/Tokyo">JST (Asia/Tokyo)</option><option value="UTC">UTC</option>
        </select>
        <span className="sf-hint">Data and bins stay UTC. Price axis is unaffected.</span>
      </div>
    </div>
  );
}
