import { restingQuantity, type EventHeader, type L2Snapshot, type L2PriceUpdate, type MarketEvent } from "@workspace/core/events";
import type { MarketQualityConfig, QualityChannel } from "@workspace/core/quality-timeline";
import type { LadderTopEvidence } from "@workspace/core/ladder-view";
import { F01_BOOK } from "./f01-book";
import { F02_TWO_TICKS } from "./f02-two-ticks";
import { F07_SEQUENCE_GAP } from "./f07-sequence-gap";

const T0 = BigInt(F01_BOOK.expected.startNs), S = 1_000_000_000n;
const at = (second: number) => (T0 + BigInt(second) * S).toString();
const identity = (h: EventHeader) => {
  const { environment, source, sourceId, canonicalInstrumentId, sessionId } = h;
  return { environment, source, sourceId, canonicalInstrumentId, sessionId };
};
export interface LadderDemoStep {
  readonly label: string; readonly eventCount: number; readonly asOfNs: string;
  readonly condition?: { readonly channel: QualityChannel;
    readonly status: "GAP" | "STALE" | "RESYNCING" | "CLOSED" | "OUTSIDE_DEPTH";
    readonly atNs: string; readonly reason: string };
}
export interface LadderDemoScenario {
  readonly id: string; readonly label: string; readonly config: MarketQualityConfig;
  readonly startNs: string; readonly endNs: string; readonly events: readonly MarketEvent[];
  readonly steps: readonly LadderDemoStep[]; readonly priceMinTick: number; readonly priceMaxTick: number;
  readonly topEvidence: readonly LadderTopEvidence[];
}
const h: EventHeader = { ...F01_BOOK.events[0].header, sourceId: "MOCK-R12",
  sessionId: "MOCK-R12-NORMAL", eventId: "MOCK-R12-S1" };
const levels = (side: "BID" | "ASK") => Array.from({ length: 8 }, (_, i) => {
  const tick = 79998 + i;
  return { priceTicks: tick, qty: restingQuantity(side === "BID" ? tick === 80000 ? 60 : tick === 80001 ? 20 : 0
    : tick === 80002 ? 30 : tick === 80003 ? 15 : 0) };
});
const snapshot: L2Snapshot = {
  kind: "L2_SNAPSHOT", header: h, bids: levels("BID"), asks: levels("ASK"),
  depthScope: { type: "PRICE_RANGE", minTick: 79998, maxTick: 80005 },
  snapshotCoversSequence: "1", impliedPolicy: "EXCLUDE",
};
function update(seq: number, second: number, qty: number, del = false): L2PriceUpdate {
  return { kind: del ? "L2_DELETE_LEVEL" : "L2_SET_LEVEL", side: "BID", priceTicks: 80000,
    qty: restingQuantity(qty), header: { ...h, sequence: String(seq), eventId: `MOCK-R12-U${seq}`,
      exchangeTimeNs: at(second), receiveTimeNs: at(second) } };
}
function recovered(seq = 7, second = 6): L2Snapshot {
  return { ...snapshot, header: { ...h, sequence: String(seq), eventId: `MOCK-R12-S${seq}`,
    exchangeTimeNs: at(second), receiveTimeNs: at(second) }, snapshotCoversSequence: String(seq) };
}
function proof(s: L2Snapshot): LadderTopEvidence {
  return { identity: identity(s.header), snapshotCoversSequence: s.snapshotCoversSequence!,
    guarantee: "LISTED_LEVELS_INCLUDE_MARKET_BEST",
    evidence: "R12 independent MOCK only: listed levels include both market bests; explicit side-specific zeros cover the rest of 79998..80005. Contiguous complete MOCK updates; not a vendor protocol assertion." };
}
function config(s: L2Snapshot): MarketQualityConfig {
  const rule = { scope: "CHANNEL", continuity: { contiguous: true,
    evidence: "Fixed MOCK only: +1 per normalized event in each exact source/contract/session/channel partition" } } as const;
  return { identity: identity(s.header), depthScope: s.depthScope,
    rules: { L1: rule, L2_MBP: rule, TRADES: rule },
    snapshotAlignmentEvidence: "Fixed MOCK only: snapshot header sequence equals fully covered sequence" };
}
const step = (label: string, eventCount: number, second: number): LadderDemoStep => ({ label, eventCount, asOfNs: at(second) });
const condition = (label: string, eventCount: number, second: number, channel: QualityChannel,
  status: NonNullable<LadderDemoStep["condition"]>["status"]): LadderDemoStep => ({
    ...step(label, eventCount, second), condition: { channel, status, atNs: at(second), reason: `R12 explicit MOCK ${channel} ${status}` },
  });
