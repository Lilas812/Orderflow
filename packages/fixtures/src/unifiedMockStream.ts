import {
  executedVolume, restingQuantity, type EventHeader, type L2Snapshot, type Trade,
} from "@workspace/core/events";
import type { AnalysisInput, AnalysisScope, AnalysisRenderQuery } from "@workspace/core/analysis-hub";

// A new deterministic, finite MOCK. No borrowed fixture identities, no vendor claims.
const origin = 1767225600000000000n;
const at = (seconds: number) => (origin + BigInt(seconds) * 1_000_000_000n).toString();
const identity = {
  environment: "MOCK", source: "MOCK_DETERMINISTIC", sourceId: "MOCK-UNIFIED",
  canonicalInstrumentId: "CME:NQ:2026-03", sessionId: "MOCK-UNIFIED-SESSION",
} as const;
const alignment = "Finite MOCK: exchange/receive/quality UTC axes are explicitly identical";
function header(channel: EventHeader["channel"], seq: number, seconds: number): EventHeader {
  return { ...identity, schemaVersion: 1, channel, sequenceScope: "CHANNEL", sequence: String(seq),
    eventId: `MOCK-UNIFIED-${channel}-${seq}`, exchangeTimeNs: at(seconds),
    receiveTimeNs: at(seconds), sourceTimePrecision: "ns", quality: "VALID" };
}
const depthScope = { type: "PRICE_RANGE", minTick: 80000, maxTick: 80003 } as const;
function snapshot(seq: number, seconds: number, qty: number): L2Snapshot {
  return { kind: "L2_SNAPSHOT", header: header("L2_MBP", seq, seconds), depthScope,
    snapshotCoversSequence: String(seq), impliedPolicy: "UNKNOWN",
    bids: [{ priceTicks: 80000, qty: restingQuantity(qty) }],
    asks: [{ priceTicks: 80003, qty: restingQuantity(20) }] };
}
function trade(seq: number, seconds: number, priceTicks: number, qty: number, aggressor: Trade["aggressor"]): Trade {
  return { kind: "TRADE", header: header("TRADES", seq, seconds),
    tradeId: `MOCK-UNIFIED-T${seq}`, priceTicks, qty: executedVolume(qty), aggressor,
    classification: aggressor === "UNKNOWN" ? "UNKNOWN" : "VENUE" };
}
const t1 = trade(1, 1, 80000, 12, "BUY");
const inputs = [
  { type: "EVENT", event: snapshot(1, 0, 40) },
  { type: "QUALITY_INTERVAL", observedAtNs: at(0), interval: {
    channel: "TRADES", startNs: at(0), endNs: at(14), status: "VALID",
    reason: "Finite artificial fixture declares [0,14) coverage; not future market observation",
  } },
  { type: "EVENT", event: t1 },
  { type: "EVENT", event: { kind: "L2_SET_LEVEL", header: header("L2_MBP", 2, 2),
    side: "BID", priceTicks: 80000, qty: restingQuantity(80) } },
  { type: "EVENT", event: trade(2, 3, 80001, 4, "SELL") },
  { type: "EVENT", event: { kind: "L2_DELETE_LEVEL", header: header("L2_MBP", 3, 4),
    side: "BID", priceTicks: 80000, qty: restingQuantity(0) } },
  { type: "CONDITION", channel: "L2_MBP", atNs: at(5), status: "GAP", reason: "Explicit artificial L2 interruption" },
  { type: "EVENT", event: trade(3, 6, 80000, 11, "BUY") },
  { type: "EVENT", event: snapshot(4, 7, 60) },
  { type: "EVENT", event: trade(4, 8, 80002, 3, "UNKNOWN") },
  { type: "EVENT", event: trade(5, 10, 80000, 7, "BUY") },
  { type: "EVENT", event: trade(6, 12, 80001, 6, "SELL") },
  { type: "EVENT", event: { kind: "L2_SET_LEVEL", header: header("L2_MBP", 5, 14),
    side: "BID", priceTicks: 80000, qty: restingQuantity(60) } },
] as const satisfies readonly AnalysisInput[];
const rule = { scope: "CHANNEL", continuity: {
  contiguous: true, evidence: "Artificial per-channel +1 sequence; snapshot covers its header sequence",
} } as const;
const scope: AnalysisScope = {
  config: { identity, depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
    snapshotAlignmentEvidence: alignment },
  startNs: at(0), depthTimeAlignmentEvidence: alignment, tradeTimeAlignmentEvidence: alignment,
  budget: { inputs: 512, normalizedBytes: 1_048_576, trades: 256, rawDeliveries: 512,
    depthRecords: 512, depthEvents: 512, qualityNotifications: 128, qualityIntervals: 512,
    dedupEntries: 1024, bookLevels: 64 },
  volumeProfile: { maxPriceLevels: 64 },
  derivedViews: { maxHeatmapCells: 512, maxBubbles: 256, maxDeltaBins: 30 },
};
const query: AnalysisRenderQuery = {
  startNs: at(0), endNs: at(14), cells: [0, 2, 4, 6, 8, 10, 12].map(seconds => ({
    side: "BID", priceTicks: 80000, width: 1, startNs: at(seconds), endNs: at(seconds + 2),
  })),
};
export const UNIFIED_MOCK_STREAM = {
  label: "MOCK / SIMULATED", scope, inputs, query,
  expected: {
    inputs: 13, acceptedTrades: 6, B: 30n, S: 10n, U: 3n, volume: 43n,
    pocTick: 80000, valTick: 80000, vahTick: 80001, valueAreaVolume: 40n,
    bidTwa: [40, 80, null, null, 60, 60, 60],
    gapNs: [at(5), at(7)], coverage: [1, 1, 0.5, 0.5, 1, 1, 1],
    // Delta per 2s bin: UNKNOWN at 8s is incomplete, never reported as zero.
    delta: [12n, -4n, 0n, 11n, null, 7n, -6n],
  },
} as const;
