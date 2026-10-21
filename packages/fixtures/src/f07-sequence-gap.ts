import { F01_BOOK } from "./f01-book";
import { F04_TRADES } from "./f04-trades";

// Fixed MOCK choices, not CME/vendor sequence or snapshot protocol assertions.
const header = {
  ...F01_BOOK.events[0].header, sessionId: "MOCK-F-07",
  exchangeTimeNs: "1767225601000000000", receiveTimeNs: "1767225601000000000",
};
const snapshot = {
  ...F01_BOOK.events[0], header: { ...header, eventId: "MOCK-F-07-S10", sequence: "10" },
  snapshotCoversSequence: "10",
} as const;
const trade = {
  ...F04_TRADES.events[0],
  header: { ...header, channel: "TRADES", eventId: "MOCK-F-07-T1", sequence: "1",
    exchangeTimeNs: "1767225602000000000", receiveTimeNs: "1767225602000000000" },
} as const;
const gap = {
  ...F01_BOOK.events[1],
  header: { ...header, eventId: "MOCK-F-07-U12", sequence: "12",
    exchangeTimeNs: "1767225603000000000", receiveTimeNs: "1767225603000000000" },
} as const;
const recovery = {
  ...snapshot, header: { ...header, eventId: "MOCK-F-07-S13", sequence: "13",
    exchangeTimeNs: "1767225605000000000", receiveTimeNs: "1767225605000000000" },
  snapshotCoversSequence: "13",
} as const;

export const F07_SEQUENCE_GAP = {
  environment: "MOCK", seed: 7, fixtureId: "F-07", expectedResultSchemaVersion: 1,
  notes: "Contiguous per-normalized-event sequence within each MOCK channel only. No synthesized seq11.",
  assumptions: {
    continuityEvidence: "MOCK F-07 guarantees +1 per normalized event in each source/contract/session/channel/scope",
    snapshotAlignmentEvidence: "MOCK only: snapshot header sequence equals fully covered sequence",
  },
  startNs: "1767225600000000000",
  events: [snapshot, trade, gap],
  recovery,
  reconnectAtNs: "1767225604000000000",
  expected: [
    { L1: "NOT_INITIALIZED", L2_MBP: "VALID", TRADES: "NOT_INITIALIZED" },
    { L1: "NOT_INITIALIZED", L2_MBP: "VALID", TRADES: "VALID" },
    { L1: "NOT_INITIALIZED", L2_MBP: "GAP", TRADES: "VALID" },
  ],
  expectedAfterReconnect: { L1: "NOT_INITIALIZED", L2_MBP: "RESYNCING", TRADES: "VALID" },
  expectedAfterRecovery: { L1: "NOT_INITIALIZED", L2_MBP: "VALID", TRADES: "VALID" },
} as const;
