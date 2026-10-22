import { expect, it } from "vitest";
import { restingQuantity } from "@workspace/core/events";
import { createSequenceGuard, guardEvent, type SequenceGuard } from "@workspace/core/sequence-guard";
import { createMarketQualityState, ingestMarketEvent, ingestMbpBatch } from "@workspace/core/quality-timeline";
import { F01_BOOK, mockConfig, at } from "../storageFixtures";
import { checksum } from "../sqliteCatalog";
import { encodeIdentity } from "./identityCodec";
import { PendingBranch } from "./pendingBranch";
import type { LedgerSnapshot } from "./historicalLedgerView";

function branch(seen: ReadonlyMap<string, string> = new Map(), through = { position: "0", ordinal: 0 }) {
  const detached = new Map(seen);
  const snapshot: LedgerSnapshot = { namespace: "TEST", scopeId: encodeIdentity(F01_BOOK.events[0]).scopeId,
    epoch: "E1", coverage: "FULL_SCOPE_FROM_START", evidence: "Complete fixed MOCK prefix",
    through, count: seen.size, bytes: 0, root: checksum([...seen]), seed: null };
  return new PendingBranch({ snapshot, get: k => detached.get(k), materializeNative: () => new Map(detached) });
}
it("matches independent adopted guard Map for all F01 inputs, duplicates and conflicts", () => {
  const p = branch(); let oracle = createSequenceGuard();
  const events = [...F01_BOOK.events, F01_BOOK.events[1], { ...F01_BOOK.events[1], qty: restingQuantity(81) }];
  for (const [i, event] of events.entries()) {
    const expected = guardEvent(oracle, event); oracle = expected.state;
    p.stage([event], oracle, { position: String(i + 1), ordinal: 0 });
    expect([...p.materializeNative()]).toEqual([...oracle.seen]);
  }
  expect(p.seal().inserts).toHaveLength(5);
  expect(p.get(encodeIdentity(F01_BOOK.events[1]).key)).toBe(encodeIdentity(F01_BOOK.events[1]).fingerprint);
});
it.each(["OLD", "GAP"])("retains actual %s adopted insert even when apply=false", outcome => {
  const p = branch(), first = guardEvent(createSequenceGuard(), F01_BOOK.events[0], { contiguous: true, evidence: "MOCK" });
  p.stage([F01_BOOK.events[0]], first.state, { position: "1", ordinal: 0 });
  const event = { ...F01_BOOK.events[1], header: { ...F01_BOOK.events[1].header,
    sequence: outcome === "OLD" ? "1" : "4", eventId: `MOCK-${outcome}` } };
  const expected = guardEvent(first.state, event, { contiguous: true, evidence: "MOCK" });
  expect(expected.outcome).toBe(outcome); expect(expected.apply).toBe(false);
  p.stage([event], expected.state, { position: "2", ordinal: 0 });
  expect([...p.materializeNative()]).toEqual([...expected.state.seen]);
  expect(p.seal().inserts).toHaveLength(2);
});
it("retains QUALITY_REJECTED insert from the actually adopted quality guard", () => {
  const p = branch();
  let state = ingestMarketEvent(createMarketQualityState(mockConfig(F01_BOOK.events[0]), at(0)), F01_BOOK.events[0]).state;
  p.stage([F01_BOOK.events[0]], state.guard, { position: "1", ordinal: 0 });
  const event = { ...F01_BOOK.events[1], header: { ...F01_BOOK.events[1].header, quality: "SUSPECT" as const } };
  const expected = ingestMarketEvent(state, event);
  expect(expected.outcome).toBe("QUALITY_REJECTED"); expect(expected.applied).toBe(false);
  p.stage([event], expected.state.guard, { position: "2", ordinal: 0 });
  expect([...p.materializeNative()]).toEqual([...expected.state.guard.seen]);
});
it("drops speculative Snapshot insert after later book rejection", () => {
  const event = { ...F01_BOOK.events[0], bids: [F01_BOOK.events[0].bids[0], F01_BOOK.events[0].bids[0]] };
  const before = createMarketQualityState(mockConfig(F01_BOOK.events[0]), at(0));
  const result = ingestMarketEvent(before, event);
  expect(result.outcome).toBe("RESYNC_REJECTED");
  const p = branch(); p.stage([event], result.state.guard, { position: "1", ordinal: 0 });
  expect([...p.materializeNative()]).toEqual([...before.guard.seen]); expect(p.seal().inserts).toEqual([]);
});
it("does not roll back an entire mixed duplicate batch", () => {
  const state = ingestMarketEvent(createMarketQualityState(mockConfig(F01_BOOK.events[0]), at(0)), F01_BOOK.events[0]).state;
  const p = branch(state.guard.seen, { position: "1", ordinal: 0 });
  const first = F01_BOOK.events[1], second = { ...first, header: { ...first.header, eventId: "MOCK-batch-new", sequence: "3" } };
  const inputs = [first, first, second];
  const expected = ingestMbpBatch(state, inputs);
  // Existing R03 rejects book publication for a partial duplicate batch, but
  // deliberately adopts the processed guard IDs. Do NOT roll back that guard.
  expect(expected.outcome).toBe("BATCH_REJECTED");
  expect(expected.applied).toBe(false);
  p.stage(inputs, expected.state.guard, { position: "2", ordinal: 0 });
  expect([...p.materializeNative()]).toEqual([...expected.state.guard.seen]);
  expect(p.seal().inserts.map(e => e.first)).toEqual([{ position: "2", ordinal: 0 }, { position: "2", ordinal: 2 }]);
});
it("rollback restores insertion order/fingerprint and detaches external Maps and sealed arrays", () => {
  const external = new Map<string, string>(), p = branch(external);
  const root = p.mark(), a = guardEvent(createSequenceGuard(), F01_BOOK.events[0]);
  p.stage([F01_BOOK.events[0]], a.state, { position: "1", ordinal: 0 });
  const inner = p.mark(), b = guardEvent(a.state, F01_BOOK.events[1]);
  p.stage([F01_BOOK.events[1]], b.state, { position: "2", ordinal: 0 });
  p.rollback(inner); expect([...p.materializeNative()]).toEqual([...a.state.seen]);
  p.stage([F01_BOOK.events[2]], guardEvent(a.state, F01_BOOK.events[2]).state, { position: "2", ordinal: 0 });
  expect([...p.materializeNative().keys()]).toEqual([encodeIdentity(F01_BOOK.events[0]).key, encodeIdentity(F01_BOOK.events[2]).key]);
  p.seal().inserts[0].fingerprint = "tampered";
  expect(p.get(encodeIdentity(F01_BOOK.events[0]).key)).toBe(encodeIdentity(F01_BOOK.events[0]).fingerprint);
  p.rollback(root); expect(p.materializeNative().size).toBe(0); expect(external.size).toBe(0);
  expect(() => p.rollback(root)).toThrow("BRANCH");
});
it("pending lookup takes precedence without consulting durable storage", () => {
  let calls = 0;
  const snapshot = branch().seal().base;
  const p = new PendingBranch({ snapshot, get: () => { calls++; return undefined; }, materializeNative: () => new Map() });
  const first = guardEvent(createSequenceGuard(), F01_BOOK.events[0]);
  p.stage([F01_BOOK.events[0]], first.state, { position: "1", ordinal: 0 });
  const before = calls; expect(p.get(encodeIdentity(F01_BOOK.events[0]).key)).toBe([...first.state.seen.values()][0]);
  expect(calls).toBe(before);
});
it("rejects adopted overwrite/reorder/foreign insertion atomically", () => {
  const p = branch(), a = guardEvent(createSequenceGuard(), F01_BOOK.events[0]);
  p.stage([F01_BOOK.events[0]], a.state, { position: "1", ordinal: 0 });
  const key = encodeIdentity(F01_BOOK.events[0]).key;
  const invalid: SequenceGuard = { heads: a.state.heads, seen: new Map([[key, "forged"]]) };
  expect(() => p.stage([F01_BOOK.events[1]], invalid, { position: "2", ordinal: 0 })).toThrow("ADOPTION");
  expect([...p.materializeNative()]).toEqual([...a.state.seen]);
});
it("accepts 128 attempted events exactly and refuses 129, including duplicate inputs", () => {
  const p = branch(), oracle = guardEvent(createSequenceGuard(), F01_BOOK.events[0]).state;
  for (let i = 1; i <= 128; i++) p.stage([F01_BOOK.events[0]], oracle, { position: String(i), ordinal: 0 });
  expect(p.seal().inserts).toHaveLength(1);
  expect(() => p.stage([F01_BOOK.events[0]], oracle, { position: "129", ordinal: 0 })).toThrow("BUDGET_EXCEEDED");
});
it("refuses serialized input over 8 MiB, unknown coverage, and cursor gaps", () => {
  const p = branch();
  const large = { ...F01_BOOK.events[0], padding: "x".repeat(8 * 1024 * 1024) };
  expect(() => p.stage([large], createSequenceGuard(), { position: "1", ordinal: 0 })).toThrow("BUDGET_EXCEEDED");
  const snapshot = branch().seal().base; snapshot.coverage = "UNPROVEN";
  expect(() => new PendingBranch({ snapshot, get: () => undefined, materializeNative: () => new Map() })).toThrow("COVERAGE_UNPROVEN");
  expect(() => p.stage([F01_BOOK.events[0]], createSequenceGuard(), { position: "3", ordinal: 0 })).toThrow("CURSOR");
});
it("does not mutate a borrowed external base Map or retain the adopted Map alias", () => {
  const first = guardEvent(createSequenceGuard(), F01_BOOK.events[0]), external = new Map(first.state.seen);
  const snapshot = branch(external, { position: "1", ordinal: 0 }).seal().base;
  const p = new PendingBranch({ snapshot, get: k => external.get(k), materializeNative: () => external });
  const second = guardEvent(first.state, F01_BOOK.events[1]);
  p.stage([F01_BOOK.events[1]], second.state, { position: "2", ordinal: 0 });
  const detached = p.materializeNative();
  expect(external.size).toBe(1); expect(detached.size).toBe(2);
  (second.state.seen as Map<string, string>).clear();
  detached.clear();
  expect(p.materializeNative().size).toBe(2);
});
it("rejects a stale sibling branch mark rather than restoring the wrong insertion prefix", () => {
  const p = branch(), empty = p.mark();
  const a = guardEvent(createSequenceGuard(), F01_BOOK.events[0]);
  p.stage([F01_BOOK.events[0]], a.state, { position: "1", ordinal: 0 });
  const stale = p.mark(); p.rollback(empty);
  const b = guardEvent(createSequenceGuard(), F01_BOOK.events[1]);
  p.stage([F01_BOOK.events[1]], b.state, { position: "1", ordinal: 0 });
  expect(() => p.rollback(stale)).toThrow("BRANCH");
  expect([...p.materializeNative()]).toEqual([...b.state.seen]);
});
it("limits rollback marks and counts rejected branches against event capacity", () => {
  const p = branch();
  for (let i = 0; i < 128; i++) p.mark();
  expect(() => p.mark()).toThrow("BUDGET_EXCEEDED");
  const q = branch(), oracle = guardEvent(createSequenceGuard(), F01_BOOK.events[0]);
  for (let i = 0; i < 128; i++) {
    const mark = q.mark();
    q.stage([F01_BOOK.events[0]], oracle.state, { position: "1", ordinal: 0 }); q.rollback(mark);
  }
  expect(q.seal().inserts).toHaveLength(0);
  expect(() => q.stage([F01_BOOK.events[0]], oracle.state, { position: "1", ordinal: 0 })).toThrow("BUDGET_EXCEEDED");
});
it("refuses an escaped-input byte overflow without allocating the full escaped JSON", () => {
  const p = branch();
  const large = { ...F01_BOOK.events[0], padding: "\u0001".repeat(1_500_000) };
  expect(() => p.stage([large], createSequenceGuard(), { position: "1", ordinal: 0 })).toThrow("BUDGET_EXCEEDED");
  expect(p.seal().inserts).toEqual([]);
});
it("discarded later Snapshot cannot remove earlier adopted IDs", () => {
  const p = branch();
  const state = ingestMarketEvent(createMarketQualityState(mockConfig(F01_BOOK.events[0]), at(0)), F01_BOOK.events[0]).state;
  p.stage([F01_BOOK.events[0]], state.guard, { position: "1", ordinal: 0 });
  const bad = { ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header, eventId: "bad-later-snapshot",
    sequence: "8", receiveTimeNs: at(9), exchangeTimeNs: at(9) }, snapshotCoversSequence: "8",
  bids: [F01_BOOK.events[0].bids[0], F01_BOOK.events[0].bids[0]] };
  const rejected = ingestMarketEvent(state, bad);
  expect(rejected.outcome).toBe("RESYNC_REJECTED");
  p.stage([bad], rejected.state.guard, { position: "2", ordinal: 0 });
  expect([...p.materializeNative()]).toEqual([...state.guard.seen]);
});
