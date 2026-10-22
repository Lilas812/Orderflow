import { expect, it } from "vitest";
import { createSequenceGuard, guardEvent } from "@workspace/core/sequence-guard";
import { F01_BOOK } from "../storageFixtures";
import { checksum } from "../sqliteCatalog";
import { encodeIdentity } from "./identityCodec";
import { HistoricalLedgerView, compareCursor, type Cursor, type LedgerEntry, type LedgerPort,
  type LedgerSnapshot } from "./historicalLedgerView";

function history() {
  let state = createSequenceGuard();
  const states = [state], entries: LedgerEntry[] = [];
  for (const [i, event] of F01_BOOK.events.entries()) {
    const next = guardEvent(state, event);
    for (const [key, fingerprint] of next.state.seen) if (!state.seen.has(key)) {
      entries.push({ key, fingerprint, first: { position: String(Math.floor(i / 2) + 1), ordinal: i % 2 },
        insertOrder: entries.length + 1, namespace: "TEST", scopeId: encodeIdentity(event).scopeId, firstEpoch: "E1" });
    }
    state = next.state; states.push(state);
  }
  const snapshot: LedgerSnapshot = { namespace: "TEST", scopeId: entries[0].scopeId, epoch: "E1",
    coverage: "FULL_SCOPE_FROM_START", evidence: "Complete fixed MOCK from scope start",
    through: { position: "3", ordinal: 0 }, count: entries.length, bytes: 0, root: checksum(entries), seed: null };
  const port: LedgerPort = { snapshot: () => structuredClone(snapshot),
    entry: key => structuredClone(entries.find(e => e.key === key)),
    entries: () => structuredClone(entries) };
  return { entries, states, snapshot, port };
}
it.each([0, 1, 2, 3, 4])("historical cursor %s matches independent Native Map BEFORE and AFTER input", i => {
  const h = history(), cursor = h.entries[i].first;
  const before = new HistoricalLedgerView(h.port, cursor, { epoch: "E1" });
  const after = new HistoricalLedgerView(h.port, cursor, { epoch: "E1" }, true);
  expect(before.materializeNative()).toEqual(h.states[i].seen);
  expect(after.materializeNative()).toEqual(h.states[i + 1].seen);
  expect(before.get(h.entries[i].key)).toBeUndefined();
  expect(after.get(h.entries[i].key)).toBe(h.entries[i].fingerprint);
  expect(before.materializeNative() instanceof Map).toBe(true);
});
it("never consults final ledger entries as if visible at the first replay event", () => {
  const h = history(), first = new HistoricalLedgerView(h.port, h.entries[0].first, { epoch: "E1" });
  expect(first.materializeNative().size).toBe(0);
  expect(first.get(h.entries.at(-1)!.key)).toBeUndefined();
});
it("uses journal cursor, not exchange time, for a delayed new event", () => {
  const h = history();
  const late = { ...F01_BOOK.events[1], header: { ...F01_BOOK.events[1].header,
    eventId: "late-new-id", exchangeTimeNs: "1", sequence: "999" } };
  const oracle = guardEvent(h.states.at(-1)!, late);
  expect(oracle.outcome).toBe("OLD");
  const pair = [...oracle.state.seen].at(-1)!;
  h.entries.push({ ...h.entries[0], key: pair[0], fingerprint: pair[1], first: { position: "4", ordinal: 0 }, insertOrder: 6 });
  h.snapshot.through = { position: "4", ordinal: 0 };
  expect(new HistoricalLedgerView(h.port, { position: "3", ordinal: 0 }, { epoch: "E1" }, true).get(pair[0])).toBeUndefined();
  expect(new HistoricalLedgerView(h.port, { position: "4", ordinal: 0 }, { epoch: "E1" }, true).get(pair[0])).toBe(pair[1]);
});
it("seed visibility is explicitly bound to anchor and epoch, not an empty Map fallback", () => {
  const h = history(), through = h.entries[1].first;
  h.snapshot.seed = { id: "seed", anchorId: "anchor", epoch: "E1", through, entriesRoot: checksum(h.entries.slice(0, 2)) };
  const view = new HistoricalLedgerView(h.port, through, { epoch: "E1", seedId: "seed", anchorId: "anchor" });
  expect(view.materializeNative()).toEqual(h.states[2].seen);
  expect(() => new HistoricalLedgerView(h.port, through, { epoch: "E1" })).toThrow("SEED_BINDING");
  expect(() => new HistoricalLedgerView(h.port, h.entries[0].first,
    { epoch: "E1", seedId: "seed", anchorId: "anchor" })).toThrow("BEFORE_SEED");
});
it("stops for wrong epoch, insufficient coverage, future cursor and foreign scope", () => {
  const h = history(), cursor = h.entries[0].first;
  expect(() => new HistoricalLedgerView(h.port, cursor, { epoch: "E2" })).toThrow("EPOCH_MISMATCH");
  expect(() => new HistoricalLedgerView(h.port, { position: "9", ordinal: 0 }, { epoch: "E1" })).toThrow("COVERAGE_UNPROVEN");
  const v = new HistoricalLedgerView(h.port, cursor, { epoch: "E1" });
  const foreign = encodeIdentity({ ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header, sessionId: "foreign" } }).key;
  expect(() => v.get(foreign)).toThrow("SCOPE_MISMATCH");
  h.snapshot.coverage = "UNPROVEN";
  expect(() => new HistoricalLedgerView(h.port, cursor, { epoch: "E1" })).toThrow("COVERAGE_UNPROVEN");
});
it("Native Map materialization has no caller alias", () => {
  const h = history(), view = new HistoricalLedgerView(h.port, h.snapshot.through, { epoch: "E1" }, true);
  const m = view.materializeNative(); m.clear();
  expect(view.materializeNative().size).toBe(5);
});
it.each([
  { position: "-1", ordinal: 0 }, { position: "01", ordinal: 0 },
  { position: "9223372036854775808", ordinal: 0 }, { position: "1", ordinal: -1 },
  { position: "1", ordinal: 128 }, { position: "1", ordinal: 0.5 },
])("rejects invalid historical cursor %j", cursor => {
  expect(() => compareCursor(cursor, { position: "0", ordinal: 0 })).toThrow("CURSOR");
});
