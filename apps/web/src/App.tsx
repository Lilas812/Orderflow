import { useMemo, useState } from "react";
import { NQ } from "@workspace/core";
import { ChartShell, MOCK_INSTRUMENT, MOCK_TRADES } from "./components/ChartShell";
import { HeatmapDemo, type HeatmapId } from "./components/HeatmapCanvas";

function App() {
  const [count, setCount] = useState(0); // 0 = MOCK disabled, 2 or 3 loaded MOCK events
  const [hmId, setHmId] = useState<HeatmapId | null>(null);
  const trades = useMemo(() => MOCK_TRADES.slice(0, count), [count]);
  const scene = hmId ? HeatmapDemo[hmId] : null;
  const selectHeatmap = (id: HeatmapId | null) => { setHmId(id); if (id) setCount(0); };
  const setTradeCount = (fn: (c: number) => number) => { setHmId(null); setCount(fn); };
  return (
    <div className="shell">
      <header className="bar">
        <h1 className="brand">Orderflow Lab</h1>
        <span className="instrument">{NQ.root} (contract not selected)</span>
        <span className="tag tag-source">MOCK • SIMULATED</span>
        <span className="tag tag-state" data-testid="status-data">{scene ? `FIXED HEATMAP MOCK ${scene.id}` : count === 0 ? "NO DATA" : `MOCK DATA ${count}/3`}</span>
      </header>
      <main className="stage-chart">
        <ChartShell trades={trades} mockOn={count > 0}
          heatmap={scene} onSelectHeatmap={selectHeatmap}
          onToggleMock={() => setTradeCount((c) => (c === 0 ? 2 : 0))}
          onAddThird={() => setTradeCount((c) => (c === 2 ? 3 : c))} />
      </main>
      <footer className="foot" data-testid="text-footer">
        {scene
          ? `Data source: MOCK / Events loaded: ${scene.eventCount} (raw depth events; fixed heatmap MOCK ${scene.id}, ${scene.cells.length} computed cells)`
          : <>Data source: MOCK / Events loaded: {count}{count > 0 ? ` of 3 (fixed MOCK ${MOCK_INSTRUMENT}, 2026-01-01 UTC)` : ""}</>}
      </footer>
    </div>
  );
}

export default App;
