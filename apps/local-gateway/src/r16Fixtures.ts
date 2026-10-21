import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { F01_BOOK } from "@workspace/fixtures";
import { restingQuantity, type MarketEvent } from "@workspace/core/events";
import type { MarketQualityConfig } from "@workspace/core/quality-timeline";

export const FIXTURE = Object.freeze({
  environment: "MOCK", fixtureId: "R16-BOUNDED-INGEST", seed: 1610, expectedResultSchemaVersion: 1,
  description: "Deterministic test inputs, not NQ market rates or vendor data",
  baseNs: "1767225600000000000",
  expected: { deliveries: 1010, unique: 1000, duplicates: 10, applied: 1000, persistedUnique: 1000, finalBidQty: 40 },
});
export const ns = (index: number): string => (BigInt(FIXTURE.baseNs)+BigInt(index)*1_000_000n).toString();
export function eventAt(index: number, rate = 1000): MarketEvent {
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(rate) || rate <= 0) throw new TypeError("Fixture index/rate");
  const snapshot = F01_BOOK.events[0];
  const time = (BigInt(FIXTURE.baseNs)+BigInt(index)*1_000_000_000n/BigInt(rate)).toString();
  const header = { ...snapshot.header, sessionId: "MOCK-R16", eventId: `MOCK-R16-${index}`,
    exchangeTimeNs: time, receiveTimeNs: time, sequence: String(index+1) };
  return index === 0 ? { ...snapshot, header, snapshotCoversSequence: "1" } : {
    kind: "L2_SET_LEVEL", header, side: "BID", priceTicks: 80000, qty: restingQuantity(40+index%3),
  };
}
export function recoveryAt(index: number): MarketEvent {
  const first = F01_BOOK.events[0], h = eventAt(index).header;
  return { ...first, header: { ...h, eventId: `MOCK-R16-RECOVERY-${index}` }, snapshotCoversSequence: h.sequence };
}
export function deterministicDeliveries(): MarketEvent[] {
  const unique = Array.from({ length: 1000 }, (_, i) => eventAt(i));
  return [...unique, ...unique.slice(0,10)];
}
export function config(): MarketQualityConfig {
  const h = eventAt(0).header, rule = {
    scope: "CHANNEL", continuity: { contiguous: true, evidence: "R16 MOCK explicit +1 independently per channel" },
  } as const;
  return {
    identity: { environment: h.environment, source: h.source, sourceId: h.sourceId,
      canonicalInstrumentId: h.canonicalInstrumentId, sessionId: h.sessionId },
    depthScope: F01_BOOK.events[0].depthScope, rules: { L1: rule, L2_MBP: rule, TRADES: rule },
    snapshotAlignmentEvidence: "R16 MOCK snapshot sequence equals snapshotCoversSequence",
  };
}
export function ownedDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "orderflow-r16-"));
  writeFileSync(join(dir,"owned.r16"), "R16 MOCK TEST ONLY", { mode: 0o600 }); return dir;
}
export function requireOwnedDirectory(dir: string): void {
  if (readFileSync(join(dir,"owned.r16"),"utf8") !== "R16 MOCK TEST ONLY") throw new Error("Not an owned R16 test directory");
}
export const removeOwnedDirectory = (dir: string): void => {
  requireOwnedDirectory(dir); rmSync(dir, { recursive: true, force: true });
};
