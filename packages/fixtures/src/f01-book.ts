import { priceToTicks } from "@workspace/core";
import {
  restingQuantity,
  type EventHeader,
  type L2PriceUpdate,
  type L2Snapshot,
} from "@workspace/core/events";

// All dates, IDs, contract and sequences below are MOCK choices, not vendor rules.
// Origin: 2026-01-01T00:00:00Z. Scope covers ONLY the single fixture price.
const priceTicks = priceToTicks(20000.00);
const header: EventHeader = {
  schemaVersion: 1,
  environment: "MOCK",
  source: "MOCK_DETERMINISTIC",
  sourceId: "MOCK",
  canonicalInstrumentId: "CME:NQ:2026-03",
  channel: "L2_MBP",
  sessionId: "MOCK-F-01",
  exchangeTimeNs: "1767225600000000000",
  receiveTimeNs: "1767225600000000000",
  sourceTimePrecision: "ns",
  sequenceScope: "CHANNEL",
  sequence: "1",
  eventId: "MOCK-F-01-1",
  quality: "VALID",
};

const events = [
  {
    kind: "L2_SNAPSHOT", header,
    bids: [{ priceTicks, qty: restingQuantity(40) }], asks: [],
    depthScope: { type: "PRICE_RANGE", minTick: priceTicks, maxTick: priceTicks },
    snapshotCoversSequence: "1", impliedPolicy: "UNKNOWN",
  },
  {
    kind: "L2_SET_LEVEL",
    header: { ...header, eventId: "MOCK-F-01-2", sequence: "2",
      exchangeTimeNs: "1767225601000000000", receiveTimeNs: "1767225601000000000" },
    side: "BID", priceTicks, qty: restingQuantity(80),
  },
  {
    kind: "L2_DELETE_LEVEL",
    header: { ...header, eventId: "MOCK-F-01-3", sequence: "3",
      exchangeTimeNs: "1767225603000000000", receiveTimeNs: "1767225603000000000" },
    side: "BID", priceTicks, qty: restingQuantity(0),
  },
  {
    kind: "L2_SET_LEVEL",
    header: { ...header, eventId: "MOCK-F-01-4", sequence: "4",
      exchangeTimeNs: "1767225605000000000", receiveTimeNs: "1767225605000000000" },
    side: "BID", priceTicks, qty: restingQuantity(60),
  },
  {
    kind: "L2_DELETE_LEVEL",
    header: { ...header, eventId: "MOCK-F-01-5", sequence: "5",
      exchangeTimeNs: "1767225608000000000", receiveTimeNs: "1767225608000000000" },
    side: "BID", priceTicks, qty: restingQuantity(0),
  },
] as const satisfies readonly (L2Snapshot | L2PriceUpdate)[];

export const F01_BOOK = {
  environment: "MOCK",
  seed: 1, // Identity only: no random generator is used.
  fixtureId: "F-01",
  expectedResultSchemaVersion: 1,
  notes: "MOCK-only identifiers and timestamps; no real market data. No implied-policy inference.",
  events,
  expected: {
    startNs: "1767225600000000000",
    endNs: "1767225610000000000",
    eventCount: 5,
    timeWeightedAverage: 38,
    twoSecondAverages: [60, 40, 30, 60, 0],
    coverageRatio: 1,
  },
} as const;
