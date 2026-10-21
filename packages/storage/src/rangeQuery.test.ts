import { expect, it } from "vitest";
import { unlinkSync } from "node:fs";
import { F03_GAP_TWA, F04_TRADES } from "@workspace/fixtures";
import { withStore, F01_BOOK, at, mockConfig, mockEvidence } from "./r15Fixtures";
import { migrateToV2, segments } from "./storageMigration";
import { SegmentWriter } from "./segmentWriter";
import { segmentPath } from "./segmentReader";
import { RangeQuery } from "./rangeQuery";
import { readMbpLevel } from "@workspace/core/mbp-book";

it("feeds unchanged R04: 38 and five 2s TWA bins, SQL/chunk/both", () => withStore(({ journal, scope, snapshots }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  const query = new RangeQuery(journal, snapshots), proof = mockEvidence(scope, at(10));
  const writer = new SegmentWriter(journal);
  for (const mode of ["SQL", "both", "chunk"]) {
    if (mode === "both") writer.write(scope.id, "L2_MBP", ["1","2","3","4","5"]);
    if (mode === "chunk") writer.releaseSqliteCopies(segments(journal.catalog)[0]);
    expect(query.depth(scope.id, { side: "BID", priceTicks: 80000, width: 1, startNs: at(0), endNs: at(10) }, proof).twa).toBe(38);
    expect([0,2,4,6,8].map(t => query.depth(scope.id, {
      side: "BID", priceTicks: 80000, width: 1, startNs: at(t), endNs: at(t+2),
    }, proof).twa)).toEqual([60,40,30,60,0]);
  }
}));
it("uses preceding checkpoint and only related chunks; visible events stay half-open", () => withStore(({ journal, scope, snapshots }) => {
  journal.append(scope.id, F01_BOOK.events);
  snapshots.capture(scope.id, at(3)); migrateToV2(journal);
  const writer = new SegmentWriter(journal);
  const old = writer.write(scope.id, "L2_MBP", ["1","2","3"]);
  const next = writer.write(scope.id, "L2_MBP", ["4","5"]);
  const result = new RangeQuery(journal, snapshots).query(scope.id, "L2_MBP", at(4), at(8), mockEvidence(scope, at(10)));
  expect(result.faults).toEqual([]);
  expect(result.checkpointNs).toBe(at(3));
  expect(result.events.map(e => e.header.eventId)).toEqual([F01_BOOK.events[3].header.eventId]);
  expect(result.filesRead).toEqual([next.segmentId]); expect(result.filesRead).not.toContain(old.segmentId);
  expect(result.initialBook && readMbpLevel(result.initialBook, "BID", 80000)).toMatchObject({ qty: 0 });
}));
it.each([[2,2],[3,2]])("rejects invalid UTC range %j", (a,b) => withStore(({ journal, scope, snapshots }) => {
  migrateToV2(journal);
  expect(() => new RangeQuery(journal, snapshots).query(scope.id, "L2_MBP", at(a), at(b))).toThrow("INVALID_RANGE");
}));
it("keeps sources, sessions and Trade/MBP channels separate", () => withStore(({ journal, scope, snapshots }) => {
  journal.append(scope.id, F01_BOOK.events);
  const trades = journal.register({ ...mockConfig(F01_BOOK.events[0]), identity: {
    ...mockConfig(F01_BOOK.events[0]).identity, sessionId: F04_TRADES.events[0].header.sessionId,
  } }, F04_TRADES.expected.startNs);
  journal.append(trades.id, F04_TRADES.events); migrateToV2(journal);
  const q = new RangeQuery(journal, snapshots);
  expect(q.query(trades.id, "TRADES", F04_TRADES.expected.startNs, F04_TRADES.expected.endNs).events).toEqual(F04_TRADES.events);
  expect(q.query(trades.id, "L2_MBP", F04_TRADES.expected.startNs, F04_TRADES.expected.endNs).events).toEqual([]);
  expect(q.query(scope.id, "TRADES", at(0), at(10)).events).toEqual([]);
  expect(() => q.query("foreign-source", "TRADES", at(0), at(10))).toThrow("UNKNOWN_SCOPE");
}));
it("preserves F03 GAP, known zero, 50% coverage and NO DATA", () => withStore(({ journal, snapshots }) => {
  const scope = journal.register(mockConfig(F03_GAP_TWA.events[0]), at(8));
  journal.append(scope.id, [F03_GAP_TWA.events[0]]);
  journal.stage(scope.id, [{ type: "CONDITION", channel: "L2_MBP", status: "GAP", atNs: at(9), reason: "F03 declared exact MOCK gap" }]).commit();
  journal.append(scope.id, [F03_GAP_TWA.events[1]]); migrateToV2(journal);
  const q = new RangeQuery(journal, snapshots);
  expect(q.depth(scope.id, { side: "BID", priceTicks: 80000, width: 1, startNs: at(8), endNs: at(12) },
    { ...mockEvidence(scope, at(12)), description: F03_GAP_TWA.timeAlignmentEvidence })).toMatchObject({
    twa: null, partialTWA: 35, coverageRatio: 0.5, status: "NO DATA",
  });
  expect(q.query(scope.id, "L2_MBP", at(8), at(12), mockEvidence(scope, at(12))).status).toBe("NO DATA");
}));
it("returns explicit NO DATA instead of falling back over a missing finalized chunk", () => withStore(({ journal, scope, snapshots, catalog }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  const query = new RangeQuery(journal, snapshots);
  const s = new SegmentWriter(journal).write(scope.id, "L2_MBP", ["1","2","3","4","5"]);
  unlinkSync(segmentPath(catalog, s));
  const result = query.query(scope.id, "L2_MBP", at(0), at(10));
  expect(result.status).toBe("NO DATA"); expect(result.events).toEqual([]);
  expect(result.faults[0]).toContain("SEGMENT_MISSING");
}));
it("does not accept an unrelated scope's clock evidence", () => withStore(({ journal, scope, snapshots }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  expect(new RangeQuery(journal, snapshots).depth(scope.id, { side: "BID", priceTicks: 80000,
    width: 1, startNs: at(0), endNs: at(10) }, { ...mockEvidence(scope, at(10)), scopeId: "foreign" }).status).toBe("NO DATA");
}));
