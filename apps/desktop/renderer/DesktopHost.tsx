import { useEffect, useState } from "react";
import App from "../../web/src/App";
import type { ObservationDisplay } from "../../web/src/lib/observationDisplay";
import { createObservationSession, type ObservationTransport } from "./observationSession";
import { desktopSettings } from "./services";

declare global {
  interface Window {
    orderflowDesktop?: { readonly appName: string; readonly mode: string; readonly apiVersion: number;
      readonly observations: ObservationTransport };
  }
}
export function DesktopHost() {
  const [mode, setMode] = useState<"MOCK" | "OBSERVATIONS">("MOCK");
  const [run, setRun] = useState(0);
  const [display, setDisplay] = useState<ObservationDisplay>({ frame: null, reason: "NOT_CONNECTED" });
  const [session, setSession] = useState<ReturnType<typeof createObservationSession> | null>(null);
  useEffect(() => {
    if (mode !== "OBSERVATIONS") return;
    const transport = window.orderflowDesktop?.observations;
    if (!transport) { setDisplay({ frame: null, reason: "DESKTOP_BRIDGE_UNAVAILABLE" }); return; }
    const s = createObservationSession(transport, setDisplay);
    setSession(s); void s.start();
    return () => { s.dispose(); setSession(null); };
  }, [mode, run]);
  return <>
    <div className="bar" data-testid="desktop-source-controls">
      <label>Data source <select aria-label="Desktop data source" value={mode}
        onChange={e => { setDisplay({ frame: null, reason: "NOT_CONNECTED" }); setMode(e.target.value as typeof mode); }}>
        <option value="MOCK">MOCK / SIMULATED</option>
        <option value="OBSERVATIONS">LIVE observation / HOLD（未接続）</option>
      </select></label>
      {mode === "OBSERVATIONS" && <>
        <button onClick={() => session?.stop()}>受信表示を停止</button>
        <button onClick={() => { setDisplay({ frame: null, reason: "NOT_CONNECTED" }); setRun(r => r + 1); }}>表示世代を再開始</button>
        <span>認証・利用権限未確認：実接続なし／RAM限定／市場データ保存なし</span>
      </>}
    </div>
    {mode === "MOCK"
      ? <App key="mock" initialMock settingsTransport={desktopSettings} />
      : <App key={`observations-${run}`} settingsTransport={desktopSettings} observation={display} />}
  </>;
}
