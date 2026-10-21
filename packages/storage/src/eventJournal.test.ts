import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { F04_TRADES } from "@workspace/fixtures";
import { restingQuantity, type MarketEvent } from "@workspace/core/events";
import { readCurrentMbpLevel } from "@workspace/core/quality-timeline";
import { canonical, SqliteCatalog } from "./sqliteCatalog";
import { EventJournal, type JournalInput } from "./eventJournal";
import { F01_BOOK, mockConfig, at } from "./storageFixtures";

const dirs: string[] = [], catalogs: SqliteCatalog[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orderflow-r14-journal-")); dirs.push(dir);
  const catalog = new SqliteCatalog(join(dir, "journal.sqlite")); catalogs.push(catalog);
  const journal = new EventJournal(catalog);
  const scope = journal.register(mockConfig(F01_BOOK.events[0]), at(0));
  return { catalog, journal, scope };
}
afterEach(() => {
  for (const c of catalogs.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("round-trips all F01 events without mutation or changing MOCK into replay", () => {
  const { journal, scope } = setup(); const before = canonical(F01_BOOK);
  journal.append(scope.id, F01_BOOK.events);
  expect(journal.records(scope.id).map(r => r.input)).toEqual(
    F01_BOOK.events.map(event => ({ type: "EVENT", event })));
  expect(journal.stats()).toMatchObject({ auditRecords: 5, eventsReceived: 5, eventsApplied: 5 });
  expect(canonical(F01_BOOK)).toBe(before);
  expect(journal.replay(scope.id).config.identity.environment).toBe("MOCK");
});
it("distinguishes received/pending from committed and protects old data on failed commit", () => {
  const { journal, scope } = setup();
  const pending = journal.stage(scope.id, F01_BOOK.events.map(event => ({ type: "EVENT", event })));
  expect(pending.receivedCount).toBe(5); expect(pending.committed).toBe(false);
  expect(journal.stats().auditRecords).toBe(0);
  expect(() => pending.commit(() => { throw new Error("disk failure"); })).toThrow("disk failure");
  expect(pending.committed).toBe(false); expect(journal.stats().auditRecords).toBe(0);
  pending.commit(); expect(pending.committed).toBe(true);
  expect(() => pending.commit()).toThrow(/ALREADY_COMMITTED/);
  expect(journal.stats().eventsApplied).toBe(5);
});
it("keeps duplicate reception in audit without applying it twice", () => {
  const { journal, scope } = setup();
  journal.append(scope.id, F01_BOOK.events.slice(0, 2));
  journal.append(scope.id, [F01_BOOK.events[1]]);
  expect(journal.stats()).toMatchObject({ eventsReceived: 3, eventsApplied: 2 });
  expect(journal.records().at(-1)?.outcome).toBe("DUPLICATE");
  expect(readCurrentMbpLevel(journal.replay(scope.id), "BID", 80000)).toMatchObject({ qty: 80 });
});
it("keeps event time, receive time, and committed position separate", () => {
  const { journal, scope } = setup();
  const e = { ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header,
    exchangeTimeNs: "1767225600000000123", receiveTimeNs: "1767225600000000999" } };
  journal.append(scope.id, [e]);
  expect(journal.records()[0]).toMatchObject({
    position: "1", eventNs: "1767225600000000123", receiveNs: "1767225600000000999",
  });
});
it.each(["sessionId", "sourceId", "canonicalInstrumentId", "environment"] as const)(
  "rejects foreign %s atomically", (key) => {
    const { journal, scope } = setup();
    const e = { ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header,
      [key]: key === "environment" ? "LIVE" : key === "canonicalInstrumentId" ? "CME:NQ:2027-03" : "foreign",
      ...(key === "environment" ? { source: "VENDOR_UNVERIFIED" } : {}) } } as MarketEvent;
    expect(() => journal.append(scope.id, [e])).toThrow(/SCOPE_MISMATCH/);
    expect(journal.stats().eventsReceived).toBe(0);
  },
);
it("isolates independent sessions in one database", () => {
  const { journal, scope } = setup(); journal.append(scope.id, F01_BOOK.events);
  const snapshot = { ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header, sessionId: "OTHER" } };
  const other = journal.register(mockConfig(snapshot), at(0)); journal.append(other.id, [snapshot]);
  expect(journal.stats(scope.id).eventsReceived).toBe(5);
  expect(journal.stats(other.id).eventsReceived).toBe(1);
  expect(journal.records(other.id)[0].position).toBe("6");
});
it("preserves Trade and L1 including UNKNOWN and null quantities", () => {
  const { journal, scope } = setup();
  const h = F01_BOOK.events[0].header;
  const trade = { ...F04_TRADES.events[0], header: { ...h, channel: "TRADES" as const },
    aggressor: "UNKNOWN" as const };
  const quote = { kind: "L1_QUOTE", header: { ...h, channel: "L1" },
    bestBidTick: 80000, bestAskTick: null, bidQty: restingQuantity(0), askQty: null } as const;
  journal.append(scope.id, [trade, quote]);
  expect(journal.records().map(r => r.input)).toEqual([{ type: "EVENT", event: trade }, { type: "EVENT", event: quote }]);
  expect(journal.stats().eventsApplied).toBe(2);
});
it("persists quality intervals verbatim without letting VALID metadata repair GAP", () => {
  const { journal, scope } = setup(); journal.append(scope.id, [F01_BOOK.events[0]]);
  const entries: JournalInput[] = [
    { type: "QUALITY_INTERVAL", observedAtNs: at(1), interval: {
      channel: "L2_MBP", startNs: at(1), endNs: at(2), status: "GAP", reason: "fixed test", evidence: "MOCK" } },
    { type: "QUALITY_INTERVAL", observedAtNs: at(2), interval: {
      channel: "L2_MBP", startNs: at(2), endNs: null, status: "VALID", reason: "not a resync" } },
  ];
  journal.stage(scope.id, entries).commit();
  expect(journal.records().slice(1).map(r => r.input)).toEqual(entries);
  expect(readCurrentMbpLevel(journal.replay(scope.id), "BID", 80000)).toEqual({ status: "GAP", qty: null });
});
it("persists a complete logical MBP batch atomically and replays it using R03", () => {
  const { journal, scope } = setup(); journal.append(scope.id, [F01_BOOK.events[0]]);
  const a = { ...F01_BOOK.events[1], updateBatchId: "fixed-batch" };
  const b = { ...a, header: { ...a.header, eventId: "batch-3", sequence: "3" }, qty: restingQuantity(90) };
  journal.stage(scope.id, [{ type: "BATCH", events: [a, b] }]).commit();
  expect(journal.stats()).toMatchObject({ auditRecords: 2, eventsReceived: 3, eventsApplied: 3 });
  expect(readCurrentMbpLevel(journal.replay(scope.id), "BID", 80000)).toMatchObject({ qty: 90 });
});
it.each(["TRADE_CORRECTION", "TRADE_CANCEL"] as const)("audits %s without applying revisions", kind => {
  const { journal, scope } = setup();
  const event = { ...F04_TRADES.events[0], kind, originalTradeId: "original",
    header: { ...F04_TRADES.events[0].header, ...scope.config.identity } };
  journal.append(scope.id, [event]);
  expect(journal.records()[0]).toMatchObject({ applied: false, outcome: "UNSUPPORTED_REVISION" });
});
it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid qty %s without partial writes", qty => {
  const { journal, scope } = setup();
  expect(() => journal.append(scope.id, [F01_BOOK.events[0], { ...F01_BOOK.events[1], qty } as MarketEvent])).toThrow();
  expect(journal.stats().auditRecords).toBe(0);
});
it("detects a payload corruption on reopen", () => {
  const { journal, scope, catalog } = setup(); journal.append(scope.id, F01_BOOK.events);
  catalog.database.prepare("UPDATE records SET payload=replace(payload,'\"qty\":40','\"qty\":41') WHERE position=1").run();
  expect(() => new EventJournal(catalog)).toThrow(/EVENT_CHECKSUM/);
});
it("detects deletion of the journal tail", () => {
  const { journal, scope, catalog } = setup(); journal.append(scope.id, F01_BOOK.events);
  catalog.database.exec("DELETE FROM records WHERE position=5");
  expect(() => new EventJournal(catalog)).toThrow(/EVENT_MANIFEST/);
});
it("searches a half-open UTC range using the channel/time index", () => {
  const { journal, scope, catalog } = setup(); journal.append(scope.id, F01_BOOK.events);
  expect(journal.search(scope.id, "L2_MBP", at(1), at(5)).map(r => r.position)).toEqual(["2", "3"]);
  expect(journal.search(scope.id, "TRADES", at(0), at(10))).toEqual([]);
  const plan = catalog.database.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM records WHERE scope_id=? AND channel=? AND event_ns>=? AND event_ns<? ORDER BY event_ns,position",
  ).all(scope.id, "L2_MBP", BigInt(at(1)), BigInt(at(5))) as { detail: string }[];
  expect(plan.some(r => r.detail.includes("records_scope_channel_time"))).toBe(true);
});
it("sorts indexed timestamps numerically at exact nanosecond precision", () => {
  const { journal, scope } = setup();
  const t = BigInt(at(0));
  const event = { ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header,
    exchangeTimeNs: (t + 123n).toString(), receiveTimeNs: (t + 999n).toString() } };
  journal.append(scope.id, [event]);
  expect(journal.search(scope.id, "L2_MBP", (t + 122n).toString(), (t + 124n).toString())[0].eventNs)
    .toBe((t + 123n).toString());
  expect(journal.search(scope.id, "L2_MBP", (t + 124n).toString(), (t + 125n).toString())).toEqual([]);
});
it("reports a real SQLite write error and preserves the committed prefix", () => {
  const { journal, scope, catalog } = setup(); journal.append(scope.id, [F01_BOOK.events[0]]);
  const before = journal.stats(); catalog.database.pragma("query_only=ON");
  expect(() => journal.append(scope.id, [F01_BOOK.events[1]])).toThrow(/readonly/i);
  expect(journal.stats()).toEqual(before);
});
it("refuses LIVE storage scope rather than treating it as MOCK", () => {
  const { journal, scope } = setup();
  expect(() => journal.register({ ...scope.config, identity: {
    ...scope.config.identity, environment: "LIVE", source: "VENDOR_UNVERIFIED",
  } }, at(0))).toThrow(/MOCK_ONLY/);
});
it("rejects unexpected credential-bearing fields instead of saving or dropping them", () => {
  const { journal, scope } = setup();
  const event = { ...F01_BOOK.events[0], header: { ...F01_BOOK.events[0].header, apiKey: "non-secret-test-sentinel" } };
  expect(() => journal.append(scope.id, [event])).toThrow(/UNEXPECTED_FIELD/);
  expect(journal.stats().auditRecords).toBe(0);
});