function scenario(id: string, label: string, initial: L2Snapshot, events: readonly MarketEvent[],
  steps: readonly LadderDemoStep[], topEvidence: readonly LadderTopEvidence[] = []): LadderDemoScenario {
  return { id, label, config: config(initial), startNs: at(0), endNs: at(10), events, steps,
    priceMinTick: 79992, priceMaxTick: 80012, topEvidence };
}
const originalSteps = [
  step("0s: Bid40", 1, 0), step("1s: SET Bid80", 2, 1),
  step("3s: DELETE known0", 3, 3), step("5s: re-add60", 4, 5),
  step("6s observation: still60, last book event5s (not TWA38)", 4, 6),
  step("8s: DELETE known0", 5, 8),
];
const recovery = recovered();
const full: L2Snapshot = { ...snapshot, depthScope: { type: "FULL" },
  header: { ...h, sessionId: "MOCK-R12-FULL", eventId: "MOCK-R12-FULL-S1" } };
const top: L2Snapshot = { ...snapshot, depthScope: { type: "TOP_N", n: 2 },
  header: { ...h, sessionId: "MOCK-R12-TOP-N", eventId: "MOCK-R12-TOP-N-S1" },
  bids: snapshot.bids.filter(l => l.qty > 0), asks: snapshot.asks.filter(l => l.qty > 0) };
const cross: L2Snapshot = { ...snapshot, header: { ...h, sessionId: "MOCK-R12-CROSS", eventId: "MOCK-R12-CROSS-S1" },
  bids: snapshot.bids.map(l => l.priceTicks === 80003 ? { ...l, qty: restingQuantity(9) } : l) };
const staleRecovery = recovered(2, 3);
export const R12_LADDER_SCENARIOS: readonly LadderDemoScenario[] = [
  scenario("NORMAL", "Independent L2 MOCK / current quantities, not TWA", snapshot,
    [snapshot, update(2, 1, 80), update(3, 2, 0, true), update(4, 3, 60), update(6, 4, 100), recovery], [
      step("Normal: B80000=60 B80001=20 A80002=30 A80003=15", 1, 0),
      step("SET replaces60 with80", 2, 1), step("DELETE retains known0", 3, 2),
      step("Re-add60", 4, 3), step("Missing sequence5: L2 GAP; update100 NOT applied", 5, 4),
      condition("Reconnect is RESYNCING, not VALID", 5, 5, "L2_MBP", "RESYNCING"),
      step("New covering snapshot restores valid60", 6, 6),
    ], [proof(snapshot), proof(recovery)]),
  scenario("F01", "Original F-01 / independent scope / no global Best guarantee", F01_BOOK.events[0], F01_BOOK.events, originalSteps),
  scenario("F02", "Original F-02 / second Bid Tick80001=20", F02_TWO_TICKS.events[0], F02_TWO_TICKS.events, originalSteps),
  scenario("F07", "Original F-07 / L2 gap, Trade remains valid", F07_SEQUENCE_GAP.events[0],
    [...F07_SEQUENCE_GAP.events, F07_SEQUENCE_GAP.recovery], [
      step("Original snapshot seq10", 1, 1), step("Trade channel valid, L1 not initialized", 2, 2),
      step("Missing L2 seq11; no missing event synthesized", 3, 3),
      condition("Reconnect does not restore quantities", 3, 4, "L2_MBP", "RESYNCING"),
      step("Original covering snapshot seq13 restores L2", 4, 5),
    ]),
  scenario("STALE", "STALE quantities withheld, never described as current", snapshot, [snapshot, staleRecovery], [
    step("Valid snapshot", 1, 0), condition("STALE: all current quantities withheld", 1, 1, "L2_MBP", "STALE"),
    condition("RESYNCING: still withheld", 1, 2, "L2_MBP", "RESYNCING"),
    step("New snapshot restores", 2, 3),
  ], [proof(snapshot), proof(staleRecovery)]),
  scenario("TRADE_GAP", "Trade GAP and L1 missing do not invalidate valid L2", snapshot, [snapshot], [
    step("Valid L2 / L1 missing", 1, 0), condition("Trade GAP only; L2 quantities unchanged", 1, 1, "TRADES", "GAP"),
  ], [proof(snapshot)]),
  scenario("FULL", "FULL does not imply unlisted=0 or guarantee global Best", full, [full], [step("Unknown omitted levels remain UNKNOWN", 1, 0)]),
  scenario("TOP_N", "TOP_N side-specific envelopes; out of depth is not zero", top, [top], [step("Two positive levels per side; no global Best attestation", 1, 0)]),
  scenario("CROSS", "Abnormal crossed board retained without correction", cross, [cross], [step("Bid80003=9 above Ask80002=30", 1, 0)], [proof(cross)]),
  scenario("NOT_INITIALIZED", "No snapshot yet / NO DATA", snapshot, [], [step("No initial snapshot", 0, 0)]),
];
export const R12_LADDER_EXPECTED = {
  environment: "MOCK", fixtureId: "R12-LADDER", seed: 12, expectedResultSchemaVersion: 1,
  normal: { bids: [[80001, 20], [80000, 60]], asks: [[80002, 30], [80003, 15]],
    bestBidTick: 80001, bestAskTick: 80002 },
  f01Quantities: [40, 80, 0, 60, 60, 0],
  f01AtSixSeconds: { bid: 60, lastBookEventSecond: 5, twaOverTenSeconds: 38 },
  outsideDepthQty: null, staleQty: null, gapQty: null,
} as const;
