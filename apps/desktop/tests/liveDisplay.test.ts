import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../../web/src/App";
import { createLiveAnalysisHub } from "@workspace/core/analysis-hub";
import type { ObservationDisplay } from "../../web/src/lib/observationDisplay";

it("feeds the existing four displays without a MOCK label or invented expiry, totals, or VALID coverage", () => {
  const hub = createLiveAnalysisHub(1, "SYNTHETIC_TEST", () => 0);
  hub.ingest({ origin: "SYNTHETIC_TEST", generation: 1, ordinal: 1, channel: "book",
    timestampNs: "1767225600000000000", receivedNs: "1767225600000000000",
    symbol: "NQ", precision: "s", contract: null, session: null, sequence: null, tradeId: null,
    levels: [{ side: "BID", priceTicks: 80000, qty: 17 }], trade: null });
  const html = renderToStaticMarkup(createElement<{ observation: ObservationDisplay }>(App, { observation: { frame: hub.read(), reason: "COVERAGE_UNKNOWN" } }));
  expect(html).toContain("SIMULATED / LIVE PIPELINE");
  expect(html).toContain('data-testid="observation-status"');
  expect(html).toContain('data-testid="observation-ladder"');
  expect(html).toContain('data-testid="observation-revisions" data-revision="1"');
  expect(html).toContain("Heatmap TWA: NO DATA / Bubble: NO DATA / Delta: NO DATA");
  expect(html).toContain("provider precision seconds");
  expect(html).not.toContain('data-testid="button-unified-start"');
  expect(html).not.toContain('data-testid="text-mock-howto"');
  expect(html).not.toContain("MOCK • SIMULATED");
  expect(html).not.toContain("MOCK / SIMULATED");
  expect(html).not.toContain("MOCK検証軸");
  expect(html).not.toContain("exact Trade bins / MOCK");
  expect(html).not.toContain("CME:NQ:2026-03");
  hub.dispose();
});
it("renders the disconnected desktop state as HOLD / NO DATA, not a connected LIVE stream", () => {
  const html = renderToStaticMarkup(createElement<{ observation: ObservationDisplay }>(App, { observation: { frame: null, reason: "NOT_CONNECTED" } }));
  expect(html).toContain("LIVE HOLD / NOT CONNECTED");
  expect(html).toContain("coverage UNKNOWN");
  expect(html).not.toContain('data-testid="button-mock-toggle"');
});
