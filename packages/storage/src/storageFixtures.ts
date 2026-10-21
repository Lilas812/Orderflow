import { restingQuantity, type L2Snapshot, type MarketEvent } from "@workspace/core/events";
import type { MarketQualityConfig } from "@workspace/core/quality-timeline";
import { F01_BOOK, F07_SEQUENCE_GAP } from "@workspace/fixtures";
import type { ScopeDefinition } from "./eventJournal";
import type { ContinuityEvidence } from "./snapshotStore";

export { F01_BOOK, F07_SEQUENCE_GAP };
export const SECOND = 1_000_000_000n;
export const BASE_NS = F01_BOOK.expected.startNs;
export const at = (seconds: number): string => (BigInt(BASE_NS) + BigInt(seconds) * SECOND).toString();
export const mockEvidence = (scope: ScopeDefinition, endNs: string): ContinuityEvidence => ({
  schemaVersion: 1, scopeId: scope.id, channel: "L2_MBP", startNs: scope.startNs, endNs,
  clockMapping: "IDENTICAL_MOCK_EXCHANGE_RECEIVE_UTC",
  description: "Fixed normalized MOCK only: equal exchange/receive UTC axes and complete observation throughout this explicit interval",
});

/** Only a declaration about these fixed MOCKs; not a vendor/clock protocol. */
export function mockConfig(snapshot: L2Snapshot): MarketQualityConfig {
  const { environment, source, sourceId, canonicalInstrumentId, sessionId } = snapshot.header;
  const rule = { scope: "CHANNEL", continuity: {
    contiguous: true, evidence: "Fixed normalized MOCK guarantees +1 per channel",
  } } as const;
  return {
    identity: { environment, source, sourceId, canonicalInstrumentId, sessionId },
    depthScope: snapshot.depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
    snapshotAlignmentEvidence: "Fixed MOCK snapshot header sequence equals covered sequence",
  };
}

const base = F01_BOOK.events[0];
const header = (seconds: number, sequence: string) => ({
  ...base.header, sessionId: "MOCK-R14-60S",
  eventId: `MOCK-R14-60S-${sequence}`, sequence,
  exchangeTimeNs: at(seconds), receiveTimeNs: at(seconds),
});
export const STORAGE_60S = {
  environment: "MOCK", fixtureId: "R14-60S", seed: 1460, expectedResultSchemaVersion: 1,
  dataKind: "NORMALIZED_MOCK_EVENTS_NOT_VENDOR_RAW",
  evidence: "This independent fixed MOCK has equal exchange/receive UTC axes and no missing L2 events from 0 through 75 seconds",
  events: [
    { ...base, header: header(0, "1") },
    { kind: "L2_SET_LEVEL", header: header(30, "2"),
      side: "BID", priceTicks: 80000, qty: restingQuantity(80) },
    { kind: "L2_SET_LEVEL", header: header(75, "3"),
      side: "BID", priceTicks: 80000, qty: restingQuantity(100) },
  ] as const satisfies readonly MarketEvent[],
  expected: { checkpointNs: at(60), checkpointQty: 80, recoveryNs: at(75), recoveryQty: 100 },
} as const;

export const STORAGE_GAP_60S = {
  environment: "MOCK", fixtureId: "R14-GAP-60S", seed: 1461, expectedResultSchemaVersion: 1,
  dataKind: "NORMALIZED_MOCK_EVENTS_NOT_VENDOR_RAW",
  events: [
    { ...STORAGE_60S.events[0], header: { ...header(0, "1"), sessionId: "MOCK-R14-GAP-60S" } },
    { ...STORAGE_60S.events[1], header: { ...header(30, "3"), sessionId: "MOCK-R14-GAP-60S" } },
  ] as const,
  expected: { checkpointNs: at(60), status: "GAP", normalCheckpointCount: 0 },
} as const;
