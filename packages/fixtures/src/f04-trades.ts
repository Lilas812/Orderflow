import { priceToTicks } from "@workspace/core";
import { executedVolume, type EventHeader, type Trade } from "@workspace/core/events";

// MOCK-only date, contract, price, IDs, classification and sequence choices.
// DATA_SPEC §7 supplies time-of-day offsets and quantities, not a vendor sample.
const priceTicks = priceToTicks(20000.00);
const header: EventHeader = {
  schemaVersion: 1,
  environment: "MOCK",
  source: "MOCK_DETERMINISTIC",
  sourceId: "MOCK",
  canonicalInstrumentId: "CME:NQ:2026-03",
  channel: "TRADES",
  sessionId: "MOCK-F-04",
  exchangeTimeNs: "1767261600300000000",
  receiveTimeNs: "1767261600300000000",
  sourceTimePrecision: "ns",
  sequenceScope: "CHANNEL",
  sequence: "1",
  eventId: "MOCK-F-04-1",
  quality: "VALID",
};

const events = [
  {
    kind: "TRADE", header, tradeId: "MOCK-TRADE-1", priceTicks,
    qty: executedVolume(12), aggressor: "BUY", classification: "VENUE",
  },
  {
    kind: "TRADE",
    header: { ...header, eventId: "MOCK-F-04-2", sequence: "2",
      exchangeTimeNs: "1767261600800000000", receiveTimeNs: "1767261600800000000" },
    tradeId: "MOCK-TRADE-2", priceTicks,
    qty: executedVolume(4), aggressor: "SELL", classification: "VENUE",
  },
  {
    kind: "TRADE",
    header: { ...header, eventId: "MOCK-F-04-3", sequence: "3",
      exchangeTimeNs: "1767261601700000000", receiveTimeNs: "1767261601700000000" },
    tradeId: "MOCK-TRADE-3", priceTicks,
    qty: executedVolume(11), aggressor: "BUY", classification: "VENUE",
  },
] as const satisfies readonly Trade[];

export const F04_TRADES = {
  environment: "MOCK",
  seed: 4,
  fixtureId: "F-04",
  expectedResultSchemaVersion: 1,
  notes: "All provenance, VENUE classification and continuity are simulated, not vendor verified.",
  events,
  expected: {
    startNs: "1767261600000000000",
    endNs: "1767261602000000000",
    eventCount: 3,
    buy: 23,
    sell: 4,
    totalVolume: 27,
    delta: 19,
    imbalancePercent: 70.37037037037037,
  },
} as const;
