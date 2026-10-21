import type { Trade, DataQualityInterval } from "@workspace/core/events";
import { F04_TRADES } from "./f04-trades";

// Same economic trade, later delivery metadata. Source order is not rewritten.
const first = { ...F04_TRADES.events[0], header: { ...F04_TRADES.events[0].header,
  sessionId: "MOCK-F-08", eventId: "MOCK-F08-E1" } } as const;
const duplicate = { ...first, header: { ...first.header, eventId: "MOCK-F08-E2",
  sequence: "2", receiveTimeNs: "1767261600400000000" } } as const;
export const F08_DUPLICATE_TRADES = {
  environment: "MOCK", seed: 8, fixtureId: "F-08", expectedResultSchemaVersion: 1,
  notes: "MOCK retransmission ID policy and continuity, not verified vendor semantics.",
  events: [first, duplicate] satisfies readonly Trade[],
  quality: [{ channel: "TRADES", startNs: "1767261600000000000", endNs: "1767261602000000000",
    status: "VALID", reason: "MOCK declared continuous observation" }] satisfies readonly DataQualityInterval[],
  expected: { eventCount: 2, uniqueCount: 1, duplicateCount: 1, buy: 12, sell: 0,
    unknown: 0, rawVolume: 12, totalVolume: 12, delta: 12, imbalancePercent: 100,
    quality: "COMPLETE", filters: { volume: false, absoluteDelta: true, imbalancePercent: true }, pass: false },
} as const;
