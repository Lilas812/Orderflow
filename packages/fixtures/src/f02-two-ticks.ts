import { F01_BOOK } from "./f01-book";
import { restingQuantity } from "@workspace/core/events";

// MOCK only. All F-01 update times/order stay unchanged; another BID Tick holds 20 throughout.
const snapshot = F01_BOOK.events[0];
export const F02_TWO_TICKS = {
  environment: "MOCK", seed: 2, fixtureId: "F-02", expectedResultSchemaVersion: 1,
  notes: "MOCK: 80000 follows F-01; 80001 is known BID20 for [0,10). No real vendor protocol.",
  timeAlignmentEvidence: "MOCK: receiveTimeNs equals exchangeTimeNs; quality boundaries share that axis",
  events: [
    {
      ...snapshot,
      header: { ...snapshot.header, sessionId: "MOCK-F-02", eventId: "MOCK-F-02-1" },
      bids: [...snapshot.bids, { priceTicks: 80001, qty: restingQuantity(20) }],
      depthScope: { type: "PRICE_RANGE", minTick: 80000, maxTick: 80001 },
    },
    ...F01_BOOK.events.slice(1).map((event, index) => ({
      ...event, header: { ...event.header, sessionId: "MOCK-F-02", eventId: `MOCK-F-02-${index + 2}` },
    })),
  ],
  expected: {
    startNs: F01_BOOK.expected.startNs, endNs: F01_BOOK.expected.endNs,
    oneTick: [{ priceTicks: 80000, twa: 38 }, { priceTicks: 80001, twa: 20 }],
    twoTickTWA: 58,
  },
} as const;
