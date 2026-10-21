import { useMemo, useState } from "react";
import { NQ } from "@workspace/core";
import { ChartShell, MOCK_INSTRUMENT, MOCK_TRADES } from "./components/ChartShell";

function App() {
  const [count, setCount] = useState(0); // 0 = MOCK disabled, 2 or 3 loaded MOCK events
  const trades = useMemo(() => MOCK_TRADES.slice(0, count), [count]);
  return (
    <div className="shell">
      <header className="bar">
        <h1 className="brand">Orderflow Lab</h1>
        <span className="instrument">{NQ.root} (contract not selected)</span>
        <span className="tag tag-source">MOCK • SIMULATED</span>
        <span className="tag tag-state" data-testid="status-data">{count === 0 ? "NO DATA" : `MOCK DATA ${count}/3`}</span>
      </header>
      <main className="stage-chart">
        <ChartShell trades={trades} mockOn={count > 0}
          onToggleMock={() => setCount((c) => (c === 0 ? 2 : 0))}
          onAddThird={() => setCount((c) => (c === 2 ? 3 : c))} />
      </main>
      <footer className="foot" data-testid="text-footer">
        Data source: MOCK / Events loaded: {count}{count > 0 ? ` of 3 (fixed MOCK ${MOCK_INSTRUMENT}, 2026-01-01 UTC)` : ""}
      </footer>
    </div>
  );
}

export default App;
