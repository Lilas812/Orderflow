import type { SettingsController } from "../hooks/useSettings";
import { DataStatus } from "./DataStatus";

export interface DataStatusInfo { source: string; state: string; footer: string }

export function DataStatusSettings({ c, info }: { c: SettingsController; info: DataStatusInfo }) {
  const rows: [string, string][] = [
    ["Data source", info.source],
    ["Chart data state", info.state],
    ["Event summary", info.footer],
    ["Settings file", c.persisted ? `SAVED (revision ${c.revision})` : "Not saved: built-in defaults"],
    ["Settings storage", c.error ? `ERROR: ${c.error}` : c.ready ? "Readable" : "Loading"],
  ];
  return (
    <div className="sd-section" data-testid="settings-panel-dataStatus">
      <dl className="sd-dl">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd data-testid={`settings-status-${k.toLowerCase().replace(/\s+/g, "-")}`}>{v}</dd></div>)}
      </dl>
      <p className="note">Read only. No live vendor or account connection exists; all market data is MOCK / SIMULATED.</p>
      <DataStatus />
    </div>
  );
}
