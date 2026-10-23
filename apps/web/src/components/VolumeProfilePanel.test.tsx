import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { UNIFIED_MOCK_STREAM } from "@workspace/fixtures";
import { createAnalysisHub } from "@workspace/core/analysis-hub";
import { createViewport, tickToY, type Viewport } from "@workspace/core/viewport";
import { VolumeProfilePanel, bigRatio } from "./VolumeProfilePanel";
import { unifiedChecks } from "../hooks/useMockAnalysisSession";
import { UNIFIED_BUBBLE_FILTERS } from "./ChartShell";
import { projectBubbles } from "@workspace/render/bubbles";
import { DEFAULT_BUBBLE_SIZING } from "@workspace/core/bubble-sizing";

function frame() {
  const hub = createAnalysisHub(UNIFIED_MOCK_STREAM.scope, () => 0);
  for (const input of UNIFIED_MOCK_STREAM.inputs) hub.ingest(input);
  return hub.readRenderFrame(UNIFIED_MOCK_STREAM.query);
}
const vp = (): Viewport => ({
  ...createViewport({ bounds: { left: 0, top: 0, width: 800, height: 400 }, latestNs: "1767225615000000000",
    price: { minTick: 79998, maxTick: 80005 } }), priceMode: "MANUAL", timeMode: "HISTORY",
});

it("unified frame matches declared expectations at one revision", () => {
  const f = frame();
  const checks = unifiedChecks(f);
  for (const c of checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
});

it("renders exact bigint labels, UNKNOWN note and session-cumulative scope", () => {
  const f = frame();
  const html = renderToStaticMarkup(<VolumeProfilePanel profile={f.volumeProfile.value} vp={vp()} revision={f.revision} />);
  expect(html).toContain("B 30 / S 10 / U 3 / V 43");
  expect(html).toContain("POC 80000 / VAL 80000 / VAH 80001");
  expect(html).toContain("POC 20000.00 (80000 ticks)");
  expect(html).toContain("VAH 20000.25 (80001 ticks)");
  expect(html).toContain("UNKNOWN aggressor volume 3 is not split");
  expect(html).toContain("Session cumulative");
  expect(html).toContain("NOT asserted");
});

it("aligns POC with the shared tickToY and never shows NO DATA as zero", () => {
  const f = frame(), v = vp();
  const html = renderToStaticMarkup(<VolumeProfilePanel profile={f.volumeProfile.value} vp={v} revision={f.revision} />);
  expect(html).toContain(`data-testid="vp-poc" data-tick="80000" data-y="${tickToY(v, 80000)!.toFixed(3)}"`);
  const empty = renderToStaticMarkup(<VolumeProfilePanel profile={null} vp={v} revision={null} />);
  expect(empty).toContain("NO DATA");
  expect(empty).not.toContain("V 0");
});

it("ratios are bigint-safe beyond 2^53", () => {
  const big = 9007199254740993n * 1000n;
  expect(bigRatio(big, big)).toBe(1);
  expect(bigRatio(big / 2n, big)).toBeCloseTo(0.5, 4);
  expect(bigRatio(0n, big)).toBe(0);
});

it("Delta keeps null as withheld, never zero", () => {
  const f = frame();
  const nulls = f.delta.items.filter(b => b.delta === null);
  expect(nulls.length).toBe(1);
  expect(nulls[0].U).toBe(3n);
});

it("does not invent UNKNOWN volume from rounding a mixed BUY/SELL row", () => {
  const f = frame(), original = f.volumeProfile.value!;
  const profile = { ...original, levels: [{ ...original.levels[0],
    buyVolume: 1n, sellVolume: 2n, unknownVolume: 0n, totalVolume: 3n },
  { ...original.levels[1], buyVolume: 0n, sellVolume: 7n, unknownVolume: 0n, totalVolume: 7n }] };
  const html = renderToStaticMarkup(<VolumeProfilePanel profile={profile} vp={vp()} revision={f.revision} />);
  const unknownRects = [...html.matchAll(/<rect [^>]*class="vp-u"[^>]*>/g)].map(m => m[0]);
  expect(unknownRects).toHaveLength(2);
  expect(unknownRects.every(rect => rect.includes('width="0"'))).toBe(true);
});

it("unified verification draws five complete bubbles without changing the six accepted Trades", () => {
  const f = frame(), base = vp();
  const v = { ...base, time: { minNs: (BigInt(UNIFIED_MOCK_STREAM.query.startNs) - 1_000_000_000n).toString(),
    maxNs: (BigInt(UNIFIED_MOCK_STREAM.query.endNs) + 1_000_000_000n).toString() } };
  const projected = projectBubbles(f.bubbles.items, v, DEFAULT_BUBBLE_SIZING, UNIFIED_BUBBLE_FILTERS);
  expect(f.volumeProfile.value!.totals.tradeCount).toBe(6);
  expect(projected.bubbles).toHaveLength(5);
  expect(projected.vertexCount).toBe(30);
  expect(f.bubbles.items.filter(b => b.status === "INCOMPLETE")).toHaveLength(1);
});
