import { useMemo, useState } from "react";
import { NQ } from "@workspace/core";
import { ChartShell, MOCK_INSTRUMENT, MOCK_TRADES } from "./components/ChartShell";
import { HeatmapDemo, type HeatmapId } from "./components/HeatmapCanvas";

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
  const selectLadder = (id: string | null) => { setLadderId(id); if (!id) setLadderRaw(0); };
  const selectHeatmap = (id: HeatmapId | null) => { setHmId(id); if (id) { setCount(0); setBubbleId(null); setDeltaId(null); setDeltaRaw(0); } };
  const selectBubble = (id: string | null) => { setBubbleId(id); if (id) { setHmId(null); setCount(0); setDeltaId(null); setDeltaRaw(0); } else setBubbleRaw(0); };
  const selectDelta = (id: string | null) => { setDeltaId(id); if (id) { setHmId(null); setBubbleId(null); setCount(0); } else setDeltaRaw(0); };
  const setTradeCount = (fn: (c: number) => number) => { setHmId(null); setBubbleId(null); setDeltaId(null); setDeltaRaw(0); setCount(fn); };
  return (
    <div className="shell">
      <header className="bar">
        <h1 className="brand">Orderflow Lab</h1>
        <span className="instrument">{NQ.root} (contract not selected)</span>
        <span className="tag tag-source">MOCK • SIMULATED</span>
        <span className="tag tag-state" data-testid="status-data">{deltaId ? `FIXED DELTA MOCK ${deltaId}` : ladderId && !bubbleId && !scene && count === 0 ? `FIXED LADDER MOCK ${ladderId}` : bubbleId ? `FIXED BUBBLE MOCK ${bubbleId}` : scene ? `FIXED HEATMAP MOCK ${scene.id}` : count === 0 ? "NO DATA" : `MOCK DATA ${count}/3`}</span>
      </header>
      <main className="stage-chart">
        <ChartShell trades={trades} mockOn={count > 0}
          heatmap={scene} onSelectHeatmap={selectHeatmap}
          bubbleId={bubbleId} onSelectBubble={selectBubble} onBubbleRaw={setBubbleRaw}
          deltaId={deltaId} onSelectDelta={selectDelta} onDeltaRaw={setDeltaRaw}
          ladderId={ladderId} onSelectLadder={selectLadder} onLadderRaw={setLadderRaw}
          onToggleMock={() => setTradeCount((c) => (c === 0 ? 2 : 0))}
          onAddThird={() => setTradeCount((c) => (c === 2 ? 3 : c))} />
      </main>
      <footer className="foot" data-testid="text-footer">
        {ladderId && !deltaId && !bubbleId && !scene && count === 0
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
    </div>
  );
}

export default App;
