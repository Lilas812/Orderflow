import { executedVolume, type Trade, type DataQualityInterval } from "@workspace/core/events";
import { F04_TRADES } from "./f04-trades";

// Additional UNKNOWN=5 and exact identity/time are MOCK-only choices, not §13 numeric oracles.
const events = [
  ...F04_TRADES.events.map((t) => ({ ...t, header: { ...t.header, sessionId: "MOCK-F-09" } })),
  { ...F04_TRADES.events[2], tradeId: "MOCK-F09-UNKNOWN", qty: executedVolume(5),
    aggressor: "UNKNOWN", classification: "UNKNOWN",
    header: { ...F04_TRADES.events[2].header, sessionId: "MOCK-F-09", eventId: "MOCK-F09-E4",
      sequence: "4", exchangeTimeNs: "1767261601800000000", receiveTimeNs: "1767261601800000000" } },
] as const satisfies readonly Trade[];
export const F09_UNKNOWN_TRADES = {
  environment: "MOCK", seed: 9, fixtureId: "F-09", expectedResultSchemaVersion: 1,
  notes: "UNKNOWN remains unclassified. Extra quantity and continuity are MOCK choices.",
  events,
  quality: [{ channel: "TRADES", startNs: "1767261600000000000", endNs: "1767261602000000000",
    status: "VALID", reason: "MOCK declared continuous observation" }] satisfies readonly DataQualityInterval[],
  expected: { eventCount: 4, uniqueCount: 4, buy: 23, sell: 4, unknown: 5, rawVolume: 32,
    totalVolume: null, delta: null, imbalancePercent: null,
    quality: "INCOMPLETE_CLASSIFICATION",
    filters: { volume: false, absoluteDelta: false, imbalancePercent: false }, pass: false },
} as const;
