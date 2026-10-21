import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restingQuantity, type L2Snapshot } from "@workspace/core/events";
import { readMbpLevel } from "@workspace/core/mbp-book";
import { calculateTimeWeightedDepth, type DepthRecord } from "@workspace/core/time-weighted-depth";
import { canonical, SqliteCatalog } from "./sqliteCatalog";
import { EventJournal, eventsIn } from "./eventJournal";
import { SnapshotStore, type ContinuityEvidence } from "./snapshotStore";
import {
  F01_BOOK, F07_SEQUENCE_GAP, STORAGE_60S, STORAGE_GAP_60S, at, mockConfig, mockEvidence,
} from "./storageFixtures";

const dirs: string[] = [], catalogs: SqliteCatalog[] = [];
function setup(snapshot: L2Snapshot = STORAGE_60S.events[0]) {
  const dir = mkdtempSync(join(tmpdir(), "orderflow-r14-snapshot-")); dirs.push(dir);
  const catalog = new SqliteCatalog(join(dir, "events.sqlite")); catalogs.push(catalog);
  const journal = new EventJournal(catalog);
  const scope = journal.register(mockConfig(snapshot), at(0));
  const snapshots = new SnapshotStore(journal);
  return { catalog, journal, scope, snapshots, proof: mockEvidence(scope, at(75)) };
}
afterEach(() => {
  for (const c of catalogs.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("captures exactly 80 at 60s with last market event at 30s; replays only 75s suffix to 100", () => {
  const { journal, scope, snapshots, proof } = setup();
  const before = canonical(STORAGE_60S);
  journal.append(scope.id, STORAGE_60S.events.slice(0, 2));
  const [capture] = snapshots.captureEvery60Seconds(scope.id, at(0), at(60), proof);
  expect(capture.captured).toBe(true);
  expect(capture.checkpoint).toMatchObject({
    checkpointNs: at(60), lastMarketEventNs: at(30), lastAppliedPosition: "2",
    lastAppliedEventId: STORAGE_60S.events[1].header.eventId, lastAppliedSequence: "2",
  });
  expect(readMbpLevel(capture.checkpoint!.state.lastGoodBook, "BID", 80000)).toMatchObject({ qty: 80 });
  journal.append(scope.id, [STORAGE_60S.events[2]]);
  const recovered = snapshots.recover(scope.id, at(75), proof);
  expect(readMbpLevel(recovered.book!, "BID", 80000)).toMatchObject({ qty: 100 });
  expect(recovered.replayedPositions).toEqual(["3"]);
  expect(recovered.checkpointNs).toBe(at(60));
  expect(canonical(STORAGE_60S)).toBe(before);
});
it("selects a historical prefix rather than substituting the latest board", () => {
  const { journal, scope, snapshots, proof } = setup(); journal.append(scope.id, STORAGE_60S.events);
  expect(readMbpLevel(snapshots.recover(scope.id, at(60), proof).book!, "BID", 80000)).toMatchObject({ qty: 80 });
  expect(readMbpLevel(snapshots.recover(scope.id, at(0)).book!, "BID", 80000)).toMatchObject({ qty: 40 });
  const captured = snapshots.capture(scope.id, at(60), proof);
  expect(captured.checkpoint?.lastMarketEventNs).toBe(at(30));
});
it("requires bounded continuity evidence beyond the final market event", () => {
  const { journal, scope, snapshots, proof } = setup(); journal.append(scope.id, STORAGE_60S.events.slice(0, 2));
  expect(snapshots.capture(scope.id, at(60))).toMatchObject({ captured: false, status: "UNOBSERVED" });
  expect(snapshots.capture(scope.id, at(60), { ...proof, endNs: at(59) }).captured).toBe(false);
  expect(snapshots.capture(scope.id, at(60), proof).captured).toBe(true);
  expect(snapshots.recover(scope.id, at(76)).book).toBeNull();
});
it.each([
  { scopeId: "foreign" }, { channel: "TRADES" }, { schemaVersion: 2 },
  { description: "" }, { clockMapping: "GUESS" }, { startNs: at(31) },
])("rejects invalid continuity evidence %j", patch => {
  const { journal, scope, snapshots, proof } = setup(); journal.append(scope.id, STORAGE_60S.events.slice(0, 2));
  expect(snapshots.capture(scope.id, at(60), { ...proof, ...patch } as ContinuityEvidence).captured).toBe(false);
});
it("does not publish after the proof endpoint", () => {
  const { journal, scope, snapshots, proof } = setup(); journal.append(scope.id, STORAGE_60S.events);
  expect(snapshots.recover(scope.id, at(76), proof)).toMatchObject({ status: "UNOBSERVED", book: null });
});
it("does not assume that detection timestamps equal event timestamps", () => {
  const { journal, scope, snapshots, proof } = setup();
  const event = { ...STORAGE_60S.events[0], header: {
    ...STORAGE_60S.events[0].header, receiveTimeNs: at(1) } };
  journal.append(scope.id, [event]);
  expect(snapshots.capture(scope.id, at(60), proof)).toMatchObject({
    captured: false, status: "UNVERIFIED_TIME_ALIGNMENT",
  });
});
it("refuses an event-time query that would reorder the audit input", () => {
  const { journal, scope, snapshots, proof } = setup();
  journal.append(scope.id, STORAGE_60S.events);
  journal.append(scope.id, [{ ...STORAGE_60S.events[1], header: {
    ...STORAGE_60S.events[1].header, eventId: "late-conflict", sequence: "4" } }]);
  expect(() => snapshots.recover(scope.id, at(60), proof)).toThrow(/NON_PREFIX_TIME_QUERY/);
});
it("never checkpoints the independent 60s GAP case", () => {
  const { journal, scope, snapshots, proof, catalog } = setup(STORAGE_GAP_60S.events[0]);
  journal.append(scope.id, STORAGE_GAP_60S.events);
  expect(snapshots.captureEvery60Seconds(scope.id, at(0), at(60), proof)[0])
    .toMatchObject({ captured: false, status: "GAP" });
  expect(catalog.manifest().snapshotCount).toBe("0");
});
it.each(["RESYNCING", "GAP", "STALE", "CLOSED", "OUTSIDE_DEPTH"] as const)(
  "never saves %s as a normal checkpoint", status => {
    const { journal, scope, snapshots, proof } = setup();
    journal.append(scope.id, [STORAGE_60S.events[0]]);
    journal.stage(scope.id, [{ type: "CONDITION", channel: "L2_MBP", status, atNs: at(10), reason: "fixed MOCK notification" }]).commit();
    expect(snapshots.capture(scope.id, at(60), proof)).toMatchObject({ captured: false, status });
  },
);
it("does not convert NOT_INITIALIZED to an empty full-depth board", () => {
  const { scope, snapshots, proof } = setup();
  expect(snapshots.capture(scope.id, at(60), proof)).toMatchObject({ captured: false, status: "NOT_INITIALIZED" });
});
it("keeps F07 GAP and only a new covering snapshot restores validity", () => {
  const { journal, scope, snapshots, proof } = setup(F07_SEQUENCE_GAP.events[0]);
  journal.append(scope.id, F07_SEQUENCE_GAP.events);
  expect(snapshots.recover(scope.id, at(4), proof)).toMatchObject({ status: "GAP", book: null });
  journal.append(scope.id, [F07_SEQUENCE_GAP.recovery]);
  const recovered = snapshots.recover(scope.id, at(6), proof);
  expect(recovered.status).toBe("VALID");
  expect(recovered.state.timeline.L2_MBP.some(q => q.status === "GAP")).toBe(true);
});
it.each([
  { type: "FULL" },
  { type: "TOP_N", n: 1 },
  { type: "PRICE_RANGE", minTick: 80000, maxTick: 80001 },
] as const)("preserves %j coverage, Bid/Ask, UNKNOWN, known zero and outside-depth", depthScope => {
  const snapshot: L2Snapshot = {
    ...STORAGE_60S.events[0], depthScope,
    bids: [{ priceTicks: 80000, qty: restingQuantity(0) }],
    asks: [{ priceTicks: 80000, qty: restingQuantity(10) }],
  };
  const { journal, scope, snapshots, proof } = setup(snapshot);
  journal.append(scope.id, [snapshot]); snapshots.capture(scope.id, at(60), proof);
  const b = snapshots.recover(scope.id, at(60), proof).book!;
  expect(b.depthScope).toEqual(depthScope);
  expect(readMbpLevel(b, "BID", 80000)).toMatchObject({ status: "KNOWN", qty: 0 });
  expect(readMbpLevel(b, "ASK", 80000)).toMatchObject({ status: "KNOWN", qty: 10 });
  expect(readMbpLevel(b, "BID", 80001).status).toBe(depthScope.type === "TOP_N" ? "OUTSIDE_DEPTH" : "UNKNOWN");
  if (depthScope.type === "PRICE_RANGE") expect(readMbpLevel(b, "BID", 80002).status).toBe("OUTSIDE_DEPTH");
});
it("round-trips F01 and produces 38 / 60,40,30,60,0 using unchanged R04", () => {
  const { journal, scope, snapshots } = setup(F01_BOOK.events[0]);
  journal.append(scope.id, F01_BOOK.events); snapshots.capture(scope.id, at(0));
  const recovered = snapshots.recover(scope.id, at(10), mockEvidence(scope, at(10)));
  const history = {
    events: journal.records(scope.id).flatMap(r => eventsIn(r.input)) as DepthRecord[],
    qualityState: recovered.state, qualityTimeAlignmentEvidence: "Fixed F01 equal exchange/receive UTC axes",
  };
  const twa = (a: number, b: number) => calculateTimeWeightedDepth(history, {
    side: "BID", priceTicks: 80000, width: 1, startNs: at(a), endNs: at(b),
  }).twa;
  expect(twa(0, 10)).toBe(38);
  expect([0, 2, 4, 6, 8].map(a => twa(a, a + 2))).toEqual([60, 40, 30, 60, 0]);
});
it("detects a corrupted checkpoint payload and refuses recovery", () => {
  const { journal, scope, snapshots, proof, catalog } = setup();
  journal.append(scope.id, STORAGE_60S.events.slice(0, 2)); snapshots.capture(scope.id, at(60), proof);
  catalog.database.exec("UPDATE snapshots SET payload=replace(payload,'LOCAL_MBP','BROKEN_MBP')");
  expect(() => snapshots.recover(scope.id, at(60), proof)).toThrow(/SNAPSHOT_CHECKSUM/);
});
it("detects missing checkpoints instead of silently falling back", () => {
  const { journal, scope, snapshots, proof, catalog } = setup();
  journal.append(scope.id, STORAGE_60S.events.slice(0, 2)); snapshots.capture(scope.id, at(60), proof);
  catalog.database.exec("DELETE FROM snapshots");
  expect(() => new SnapshotStore(journal)).toThrow(/SNAPSHOT_MANIFEST/);
});
it("keeps an old checkpoint valid when later input is appended", () => {
  const { journal, scope, snapshots, proof } = setup();
  journal.append(scope.id, STORAGE_60S.events.slice(0, 2)); snapshots.capture(scope.id, at(60), proof);
  journal.append(scope.id, [STORAGE_60S.events[2]]);
  expect(() => snapshots.verify()).not.toThrow();
});
