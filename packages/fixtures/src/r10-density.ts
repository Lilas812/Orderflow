import { executedVolume, restingQuantity, type Trade, type L2Snapshot, type DataQualityInterval } from "@workspace/core/events";
import type { BubbleDemoScenario } from "./r09-bubbles";

/** Entirely new deterministic MOCK, not retimed/mutated F04 or a vendor sample. */
const T0 = 1767261600000000000n;
const ns = (offset: bigint) => (T0 + offset).toString();
const header: Trade["header"] = {
  schemaVersion: 1, environment: "MOCK", source: "MOCK_DETERMINISTIC", sourceId: "MOCK-R10",
  canonicalInstrumentId: "CME:NQ:2026-03", channel: "TRADES", sessionId: "MOCK-R10-DENSITY",
  exchangeTimeNs: ns(0n), receiveTimeNs: ns(0n), sourceTimePrecision: "ns",
  sequenceScope: "CHANNEL", sequence: "1", eventId: "MOCK-R10-BASE", quality: "VALID",
};
const offsets = [300_000_000n, 800_000_000n, 1_700_000_000n] as const;
function group(index: number, seconds: bigint, priceTicks: number, buy: boolean): readonly Trade[] {
  return [12, 4, 11].map((qty, i) => {
    const id = index * 3 + i + 1, time = ns(seconds * 1_000_000_000n + offsets[i]);
    return {
      kind: "TRADE", tradeId: `MOCK-R10-T${id}`, priceTicks, qty: executedVolume(qty),
      aggressor: (i === 1 ? !buy : buy) ? "BUY" : "SELL", classification: "VENUE",
      header: { ...header, eventId: `MOCK-R10-E${id}`, sequence: String(id), exchangeTimeNs: time, receiveTimeNs: time },
    };
  });
}
const events = [
  ...group(0, 0n, 80000, true), ...group(1, 2n, 80002, true),
  ...group(2, 4n, 80004, true), ...group(3, 6n, 80012, false),
];
const quality: readonly DataQualityInterval[] = [{
  channel: "TRADES", startNs: ns(0n), endNs: ns(20_000_000_000n), status: "VALID",
  reason: "R10 MOCK explicitly observes the entire [0,20s) exchange-time interval; no inferred continuity",
}];
export const R10_SCENARIOS: readonly BubbleDemoScenario[] = [
  { id: "DENSITY", label: "R10 3 BUY + 1 SELL / complete FINAL", events, quality,
    steps: [{ label: "4 FINAL sources / explicit MOCK progress +11s", tradeCount: 12, progressNs: ns(11_000_000_000n) }] },
  { id: "DENSITY_MIXED", label: "R10 FINAL plus PROVISIONAL", events: [...events, ...group(4, 12n, 80004, true)], quality,
    steps: [
      { label: "4 FINAL sources", tradeCount: 12, progressNs: ns(11_000_000_000n) },
      { label: "Add PROVISIONAL source (never merged into FINAL)", tradeCount: 15 },
    ] },
];
/** Explicit same-scope exchange-time mapping. A real feed must supply its own
 * verified alignment; equality of event/quality timestamp strings is not proof.
 */
export const R10_CONTINUITY = Object.fromEntries(R10_SCENARIOS.map(s => [s.id, {
  scope: { environment: header.environment, source: header.source, sourceId: header.sourceId,
    canonicalInstrumentId: header.canonicalInstrumentId, sessionId: header.sessionId },
  timeAxis: "EXCHANGE_TIME_NS" as const,
  alignmentEvidence: "R10 deterministic MOCK explicitly defines quality intervals on the same UTC exchange-event-time axis as its Trades",
  intervals: s.quality,
}]));
export const R10_OVERLAY_DEPTH: Readonly<Record<string, L2Snapshot>> = Object.fromEntries(R10_SCENARIOS.map(s => [s.id, {
  kind: "L2_SNAPSHOT",
  header: { ...header, channel: "L2_MBP", eventId: `MOCK-R10-L2-${s.id}` },
  snapshotCoversSequence: "1", depthScope: { type: "PRICE_RANGE", minTick: 79998, maxTick: 80003 },
  impliedPolicy: "EXCLUDE",
  bids: [{ priceTicks: 80000, qty: restingQuantity(100) }],
  asks: [{ priceTicks: 80001, qty: restingQuantity(75) }],
} satisfies L2Snapshot]));
export const R10_DENSITY_EXPECTED = {
  environment: "MOCK", seed: 10, fixtureId: "R10-DENSITY", expectedResultSchemaVersion: 1,
  rawTradeCount: 12, sourceCount: 4,
  baseZoom: { spanSeconds: 600, all: 4, standard: 2, high: 2 },
  comparisonZoom: { spanSeconds: 180, cssWidths: [1158, 1798], standard: 4, high: 2 },
  buyCluster: { B: 69, S: 12, V: 81, delta: 57, imbalancePercent: 70.37037037037037, diameter: 22.4 },
  notes: "Viewport end +30s and price range [79900,80100] are display-only verification coordinates, not observed price extrema.",
} as const;
