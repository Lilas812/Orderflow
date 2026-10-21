import { F07_SEQUENCE_GAP } from "./f07-sequence-gap";

// All events and identifiers are MOCK; no L1 event is supplied or synthesized.
const snapshot = {
  ...F07_SEQUENCE_GAP.events[0],
  header: { ...F07_SEQUENCE_GAP.events[0].header, sessionId: "MOCK-F-16", eventId: "MOCK-F-16-S10" },
} as const;
const trade = {
  ...F07_SEQUENCE_GAP.events[1],
  header: { ...F07_SEQUENCE_GAP.events[1].header, sessionId: "MOCK-F-16", eventId: "MOCK-F-16-T1" },
} as const;
export const F16_NO_L1 = {
  environment: "MOCK", seed: 16, fixtureId: "F-16", expectedResultSchemaVersion: 1,
  notes: "L1 absent; independently valid L2 snapshot and TRADES, using explicit MOCK continuity/alignment.",
  assumptions: { ...F07_SEQUENCE_GAP.assumptions },
  startNs: F07_SEQUENCE_GAP.startNs,
  events: [snapshot, trade],
  expected: [
    { L1: "NOT_INITIALIZED", L2_MBP: "VALID", TRADES: "NOT_INITIALIZED" },
    { L1: "NOT_INITIALIZED", L2_MBP: "VALID", TRADES: "VALID" },
  ],
} as const;
