import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diagnosticMode, profiler } from "./diagnostics/mockDiagnostics";
import { NQ } from "@workspace/core";
import type { DisplaySettings } from "@workspace/core/settings-schema";
import { ChartShell, MOCK_INSTRUMENT, MOCK_TRADES } from "./components/ChartShell";
import { HeatmapDemo, type HeatmapId } from "./components/HeatmapCanvas";
import { SettingsDrawer, SettingsErrorBanner } from "./components/SettingsDrawer";
import { TimeFormatProvider, type HeatmapActions } from "./components/SettingsContext";
import { useSettings } from "./hooks/useSettings";
import { useMockAnalysisSession, UNIFIED_SPEEDS } from "./hooks/useMockAnalysisSession";

function App() {
  const [count, setCount] = useState(0); // 0 = MOCK disabled, 2 or 3 loaded MOCK events
  const [hmId, setHmId] = useState<HeatmapId | null>(null);
  const trades = useMemo(() => MOCK_TRADES.slice(0, count), [count]);
  const scene = hmId ? HeatmapDemo[hmId] : null;
  const [bubbleId, setBubbleId] = useState<string | null>(null);
  const [bubbleRaw, setBubbleRaw] = useState(0);
  const [deltaId, setDeltaId] = useState<string | null>(null);
  const [deltaRaw, setDeltaRaw] = useState(0);
  const [ladderId, setLadderId] = useState<string | null>(null);
  const [ladderRaw, setLadderRaw] = useState(0);
  const uni = useMockAnalysisSession();
  const uniActive = uni.snap.phase !== "OFF";
  const uniExit = uni.exit;
  const settings = useSettings();
  const heatmapActions = useRef<HeatmapActions | null>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !settings.open) gearRef.current?.focus();
    wasOpen.current = settings.open;
  }, [settings.open]);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const openSettings = useCallback(() => { if (!settingsRef.current.open) settingsRef.current.begin(); }, []);
  const updateDisplay = useCallback((next: (s: DisplaySettings) => DisplaySettings) => settingsRef.current.update(next), []);
  const selectLadder = (id: string | null) => { setLadderId(id); if (!id) setLadderRaw(0); };
  const selectHeatmap = (id: HeatmapId | null) => { setHmId(id); if (id) { uniExit(); setCount(0); setBubbleId(null); setDeltaId(null); setDeltaRaw(0); } };
  const selectBubble = (id: string | null) => { setBubbleId(id); if (id) { uniExit(); setHmId(null); setCount(0); setDeltaId(null); setDeltaRaw(0); } else setBubbleRaw(0); };
  const selectDelta = (id: string | null) => { setDeltaId(id); if (id) { uniExit(); setHmId(null); setBubbleId(null); setCount(0); } else setDeltaRaw(0); };
  const setTradeCount = (fn: (c: number) => number) => { uniExit(); setHmId(null); setBubbleId(null); setDeltaId(null); setDeltaRaw(0); setCount(fn); };
  const startUnified = (ms: number) => { setHmId(null); setBubbleId(null); setBubbleRaw(0); setDeltaId(null); setDeltaRaw(0); setCount(0); uni.start(ms); };
  const restartUnified = (ms: number) => uni.restart(ms);
  const uSt = uni.snap.status;
  const statusText = uniActive ? `UNIFIED MOCK ${uni.snap.phase} (not live)` : deltaId ? `FIXED DELTA MOCK ${deltaId}` : ladderId && !bubbleId && !scene && count === 0 ? `FIXED LADDER MOCK ${ladderId}` : bubbleId ? `FIXED BUBBLE MOCK ${bubbleId}` : scene ? `FIXED HEATMAP MOCK ${scene.id}` : count === 0 ? "NO DATA" : `MOCK DATA ${count}/3`;
  const footerText = uniActive ? `MOCK / events loaded ${uSt?.processedMarketEvents ?? 0} (unified MOCK; not live)` : ladderId && !deltaId && !bubbleId && !scene && count === 0
    ? `MOCK / events loaded ${ladderRaw} (Ladder MOCK ${ladderId})`
    : deltaId ? `FIXED DELTA MOCK / events loaded ${deltaRaw}`
    : bubbleId ? `MOCK / events loaded ${bubbleRaw + 1} (bubble MOCK ${bubbleId})`
    : scene ? `MOCK / events loaded ${scene.eventCount} (heatmap MOCK ${scene.id})`
    : `MOCK / events loaded ${count}`;
  const preview = settings.preview;
  const content = (
    <TimeFormatProvider timeZone={preview.viewport.timeZone}>
    <div className="shell">
      <header className="bar">
        <h1 className="brand">Orderflow Lab</h1>
        <span className="instrument">{NQ.root} (contract not selected)</span>
        <span className="tag tag-source">MOCK • SIMULATED</span>
        <span className="tag tag-state" data-testid="status-data">{statusText}</span>
        <span className="tag tag-source" data-testid="status-settings">
          {settings.dirty ? "SETTINGS DRAFT (unsaved)" : settings.persisted ? "SETTINGS SAVED" : "SETTINGS DEFAULTS (not saved)"}
        </span>
        <button type="button" ref={gearRef} className="btn btn-gear spacer-r" data-testid="button-settings"
          aria-haspopup="dialog" aria-expanded={settings.open} aria-label="Open display settings"
          onClick={openSettings}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
          Settings
        </button>
      </header>
      {!settings.open && <SettingsErrorBanner c={settings} />}
      <main className="stage-chart">
        <ChartShell trades={trades} mockOn={count > 0}
          heatmap={scene} onSelectHeatmap={selectHeatmap}
          bubbleId={bubbleId} onSelectBubble={selectBubble} onBubbleRaw={setBubbleRaw}
          deltaId={deltaId} onSelectDelta={selectDelta} onDeltaRaw={setDeltaRaw}
          ladderId={ladderId} onSelectLadder={selectLadder} onLadderRaw={setLadderRaw}
          display={preview} onDisplay={updateDisplay} heatmapActionsRef={heatmapActions} onOpenSettings={openSettings}
          onToggleMock={() => setTradeCount((c) => (c === 0 ? 2 : 0))}
          unified={{ snap: uni.snap, speeds: UNIFIED_SPEEDS, onStart: startUnified, onStop: uni.stop, onRestart: restartUnified, onExit: uni.exit }}
          onAddThird={() => setTradeCount((c) => (c === 2 ? 3 : c))} />
      </main>
      <footer className="foot" data-testid="text-footer">
        {uniActive
          ? `Data source: MOCK / SIMULATED (not live) / Events loaded: ${uSt?.processedMarketEvents ?? 0} market events received, ${uSt?.acceptedMarketEvents ?? 0} accepted (unified MOCK; ${uSt?.processedInputs ?? 0}/${uSt?.sourceInputs ?? 0} inputs)`
          : ladderId && !deltaId && !bubbleId && !scene && count === 0
          ? `Data source: MOCK / Events loaded: ${ladderRaw} (raw market inputs of independent Ladder MOCK ${ladderId}; not derived from rows)`
          : deltaId
          ? `Data source: FIXED DELTA MOCK / Events loaded: ${deltaRaw} (raw Trade inputs across independent MOCK sources; no L2 snapshot; Delta MOCK ${deltaId})`
          : bubbleId
          ? `Data source: MOCK / Events loaded: ${bubbleRaw + 1} (${bubbleRaw} raw Trade inputs + 1 independent ${bubbleId.startsWith("DENSITY") ? "R10" : "R09"} L2 snapshot; bubble MOCK ${bubbleId})`
          : scene
          ? `Data source: MOCK / Events loaded: ${scene.eventCount} (raw depth events; heatmap MOCK ${scene.id})`
          : <>Data source: MOCK / Events loaded: {count}{count > 0 ? ` of 3 (fixed MOCK ${MOCK_INSTRUMENT}, 2026-01-01 UTC)` : ""}</>}
        {ladderId && (deltaId || bubbleId || scene || count > 0) && <span> / Independent Ladder MOCK {ladderId}: {ladderRaw} raw market inputs (separate scope)</span>}
      </footer>
      {settings.open && (
        <SettingsDrawer c={settings} actionsRef={heatmapActions}
          info={{ source: "MOCK / SIMULATED", state: statusText, footer: footerText }} />
      )}
    </div>
    </TimeFormatProvider>
  );
  return diagnosticMode() === "on" ? <Profiler id="unified-root"
    onRender={(_id, phase, actual, _base, start, commit) =>
      profiler("root", actual, start, commit, phase === "mount", uni.snap.frame?.revision ?? -1)}>
    {content}
  </Profiler> : content;
}

/** Explicit driver-only lifecycle exercise; no controls/timers in the normal application. */
function DiagnosticRoot() {
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    const unmount = () => setMounted(false);
    window.addEventListener("orderflow:diagnostic-unmount", unmount, { once: true });
    return () => window.removeEventListener("orderflow:diagnostic-unmount", unmount);
  }, []);
  return mounted ? <App /> : null;
}
export default diagnosticMode() === "off" ? App : DiagnosticRoot;
