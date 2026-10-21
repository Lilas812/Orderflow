import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { withStore, EIGHT_DAYS, day, DAY, at, mockConfig, mockEvidence } from "./r15Fixtures";
import { anchors, indices, migrateToV2, segments, storageState } from "./storageMigration";
import { Retention, resumeRetention, retentionCutoff, type RetentionPhase } from "./retention";
import { SegmentWriter } from "./segmentWriter";
import { segmentPath } from "./segmentReader";
import { RangeQuery } from "./rangeQuery";
import { canonical } from "./sqliteCatalog";
import { EventJournal } from "./eventJournal";
import { SnapshotStore } from "./snapshotStore";
import { readMbpLevel } from "@workspace/core/mbp-book";
import { F04_TRADES } from "@workspace/fixtures";

it("calculates exactly seven UTC days in ns, without rounding", () => {
  expect(retentionCutoff((BigInt(day(8)) + 123n).toString())).toBe((BigInt(day(1)) + 123n).toString());
});
function seed(s: Parameters<Parameters<typeof withStore>[0]>[0]) {
  const { journal, snapshots } = s;
  const scope = journal.register(mockConfig(EIGHT_DAYS.events[0]), at(0));
  journal.append(scope.id, EIGHT_DAYS.events);
  snapshots.capture(scope.id, at(0));
  snapshots.capture(scope.id, (BigInt(at(0)) + 3n * DAY / 4n).toString(), mockEvidence(scope, day(8)));
  migrateToV2(journal);
  const writer = new SegmentWriter(journal);
  const expired = writer.write(scope.id, "L2_MBP", ["1"]);
  const crossing = writer.write(scope.id, "L2_MBP", ["2","3"]);
  const current = writer.write(scope.id, "L2_MBP", ["4","5","6","7","8","9","10"]);
  for (const info of [expired, crossing, current]) writer.releaseSqliteCopies(info);
  return { scope, writer, expired, crossing, current };
}
it("expires only completed pre-cutoff chunks, preserves cutoff and crossing chunk", () => withStore(s => {
  const { scope, expired, crossing } = seed(s);
  const q = new RangeQuery(s.journal, s.snapshots);
  const before = q.query(scope.id, "L2_MBP", day(1), day(8), mockEvidence(scope, day(8)));
  expect(before.events).toHaveLength(7);
  expect(new Retention(s.journal, () => day(8)).run().deleted).toBe(1);
  expect(existsSync(segmentPath(s.catalog, expired))).toBe(false);
  expect(existsSync(segmentPath(s.catalog, crossing))).toBe(true);
  expect(indices(s.catalog)[0].position).toBe("2");
  expect(storageState(s.catalog).floorPosition).toBe("1");
  const after = new RangeQuery(s.journal, new SnapshotStore(s.journal)).query(scope.id, "L2_MBP", day(1), day(8), mockEvidence(scope, day(8)));
  expect(after.events).toEqual(before.events);
  expect(after.status).toBe("VALID");
  expect(after.initialBook && readMbpLevel(after.initialBook, "BID", 80000)).toMatchObject({ qty: 50 });
  expect(after.events[0].header.exchangeTimeNs).toBe(day(1));
  expect(new Retention(s.journal, () => day(8)).run().deleted).toBe(0);
}));
it("protects only necessary MOCK seed state, not expired raw fingerprints", () => withStore(s => {
  const { scope } = seed(s);
  new Retention(s.journal, () => day(8)).run();
  const a = anchors(s.catalog).find(a => a.scopeId === scope.id)!;
  expect(a.kind).toBe("RETENTION_STATE_NOT_EXCHANGE_SNAPSHOT");
  expect(a.precedingCheckpoint).not.toBeNull();
  expect([...a.state.guard.seen.values()].some(fp => fp.includes('"eventId":"MOCK-R15-D0"'))).toBe(false);
  expect(() => new RangeQuery(s.journal, s.snapshots).query(scope.id, "L2_MBP", at(0), day(1))).toThrow("OUTSIDE_RETENTION");
  expect(() => s.journal.append(scope.id, [EIGHT_DAYS.events[0]])).toThrow("EXPIRED_INPUT");
}));
it.each(["after-intent", "after-unlink", "before-final-commit"] as RetentionPhase[])(
  "resumes idempotently after %s without corruption false positives", phase => withStore(s => {
    const { scope } = seed(s);
    expect(() => new Retention(s.journal, () => day(8)).run(p => {
      if (p === phase) throw new Error("forced interruption");
    })).toThrow("forced interruption");
    expect(() => new EventJournal(s.catalog)).toThrow("RETENTION_PENDING");
    expect(resumeRetention(s.catalog).deleted).toBe(1);
    expect(resumeRetention(s.catalog).deleted).toBe(0);
    const fresh = new EventJournal(s.catalog); new SnapshotStore(fresh);
    expect(new RangeQuery(fresh).query(scope.id, "L2_MBP", day(1), day(8), mockEvidence(scope, day(8))).events).toHaveLength(7);
  }));
