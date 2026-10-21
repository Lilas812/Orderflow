import type { BubbleSizingMode } from "@workspace/core/bubble-sizing";
import type { SettingsController } from "../hooks/useSettings";
import { ColorField, NumField } from "./SettingsFields";

type FilterKey = "volume" | "absoluteDelta" | "imbalancePercent";
const NOT_IMPL = "未実装:集計設定変更は別工程";

export function BubbleSettings({ c }: { c: SettingsController }) {
  const b = c.draft.bubbles;
  const setFilter = (k: FilterKey, patch: Partial<{ enabled: boolean; minimum: number }>) =>
    c.update((d) => ({ ...d, bubbles: { ...d.bubbles, filters: { ...d.bubbles.filters, [k]: { ...d.bubbles.filters[k], ...patch } } } }));
  const setSizing = (patch: Partial<typeof b.sizing>) =>
    c.update((d) => ({ ...d, bubbles: { ...d.bubbles, sizing: { ...d.bubbles.sizing, ...patch } } }));
  const setColor = (k: "buy" | "sell" | "neutral", hex: string) =>
    c.update((d) => ({ ...d, bubbles: { ...d.bubbles, colors: { ...d.bubbles.colors, [k]: hex } } }));
  const filter = (k: FilterKey, testid: string, label: string, unit: string, max: number | undefined, integer: boolean, sliderMax: number) => (
    <div className="sd-filter" key={k}>
      <label className="sf-check"><input type="checkbox" data-testid={`${testid}-enabled`} checked={b.filters[k].enabled}
        onChange={(e) => setFilter(k, { enabled: e.target.checked })} /> {label} filter on</label>
      <NumField fkey={`bubbles.filters.${k}`} testid={testid} label={label} unit={unit} value={b.filters[k].minimum}
        min={0} max={max} sliderMax={sliderMax} step={integer ? 1 : 0.5} integer={integer} ctl={c} onCommit={(v) => setFilter(k, { minimum: v })} />
    </div>
  );
  return (
    <div className="sd-section" data-testid="settings-panel-bubbles">
      <fieldset className="sd-fieldset">
        <legend>Display filters (display only; Trade and Delta values unchanged)</legend>
        {filter("volume", "settings-bubble-volume", "Minimum total volume", "contracts", undefined, true, 200)}
        {filter("absoluteDelta", "settings-bubble-absoluteDelta", "Minimum absolute Delta", "contracts", undefined, true, 200)}
        {filter("imbalancePercent", "settings-bubble-imbalance", "Minimum imbalance", "%", 100, false, 100)}
      </fieldset>
      <fieldset className="sd-fieldset">
        <legend>Size</legend>
        <div className="sf">
          <label htmlFor="settings-bubble-sizingMode">Sizing mode</label>
          <select id="settings-bubble-sizingMode" data-testid="settings-bubble-sizingMode" value={b.sizing.mode}
            onChange={(e) => setSizing({ mode: e.target.value as BubbleSizingMode })}>
            {(["FIXED", "LINEAR", "SQRT", "LOG"] as const).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <NumField fkey="bubbles.sizing.minDiameter" testid="settings-bubble-minDiameter" label="Minimum diameter" unit="px"
          value={b.sizing.minDiameter} min={4} max={40} sliderMax={40} step={1} ctl={c} sig={String(b.sizing.maxDiameter)}
          extra={(v) => (v > b.sizing.maxDiameter ? "Must not exceed maximum diameter" : null)} onCommit={(v) => setSizing({ minDiameter: v })} />
        <NumField fkey="bubbles.sizing.maxDiameter" testid="settings-bubble-maxDiameter" label="Maximum diameter" unit="px"
          value={b.sizing.maxDiameter} min={8} max={100} sliderMax={100} step={1} ctl={c} sig={String(b.sizing.minDiameter)}
          extra={(v) => (v < b.sizing.minDiameter ? "Must not be below minimum diameter" : null)} onCommit={(v) => setSizing({ maxDiameter: v })} />
        <NumField fkey="bubbles.sizing.fixedDiameter" testid="settings-bubble-fixedDiameter" label="Fixed diameter" unit="px"
          value={b.sizing.fixedDiameter} min={0} max={100} sliderMax={100} step={1} positive ctl={c}
          hint="Used in FIXED mode only." onCommit={(v) => setSizing({ fixedDiameter: v })} />
        <NumField fkey="bubbles.sizing.volumeReference" testid="settings-bubble-volumeReference" label="Volume reference (fixed)" unit="contracts"
          value={b.sizing.volumeReference} min={1} sliderMax={1000} step={1} integer ctl={c}
          hint="Used in LINEAR / SQRT / LOG modes." onCommit={(v) => setSizing({ volumeReference: v })} />
      </fieldset>
      <div className="sf">
        <label htmlFor="settings-bubble-density">Display density</label>
        <select id="settings-bubble-density" data-testid="settings-bubble-density" value={b.density}
          onChange={(e) => c.update((d) => ({ ...d, bubbles: { ...d.bubbles, density: e.target.value as typeof b.density } }))}>
          {(["ALL", "STANDARD", "HIGH_COMPRESSION"] as const).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <fieldset className="sd-fieldset">
        <legend>Colors (Buy + / Sell - / Neutral 0)</legend>
        <ColorField fkey="bubbles.colors.buy" testid="settings-bubble-color-buy" label="Buy (Delta positive)" value={b.colors.buy} ctl={c} onCommit={(h) => setColor("buy", h)} />
        <ColorField fkey="bubbles.colors.sell" testid="settings-bubble-color-sell" label="Sell (Delta negative)" value={b.colors.sell} ctl={c} onCommit={(h) => setColor("sell", h)} />
        <ColorField fkey="bubbles.colors.neutral" testid="settings-bubble-color-neutral" label="Neutral (Delta zero)" value={b.colors.neutral} ctl={c} onCommit={(h) => setColor("neutral", h)} />
      </fieldset>
      <fieldset className="sd-fieldset" disabled>
        <legend>Aggregation (read only)</legend>
        <div className="sf"><label>Bubble window</label><div className="sf-ro" data-testid="settings-bubble-window-readonly">2000 ms. {NOT_IMPL}</div></div>
        <div className="sf"><label>Bubble price bin</label><div className="sf-ro" data-testid="settings-bubble-pricebin-readonly">2 ticks. {NOT_IMPL}</div></div>
      </fieldset>
    </div>
  );
}
