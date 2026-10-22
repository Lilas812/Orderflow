import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { withStore, F01_BOOK } from "../r15Fixtures";
import { canonical, checksum, EMPTY_HASH } from "../sqliteCatalog";
import { migrateToV2 } from "../storageMigration";
import type { JournalRecord } from "../eventJournal";
import { ReaderSession } from "./readerSession";
import { originalAt, position, sqlPages, validateOriginal } from "./boundedSqlReader";

it.each([1, 2])("reads v%s empty data without fabricating records", version => withStore(({ catalog, journal }) => {
  if (version === 2) migrateToV2(journal);
  catalog.close();
  const session = new ReaderSession(catalog.filename);
  try {
    expect([...sqlPages(session, version === 1 ? "records" : "r15_records",
      { through: "0", expectedCount: 0, pageRows: 1 })]).toEqual([]);
  } finally { session.close(); }
}));
it.each([1, 2, 3, 5, 128])("reads all columns in keyset pages of %s", pageRows => withStore(({ catalog, journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events);
  const before = journal.records();
  catalog.close();
  const session = new ReaderSession(catalog.filename);
  try {
    const pages = [...sqlPages(session, "records", { through: "5", expectedCount: 5, pageRows })];
    expect(pages.flat()).toEqual(before);
    expect(pages.every(p => p.length <= pageRows)).toBe(true);
    expect(checksum(pages.flat())).toBe(checksum(before));
    expect(session.db.inTransaction).toBe(true);
  } finally { session.close(); }
}));
it.each(["scope_id", "channel", "event_ns", "receive_ns", "outcome", "reason", "previous_hash", "checksum", "payload"])
  ("refuses tampered SQL %s", column => withStore(({ catalog, journal, scope }) => {
    journal.append(scope.id, F01_BOOK.events);
    const literal = column.endsWith("_ns") ? "1" : column === "scope_id" ? "'missing'" : "'tampered'";
    catalog.database.pragma("foreign_keys=OFF");
    catalog.database.exec(`UPDATE records SET ${column}=${literal} WHERE position=2`);
    catalog.close();
    const session = new ReaderSession(catalog.filename);
    try { expect(() => [...sqlPages(session, "records", { through: "5", expectedCount: 5 })]).toThrow(); }
    finally { session.close(); }
  }));
it.each(["delete-middle", "delete-tail", "move-position"])("detects %s", mode => withStore(({ catalog, journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events);
  catalog.database.exec(mode === "move-position" ? "UPDATE records SET position=8 WHERE position=2" :
    `DELETE FROM records WHERE position=${mode === "delete-tail" ? 5 : 2}`);
  catalog.close();
  const session = new ReaderSession(catalog.filename);
  try { expect(() => [...sqlPages(session, "records", { through: "5", expectedCount: 5 })]).toThrow(); }
  finally { session.close(); }
}));
it.each(["position", "scopeId", "channel", "eventNs", "receiveNs", "eventCount", "isSnapshot"])
  ("v2 rejects descriptor tampering of %s even if row checksum is recomputed", key => withStore(({ catalog, journal, scope }) => {
    journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
    const row = catalog.database.prepare("SELECT payload FROM r15_records WHERE position=2").get() as { payload: string };
    const d = JSON.parse(row.payload);
    d[key] = key === "position" ? "1" : key === "eventCount" ? -1 : key === "isSnapshot" ? "false" :
      key.endsWith("Ns") ? "0" : "other";
    catalog.database.prepare("UPDATE r15_records SET payload=?,checksum=? WHERE position=2").run(canonical(d), checksum(d));
    catalog.close();
    const session = new ReaderSession(catalog.filename);
    try { expect(() => [...sqlPages(session, "r15_records", { through: "5", expectedCount: 5 })]).toThrow(); }
    finally { session.close(); }
  }));