it("detects genuinely missing retained index rows, not authorized prefix deletion", () => withStore(s => {
  seed(s); new Retention(s.journal, () => day(8)).run();
  expect(() => s.journal.verify()).not.toThrow();
  s.catalog.database.prepare("DELETE FROM r15_records WHERE position=5").run();
  expect(() => s.journal.verify()).toThrow("CATALOG_MANIFEST");
}));
it("preserves global committed positions and can append after boundary deletion", () => withStore(s => {
  const { scope } = seed(s);
  new Retention(s.journal, () => day(8)).run();
  const event = EIGHT_DAYS.events.at(-1)!;
  const next = { ...event, header: { ...event.header, eventId: "MOCK-R15-NEXT", sequence: "11",
    exchangeTimeNs: day(9), receiveTimeNs: day(9) }, snapshotCoversSequence: "11" };
  expect(s.journal.append(scope.id, [next]).lastPosition).toBe("11");
  expect(s.catalog.manifest().recordCount).toBe("11");
  expect(() => s.journal.verify()).not.toThrow();
}));
it("does not move cutoff backwards or delete unfinalized SQL-only originals", () => withStore(s => {
  const { scope } = seed(s);
  new Retention(s.journal, () => day(8)).run();
  const before = canonical(s.journal.records());
  expect(() => new Retention(s.journal, () => day(7)).run()).toThrow("CLOCK_BACKWARDS");
  expect(canonical(s.journal.records())).toBe(before);
  expect(segments(s.catalog).filter(s => s.finalizationStatus === "DELETED")).toHaveLength(1);
}));
it("can remove unrelated expired chunks beyond a protected/crossing dependency", () => withStore(s => {
  seed(s);
  const config = mockConfig(EIGHT_DAYS.events[0]);
  const trades = s.journal.register({ ...config, identity: {
    ...config.identity, sessionId: F04_TRADES.events[0].header.sessionId,
  } }, F04_TRADES.expected.startNs);
  s.journal.append(trades.id, F04_TRADES.events);
  const chunk = new SegmentWriter(s.journal).write(trades.id, "TRADES", ["11","12","13"]);
  expect(new Retention(s.journal, () => day(8)).run().deleted).toBe(2);
  expect(existsSync(segmentPath(s.catalog, chunk))).toBe(false);
  expect(storageState(s.catalog).retiredPositions).toEqual(["11","12","13"]);
  expect(() => s.journal.verify()).not.toThrow();
  expect(s.journal.records(trades.id)).toEqual([]);
  expect(new RangeQuery(s.journal).query(trades.id, "TRADES", day(1), day(2))).toMatchObject({ events: [], status: "NO DATA" });
  // Proof deletion is itself detected, not mistaken for legitimate TTL expiry.
  s.catalog.database.prepare("DELETE FROM r15_records WHERE position=12").run();
  expect(() => s.journal.verify()).toThrow("CATALOG_MANIFEST");
}));
it("keeps a quality interval crossing cutoff, even when its start is expired", () => withStore(s => {
  const scope = s.journal.register(mockConfig(EIGHT_DAYS.events[0]), at(0));
  const start = (BigInt(at(0))+9n*DAY/10n).toString();
  const end = (BigInt(day(1))+DAY/10n).toString();
  s.journal.stage(scope.id, [{ type: "QUALITY_INTERVAL", interval: {
    channel: "TRADES", status: "GAP", startNs: start, endNs: end, reason: "Explicit MOCK crossing quality interval",
  }, observedAtNs: start }]).commit();
  migrateToV2(s.journal);
  const chunk = new SegmentWriter(s.journal).write(scope.id, "TRADES", ["1"]);
  expect(new Retention(s.journal, () => day(8)).run().deleted).toBe(0);
  expect(existsSync(segmentPath(s.catalog, chunk))).toBe(true);
  expect(new RangeQuery(s.journal).query(scope.id, "TRADES", day(1), end)).toMatchObject({ status: "NO DATA", events: [] });
}));
it("does not promote a pre-cutoff GAP into a normal snapshot", () => withStore(s => {
  const scope = s.journal.register(mockConfig(EIGHT_DAYS.events[0]), at(0));
  s.journal.append(scope.id, [EIGHT_DAYS.events[0]]);
  s.snapshots.capture(scope.id, at(0));
  s.journal.stage(scope.id, [{ type: "CONDITION", channel: "L2_MBP", status: "GAP",
    atNs: (BigInt(at(0))+DAY/2n).toString(), reason: "Known MOCK gap across cutoff" }]).commit();
  const recovery = { ...EIGHT_DAYS.events[3], header: {
    ...EIGHT_DAYS.events[3].header, sequence: "2" }, snapshotCoversSequence: "2" };
  s.journal.append(scope.id, [recovery]); migrateToV2(s.journal);
  const w = new SegmentWriter(s.journal);
  w.write(scope.id, "L2_MBP", ["1","2"]); w.write(scope.id, "L2_MBP", ["3"]);
  new Retention(s.journal, () => day(8)).run();
  const q = new RangeQuery(s.journal);
  expect(q.query(scope.id, "L2_MBP", day(1), day(2), mockEvidence(scope, day(8)))).toMatchObject({ initialBook: null, status: "NO DATA" });
  expect(new SnapshotStore(s.journal).capture(scope.id, day(1), mockEvidence(scope, day(8))).captured).toBe(false);
}));
