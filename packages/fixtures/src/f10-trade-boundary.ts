import { executedVolume, type Trade, type DataQualityInterval } from "@workspace/core/events";
import { F04_TRADES } from "./f04-trades";

const events = [
  ["1767261600000000000", 80000, 1],
  ["1767261601999000000", 80001, 2],
  ["1767261601999999999", 80001, 4],
  ["1767261602000000000", 80000, 8],
  ["1767261602000000001", 80002, 16],
].map(([ns, tick, qty], i): Trade => ({
  ...F04_TRADES.events[0], priceTicks: Number(tick), qty: executedVolume(qty),
  tradeId: `MOCK-F10-T${i + 1}`, header: { ...F04_TRADES.events[0].header,
    sessionId: "MOCK-F-10", eventId: `MOCK-F10-E${i + 1}`, sequence: String(i + 1),
    exchangeTimeNs: String(ns), receiveTimeNs: String(ns) },
}));
export const F10_TRADE_BOUNDARY = {
  environment: "MOCK", seed: 10, fixtureId: "F-10", expectedResultSchemaVersion: 1,
  notes: "Fixed MOCK quantities/ticks test epoch boundaries at millisecond and nanosecond precision.",
  events,
  quality: [{ channel: "TRADES", startNs: "1767261600000000000", endNs: "1767261604000000000",
    status: "VALID", reason: "MOCK declared continuous observation" }] satisfies readonly DataQualityInterval[],
  expected: { eventCount: 5, uniqueCount: 5, buckets: [
    { startNs: "1767261600000000000", endNs: "1767261602000000000", minTick: 80000,
      maxTick: 80001, buy: 7, sell: 0, unknown: 0, rawVolume: 7, totalVolume: 7,
      delta: 7, imbalancePercent: 100, quality: "COMPLETE",
      filters: { volume: false, absoluteDelta: false, imbalancePercent: true }, pass: false },
    { startNs: "1767261602000000000", endNs: "1767261604000000000", minTick: 80000,
      maxTick: 80001, buy: 8, sell: 0, unknown: 0, rawVolume: 8, totalVolume: 8,
      delta: 8, imbalancePercent: 100, quality: "COMPLETE",
      filters: { volume: false, absoluteDelta: false, imbalancePercent: true }, pass: false },
    { startNs: "1767261602000000000", endNs: "1767261604000000000", minTick: 80002,
      maxTick: 80003, buy: 16, sell: 0, unknown: 0, rawVolume: 16, totalVolume: 16,
      delta: 16, imbalancePercent: 100, quality: "COMPLETE",
      filters: { volume: true, absoluteDelta: true, imbalancePercent: true }, pass: true },
  ] },
} as const;
