import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restingQuantity } from "@workspace/core/events";
import { SqliteCatalog } from "./sqliteCatalog";
import { EventJournal } from "./eventJournal";
import { SnapshotStore } from "./snapshotStore";
import { F01_BOOK, at, mockConfig, mockEvidence } from "./storageFixtures";
export { F01_BOOK, at, mockConfig, mockEvidence };
export const DAY = 86_400_000_000_000n;
export const day = (n: number): string => (BigInt(at(0)) + BigInt(n) * DAY).toString();
const snapshot = F01_BOOK.events[0];
export const EIGHT_DAYS = {
  environment: "MOCK", fixtureId: "R15-EIGHT-DAYS", seed: 1508, expectedResultSchemaVersion: 1,
  dataKind: "NORMALIZED_MOCK_NOT_VENDOR_RAW",
  evidence: "Fixed MOCK equal exchange/receive UTC axes, daily covering snapshots and explicit channel continuity",
  nowNs: day(8), cutoffNs: day(1),
  events: [0n, DAY / 2n, ...Array.from({ length: 8 }, (_, i) => BigInt(i + 1) * DAY)].map((offset, i) => ({
    ...snapshot, bids: [{ priceTicks: 80000, qty: restingQuantity(i === 0 ? 40 : i === 1 ? 45 : 30 + i * 10) }],
    header: { ...snapshot.header, sessionId: "MOCK-R15-8D", eventId: `MOCK-R15-D${i}`,
      exchangeTimeNs: (BigInt(at(0)) + offset).toString(), receiveTimeNs: (BigInt(at(0)) + offset).toString(), sequence: String(i + 1) },
    snapshotCoversSequence: String(i + 1),
  })),
} as const;
export function withStore<T>(run: (s: {
  dir: string; catalog: SqliteCatalog; journal: EventJournal;
  scope: ReturnType<EventJournal["register"]>; snapshots: SnapshotStore;
}) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "orderflow-r15-test-"));
  const catalog = new SqliteCatalog(join(dir, "catalog.sqlite"));
  const journal = new EventJournal(catalog);
  const scope = journal.register(mockConfig(F01_BOOK.events[0]), at(0));
  try { return run({ dir, catalog, journal, scope, snapshots: new SnapshotStore(journal) }); }
  finally { catalog.close(); rmSync(dir, { recursive: true, force: true }); }
}