it.each([0, -1, 129, 1.5])("rejects page budget %s", pageRows => withStore(({ catalog }) => {
  catalog.close(); const session = new ReaderSession(catalog.filename);
  try { expect(() => [...sqlPages(session, "records", { through: "0", expectedCount: 0, pageRows })]).toThrow("BUDGET_EXCEEDED"); }
  finally { session.close(); }
}));
it("masks oversized payload before bringing it into JS, and refuses decoded page budget", () => withStore(({ catalog, journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events);
  catalog.close();
  for (const budget of [{ recordBytes: 512 }, { workingBytes: 7000, readBufferBytes: 16, recordBytes: 1024 }]) {
    const session = new ReaderSession(catalog.filename, budget);
    try { expect(() => [...sqlPages(session, "records", { through: "5", expectedCount: 5 })]).toThrow("BUDGET_EXCEEDED"); }
    finally { session.close(); }
  }
}));
it("pins WAL snapshot across a concurrent commit; loses no page to a newer generation", () => withStore(({ catalog, journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events); catalog.close();
  const writer = new Database(catalog.filename);
  writer.pragma("journal_mode=WAL");
  const session = new ReaderSession(catalog.filename);
  try {
    const pages = sqlPages(session, "records", { through: "5", expectedCount: 5, pageRows: 2 });
    expect(pages.next().value).toHaveLength(2);
    writer.exec("UPDATE records SET reason='changed after pin' WHERE position=5");
    expect([...pages].flat()).toHaveLength(3); // immutable read snapshot still sees original
    session.db.exec("ROLLBACK"); session.db.exec("BEGIN"); // forbidden cursor replacement
    expect(() => session.assertPinned()).toThrow("GENERATION_CHANGED");
  } finally { session.close(); writer.close(); }
}));
it("terminates page cursor when generator is abandoned, and rejects a lost transaction", () => withStore(({ catalog, journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events); catalog.close();
  const session = new ReaderSession(catalog.filename);
  const pages = sqlPages(session, "records", { through: "5", expectedCount: 5, pageRows: 1 });
  expect(pages.next().value).toHaveLength(1);
  pages.return(undefined);
  expect(() => originalAt(session, "5")).not.toThrow();
  session.db.exec("ROLLBACK");
  expect(() => session.assertPinned()).toThrow("GENERATION_CHANGED");
  session.close();
}));
it.each(["-9223372036854775808", "9223372036854775807", "9007199254740993"])
  ("preserves exact signed int64 ns %s", ns => {
    const body = { position: "1", scopeId: "MOCK", channel: "L1" as const, eventNs: ns, receiveNs: ns,
      input: { type: "CONDITION" as const, channel: "L1" as const, atNs: ns, status: "GAP" as const, reason: "MOCK" },
      applied: false, outcome: "CONDITION_RECORDED", reason: "MOCK", previousHash: EMPTY_HASH };
    const record = { ...body, checksum: checksum(body) };
    expect(() => validateOriginal(record)).not.toThrow(); expect(record.eventNs).toBe(ns);
  });
it.each(["-1", "0", "01", "1.0", "9223372036854775808", 1])("rejects invalid position %s", p => {
  expect(() => position(p)).toThrow("POSITION");
});
it("refuses ns overflow without Number rounding", () => {
  const record = { position: "1", eventNs: "9223372036854775808", receiveNs: "0" } as JournalRecord;
  expect(() => validateOriginal(record)).toThrow("NS_RANGE");
});
it.each(["payload", "reason", "scope_id"])("masks oversized full-row %s without native text expansion", column =>
  withStore(({ catalog, journal, scope }) => {
    journal.append(scope.id, F01_BOOK.events);
    catalog.database.pragma("foreign_keys=OFF");
    catalog.database.prepare(`UPDATE records SET ${column}=? WHERE position=1`).run("x".repeat(1024 * 1024 + 1));
    catalog.close(); const session = new ReaderSession(catalog.filename);
    try { expect(() => [...sqlPages(session, "records", { through: "5", expectedCount: 5 })]).toThrow("BUDGET_EXCEEDED"); }
    finally { session.close(); }
  }));
it("rejects invalid UTF-8 in SQLite TEXT, rather than accepting replacement characters", () =>
  withStore(({ catalog, journal, scope }) => {
    journal.append(scope.id, F01_BOOK.events);
    catalog.database.exec("UPDATE records SET payload=CAST(x'FF' AS TEXT) WHERE position=1");
    catalog.close(); const session = new ReaderSession(catalog.filename);
    try { expect(() => [...sqlPages(session, "records", { through: "5", expectedCount: 5 })]).toThrow(); }
    finally { session.close(); }
  }));
it("reads real SQLite int64 nanosecond endpoints without float conversion", () => withStore(({ catalog, scope }) => {
  const times = ["-9223372036854775808", "9223372036854775807"];
  let previous = EMPTY_HASH;
  for (const [i, ns] of times.entries()) {
    const input = { type: "CONDITION", channel: "L1", atNs: ns, status: "GAP", reason: "MOCK INT64" };
    const body = { position: String(i + 1), scopeId: scope.id, channel: "L1", eventNs: ns, receiveNs: ns,
      input, applied: false, outcome: "CONDITION_RECORDED", reason: "MOCK INT64", previousHash: previous };
    previous = checksum(body);
    catalog.database.prepare("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(BigInt(i + 1), scope.id, "L1", BigInt(ns), BigInt(ns), canonical(input), 0, body.outcome, body.reason,
        body.previousHash, previous);
  }
  catalog.setManifest({ ...catalog.manifest(), recordCount: "2", head: previous });
  catalog.close(); const session = new ReaderSession(catalog.filename);
  try {
    const records = [...sqlPages(session, "records", { through: "2", expectedCount: 2, pageRows: 1 })].flat();
    expect(records.map(r => r.eventNs)).toEqual(times);
  } finally { session.close(); }
}));
