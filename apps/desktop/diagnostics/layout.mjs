import assert from "node:assert/strict";
import { geometryGate } from "./contracts.mjs";

/** Executed in the renderer, contains no product state mutations. */
export function installLayoutMonitor() {
  const rows = [], observed = new WeakSet();
  let epoch = 0, ended = false;
  const read = () => {
    const box = e => {
      if (!e) return null;
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      return { clientWidth: e.clientWidth, scrollWidth: e.scrollWidth,
        clientHeight: e.clientHeight, scrollHeight: e.scrollHeight,
        width: r.width, height: r.height, overflowX: s.overflowX, overflowY: s.overflowY,
        gutter: s.scrollbarGutter, verticalOverflow: e.scrollHeight > e.clientHeight };
    };
    return { at: performance.now(), epoch, geometry: window.__load29Observer.geometry(),
      html: box(document.documentElement), body: box(document.body),
      root: box(document.getElementById("root")), page: box(document.querySelector('[data-testid="load29-page"]')),
      grid: box(document.querySelector(".cs-grid")), chart: box(document.querySelector('[data-testid="chart-area"]')) };
  };
  const observer = new ResizeObserver(entries => {
    epoch++;
    if (rows.length >= 2048) throw Error("LAYOUT_RECORD_CAP");
    rows.push({ epoch, at: performance.now(), boxes: entries.map(e => ({
      name: e.target.dataset.testid ?? e.target.tagName,
      width: e.contentRect.width, height: e.contentRect.height })) });
  });
  const watch = () => {
    for (const e of [document.documentElement, document.body, document.getElementById("root"),
      document.querySelector('[data-testid="load29-page"]'), document.querySelector(".cs-grid"),
      document.querySelector('[data-testid="chart-area"]'), ...document.querySelectorAll("canvas")]) {
      if (e && !observed.has(e)) { observer.observe(e); observed.add(e); }
    }
  };
  watch();
  window.__desktopLayout = { read, watch, rows,
    dispose: () => { if (!ended) observer.disconnect(); ended = true; return { disconnected: ended }; } };
}

export function layoutGate(snapshot, expected) {
  geometryGate(snapshot.geometry, expected);
  assert(snapshot.html.overflowY === "hidden" && snapshot.body.overflowY === "hidden" &&
    snapshot.root.overflowY === "hidden", "OUTER_SCROLL_REGION");
  assert(snapshot.page.gutter === "stable" && snapshot.page.overflowY === "auto", "INNER_SCROLL_REGION");
  assert(snapshot.chart.width === expected.width && snapshot.chart.height === expected.height, "CHART_CANVAS_MISMATCH");
}

export function stableLayout(samples) {
  assert(samples.length >= 3, "LAYOUT_SETTLE_SAMPLES");
  const last = samples.at(-1), g = last.geometry;
  assert(g.canvases.filter(c => c.connected).length === 2, "LAYOUT_CANVASES");
  const expected = { innerWidth: g.innerWidth, innerHeight: g.innerHeight,
    dpr: g.dpr, width: last.chart.width, height: last.chart.height };
  for (const s of samples.slice(-3)) {
    layoutGate(s, expected);
    assert(s.epoch === last.epoch, "RESIZE_OBSERVER_PENDING");
  }
  return expected;
}
