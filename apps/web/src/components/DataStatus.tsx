/**
 * R16 has no browser↔gateway transport. Intentionally accepts no CLI counters:
 * archived measurements must never masquerade as live telemetry.
 */
export function DataStatus() {
  const rows: [string,string][] = [
    ["Pipeline source", "MOCK / SIMULATED"],
    ["Node pipeline", "NOT RUNNING"],
    ["Pipeline connection", "NOT CONNECTED"],
    ["L1 / L2 / TRADES pipeline quality", "NOT MEASURED / NOT MEASURED / NOT MEASURED"],
    ["Received / accepted / applied / persisted", "NOT MEASURED"],
    ["Duplicate / rejected / lost events", "NOT MEASURED"],
    ["Queue depth / bytes / peak", "NOT MEASURED"],
    ["IPC unconfirmed sends / bytes", "NOT MEASURED"],
    ["Pipeline storage", "NOT CONNECTED"],
    ["Latest exchange / persisted / rendered time", "NOT MEASURED"],
    ["Last committed position", "NOT MEASURED"],
    ["Processing / storage / render lag", "NOT MEASURED"],
    ["Reconnects / sequence gaps / storage errors", "NOT MEASURED"],
  ];
  return <section aria-label="R16 pipeline status" data-testid="pipeline-status">
    <h3>Pipeline status</h3>
    <dl className="sd-dl">{rows.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    <p className="note">Node CLI tests are not connected to this browser. Chart MOCK counts above are not pipeline telemetry. No live market connection exists.</p>
  </section>;
}
