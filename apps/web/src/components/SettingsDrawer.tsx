import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SettingsController } from "../hooks/useSettings";
import { HeatmapSettings } from "./HeatmapSettings";
import { BubbleSettings } from "./BubbleSettings";
import { PriceLineSettings } from "./PriceLineSettings";
import { ViewportSettings } from "./ViewportSettings";
import { DataStatusSettings, type DataStatusInfo } from "./DataStatusSettings";
import type { HeatmapActionsRef } from "./SettingsContext";

const TABS = [
  ["heatmap", "Heatmap"], ["bubbles", "Bubbles"], ["priceLine", "Price Line"], ["viewport", "Viewport"], ["dataStatus", "Data Status"],
] as const;
type TabId = (typeof TABS)[number][0];

export function SettingsErrorBanner({ c }: { c: SettingsController }) {
  if (!c.error) return null;
  return (
    <div className="sd-banner" role="alert" data-testid="settings-error">
      <span>Settings: {c.error}</span>
      <button type="button" className="btn" data-testid="button-settings-reload" disabled={c.saving}
        onClick={() => void c.reload()}>再読込（編集中の設定は破棄）</button>
    </div>
  );
}

export function SettingsDrawer({ c, actionsRef, info }: { c: SettingsController; actionsRef: HeatmapActionsRef; info: DataStatusInfo }) {
  const [tab, setTab] = useState<TabId>("heatmap");
  const head = useRef<HTMLHeadingElement>(null);
  const cancelRef = useRef(c.cancel); cancelRef.current = c.cancel;
  useEffect(() => { head.current?.focus(); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); cancelRef.current(); } };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);
  const invalid = Object.values(c.fieldErrors).some(Boolean);
  const state = !c.persisted ? "UNSAVED DEFAULTS" : "SAVED";
  const moveTab = (e: ReactKeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const n = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    setTab(TABS[n][0]);
    (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
  };
  return (
    <aside className="sd" role="dialog" aria-modal="false" aria-labelledby="sd-title" data-testid="settings-drawer">
      <header className="sd-head">
        <h2 id="sd-title" tabIndex={-1} ref={head}>Display Settings</h2>
        <button type="button" className="btn sd-x" aria-label="Close settings (cancel)" data-testid="button-settings-close"
          disabled={c.saving} onClick={c.cancel}>X</button>
      </header>
      <div className="sd-chips" data-testid="settings-state">
        <span className="chip" data-testid="settings-chip-saved" title="Last successfully saved">{state}{c.persisted ? ` r${c.revision}` : " (not saved)"}</span>
        <span className={`chip ${c.dirty ? "chip-warn" : ""}`} data-testid="settings-chip-draft" data-dirty={String(c.dirty)}>
          DRAFT {c.dirty ? "unsaved changes" : "no changes"}
        </span>
        <span className="chip" data-testid="settings-chip-preview">PREVIEW live on chart</span>
        <span className="chip chip-mock">MOCK / SIMULATED</span>
        {c.saving && <span className="chip chip-warn" data-testid="settings-chip-saving">SAVING</span>}
      </div>
      <SettingsErrorBanner c={c} />
      <div className="sd-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(([id, label], i) => (
          <button key={id} type="button" role="tab" id={`sd-tab-${id}`} aria-selected={tab === id} aria-controls="sd-body"
            tabIndex={tab === id ? 0 : -1} className="sd-tab" data-testid={`settings-tab-${id}`}
            onClick={() => setTab(id)} onKeyDown={(e) => moveTab(e, i)}>{label}</button>
        ))}
      </div>
      <div className="sd-body" id="sd-body" role="tabpanel" aria-labelledby={`sd-tab-${tab}`}>
        {!c.ready || c.loading ? (
          <div className="sd-skel" data-testid="settings-loading" aria-busy="true"><i /><i /><i /><i /></div>
        ) : <>
          <div hidden={tab !== "heatmap"}><HeatmapSettings c={c} actionsRef={actionsRef} /></div>
          <div hidden={tab !== "bubbles"}><BubbleSettings c={c} /></div>
          <div hidden={tab !== "priceLine"}><PriceLineSettings c={c} /></div>
          <div hidden={tab !== "viewport"}><ViewportSettings c={c} /></div>
          <div hidden={tab !== "dataStatus"}><DataStatusSettings c={c} info={info} /></div>
        </>}
      </div>
      <footer className="sd-foot">
        {invalid && <span className="sf-err" role="alert" data-testid="settings-invalid-note">Fix invalid fields to save.</span>}
        <button type="button" className="btn" data-testid="button-settings-cancel" disabled={c.saving} onClick={c.cancel}>Cancel</button>
        <button type="button" className="btn btn-primary" data-testid="button-settings-save"
          disabled={!c.canSave || c.saving || invalid || !c.ready} onClick={() => void c.save()}>
          {c.saving ? "Saving..." : "Apply and save"}
        </button>
      </footer>
    </aside>
  );
}
