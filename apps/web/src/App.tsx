import { NQ } from "@workspace/core";

function App() {
  return (
    <div className="shell">
      <header className="bar">
        <h1 className="brand">Orderflow Lab</h1>
        <span className="instrument">{NQ.root} (contract not selected)</span>
        <span className="tag tag-source">MOCK • SIMULATED</span>
        <span className="tag tag-state">NO DATA</span>
      </header>
      <main className="stage">
        <p className="stage-label">Chart engine not implemented (R00)</p>
      </main>
      <footer className="foot">Data source: MOCK / Events loaded: 0</footer>
    </div>
  );
}

export default App;
