import { F01_BOOK } from "./f01-book";
import { restingQuantity } from "@workspace/core/events";

// Explicit MOCK missing interval, NOT an estimate of when a real sequence gap began.
const initial = F01_BOOK.events[0];
const header = { ...initial.header, sessionId: "MOCK-F-03" };
export const F03_GAP_TWA = {
  environment: "MOCK", seed: 3, fixtureId: "F-03", expectedResultSchemaVersion: 1,
  notes: "MOCK exact gap [9,11), not zero-filled; recovery snapshot establishes BID70.",
  timeAlignmentEvidence: "MOCK: receiveTimeNs equals exchangeTimeNs, and the gap boundaries are declared",
  events: [
    { ...initial, header: { ...header, eventId: "MOCK-F-03-S1",
      exchangeTimeNs: "1767225608000000000", receiveTimeNs: "1767225608000000000" },
      bids: [{ priceTicks: 80000, qty: restingQuantity(0) }] },
    { ...initial, header: { ...header, eventId: "MOCK-F-03-S2", sequence: "2",
      exchangeTimeNs: "1767225611000000000", receiveTimeNs: "1767225611000000000" },
      snapshotCoversSequence: "2", bids: [{ priceTicks: 80000, qty: restingQuantity(70) }] },
  ],
  gap: { startNs: "1767225609000000000", endNs: "1767225611000000000" },
  expected: {
    startNs: "1767225608000000000", endNs: "1767225612000000000",
    coveredDuration: "2000000000", coverageRatio: 0.5, partialTWA: 35,
    status: "NO DATA", twa: null,
  },
} as const;
