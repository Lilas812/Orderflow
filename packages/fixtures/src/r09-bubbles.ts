import { executedVolume, restingQuantity, type L2Snapshot, type Trade, type DataQualityInterval } from "@workspace/core/events";
import { F04_TRADES } from "./f04-trades";
import { F05_TRADES } from "./f05-trades";
import { F09_UNKNOWN_TRADES } from "./f09-unknown-trades";

/** Additional deterministic MOCK choices, not actual vendor progress or revision semantics. */
export interface BubbleDemoStep {
  readonly label: string;
  readonly tradeCount: number;
  readonly progressNs?: string;
  readonly condition?: "VALID" | "GAP" | "RESYNCING";
}
export interface BubbleDemoScenario {
  readonly id: string;
  readonly label: string;
  readonly events: readonly Trade[];
  readonly quality: readonly DataQualityInterval[];
  readonly steps: readonly BubbleDemoStep[];
}
const start = BigInt(F04_TRADES.expected.startNs);
const at = (offset: bigint) => (start + offset).toString();
const quality: readonly DataQualityInterval[] = [{
  channel: "TRADES", startNs: at(0n), endNs: at(10_000_000_000n),
  status: "VALID", reason: "R09 MOCK explicitly declares continuous TRADES observation for 10s; not inferred from trades",
}];
const steps: readonly BubbleDemoStep[] = [
  { label: "PROVISIONAL", tradeCount: 3 },
  { label: "FINAL / trusted event-time +5s", tradeCount: 3, progressNs: at(5_000_000_000n) },
];
const late: Trade = {
  ...F04_TRADES.events[1], tradeId: "MOCK-R09-LATE-SELL60", qty: executedVolume(60),
  header: { ...F04_TRADES.events[1].header, eventId: "MOCK-R09-LATE-E4", sequence: "4",
    exchangeTimeNs: at(1_900_000_000n), receiveTimeNs: at(6_000_000_000n) },
};
const duplicate: Trade = { ...late, header: { ...late.header, eventId: "MOCK-R09-LATE-E5",
  sequence: "5", receiveTimeNs: at(7_000_000_000n) } };
const flipEvents = [20, 60, 140].map((qty, i): Trade => ({
  ...F04_TRADES.events[i], tradeId: `MOCK-R09-FLIP-T${i + 1}`, qty: executedVolume(qty),
  aggressor: i === 1 ? "SELL" : "BUY",
  header: { ...F04_TRADES.events[i].header, sessionId: "MOCK-R09-FLIP", eventId: `MOCK-R09-FLIP-E${i + 1}` },
}));
const revision = (kind: "TRADE_CORRECTION" | "TRADE_CANCEL"): Trade => ({
  ...F04_TRADES.events[0], kind, tradeId: `MOCK-R09-${kind}`,
  originalTradeId: F04_TRADES.events[0].tradeId,
  header: { ...F04_TRADES.events[0].header, eventId: `MOCK-R09-${kind}-E4`, sequence: "4",
    receiveTimeNs: at(6_000_000_000n) },
});
export const R09_SCENARIOS: readonly BubbleDemoScenario[] = [
  { id: "F04", label: "F-04 B23 S4 V27 Δ+19", events: F04_TRADES.events, quality, steps },
  { id: "F05", label: "F-05 filtered Δ−2", events: F05_TRADES.events, quality,
    steps: [{ label: "Hidden: default filters", tradeCount: 2 }] },
  { id: "F09", label: "F-09 UNKNOWN", events: F09_UNKNOWN_TRADES.events, quality,
    steps: [{ label: "INCOMPLETE classification", tradeCount: F09_UNKNOWN_TRADES.events.length }] },
  { id: "FLIP", label: "R09 BUY → SELL → BUY", events: flipEvents, quality,
    steps: [1, 2, 3].map(tradeCount => ({
      label: ["BUY20 Δ+20", "SELL60 Δ−40", "BUY140 Δ+100"][tradeCount - 1], tradeCount,
    })) },
  { id: "LATE", label: "R09 late new Trade + duplicate", events: [...F04_TRADES.events, late, duplicate], quality,
    steps: [...steps, { label: "REVISED Δ−41 / revision 1", tradeCount: 4 },
      { label: "Duplicate / unchanged revision 1", tradeCount: 5 }] },
  { id: "GAP", label: "R09 TRADES GAP", events: F04_TRADES.events,
    quality: [
      { ...quality[0], endNs: at(1_000_000_000n) },
      { ...quality[0], startNs: at(1_000_000_000n), endNs: at(1_500_000_000n),
        status: "GAP", reason: "R09 MOCK missing TRADES interval, never zero-filled" },
      { ...quality[0], startNs: at(1_500_000_000n) },
    ], steps: [{ label: "INCOMPLETE / GAP", tradeCount: 3, condition: "GAP", progressNs: at(5_000_000_000n) }] },
  { id: "RESYNC", label: "R09 RESYNCING freezes finality", events: F04_TRADES.events, quality,
    steps: [steps[0], { label: "INCOMPLETE / RESYNCING", tradeCount: 3, condition: "RESYNCING",
      progressNs: at(5_000_000_000n) }] },
  ...(["TRADE_CORRECTION", "TRADE_CANCEL"] as const).map((kind): BubbleDemoScenario => ({
    id: kind === "TRADE_CANCEL" ? "CANCEL" : "CORRECTION",
    label: `R09 ${kind} unsupported`, events: [...F04_TRADES.events, revision(kind)], quality,
    steps: [...steps, { label: "INCOMPLETE / UNSUPPORTED_REVISION", tradeCount: 4 }],
  })),
];
export const R09_BUBBLE_EXPECTED = {
  environment: "MOCK", seed: 9, fixtureId: "R09-BUBBLES", expectedResultSchemaVersion: 1,
  f04: { centerNs: at(1_000_000_000n), centerTick: 80000.5, centerPoints: 20000.125,
    diameter: 16.313843876330612, buy: 23, sell: 4, volume: 27, delta: 19 },
  flip: [{ buy: 20, sell: 0, volume: 20, delta: 20 },
    { buy: 20, sell: 60, volume: 80, delta: -40 },
    { buy: 160, sell: 60, volume: 220, delta: 100 }],
  late: { buy: 23, sell: 64, volume: 87, delta: -41, revision: 1, uniqueCount: 4, rawCount: 5 },
} as const;

/** New synthetic L2 inputs solely for R09 overlap verification, NOT retimed F01.
 * Same scope as each Trade scene but independent channel/sequence. Exact observed
 * levels only; no inference from trades or from absent snapshot prices.
 */
export const R09_OVERLAY_DEPTH: Readonly<Record<string, L2Snapshot>> = Object.fromEntries(
  R09_SCENARIOS.map(scene => [scene.id, {
    kind: "L2_SNAPSHOT",
    header: { ...scene.events[0].header, channel: "L2_MBP", eventId: `MOCK-R09-DEPTH-${scene.id}`,
      sequence: "1", exchangeTimeNs: at(0n), receiveTimeNs: at(0n) },
    snapshotCoversSequence: "1", depthScope: { type: "PRICE_RANGE", minTick: 79998, maxTick: 80003 },
    impliedPolicy: "EXCLUDE",
    bids: [{ priceTicks: 79999, qty: restingQuantity(80) }, { priceTicks: 80000, qty: restingQuantity(100) }],
    asks: [{ priceTicks: 80001, qty: restingQuantity(75) }, { priceTicks: 80002, qty: restingQuantity(60) }],
  } satisfies L2Snapshot]),
);
