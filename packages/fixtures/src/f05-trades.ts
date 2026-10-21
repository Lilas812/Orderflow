import { executedVolume, type Trade, type DataQualityInterval } from "@workspace/core/events";
import { F04_TRADES } from "./f04-trades";

// Only the quantities and the following 2-second interval come from DATA_SPEC §7.
// Date, precise offsets, identities and continuity below are fixed MOCK choices.
const events = [
  { ...F04_TRADES.events[0], tradeId: "MOCK-F05-T1", qty: executedVolume(12),
    header: { ...F04_TRADES.events[0].header, sessionId: "MOCK-F-05", eventId: "MOCK-F05-E1",
      sequence: "1", exchangeTimeNs: "1767261602300000000", receiveTimeNs: "1767261602300000000" } },
  { ...F04_TRADES.events[1], tradeId: "MOCK-F05-T2", qty: executedVolume(14),
    header: { ...F04_TRADES.events[1].header, sessionId: "MOCK-F-05", eventId: "MOCK-F05-E2",
      sequence: "2", exchangeTimeNs: "1767261602800000000", receiveTimeNs: "1767261602800000000" } },
] as const satisfies readonly Trade[];
export const F05_TRADES = {
  environment: "MOCK", seed: 5, fixtureId: "F-05", expectedResultSchemaVersion: 1,
  notes: "Explicit simulated BUY/SELL and continuity; not a vendor contract.",
  events,
  quality: [{ channel: "TRADES", startNs: "1767261602000000000", endNs: "1767261604000000000",
    status: "VALID", reason: "MOCK declared continuous observation" }] satisfies readonly DataQualityInterval[],
  expected: { eventCount: 2, uniqueCount: 2, buy: 12, sell: 14, unknown: 0,
    rawVolume: 26, totalVolume: 26, delta: -2, imbalancePercent: 7.6923076923076925,
    quality: "COMPLETE", filters: { volume: true, absoluteDelta: false, imbalancePercent: false }, pass: false },
} as const;
