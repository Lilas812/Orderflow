import { expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { withStore, F01_BOOK, mockConfig, at } from "../r15Fixtures";
import { SqliteLedger } from "./sqliteLedger";
import { encodeIdentity } from "./identityCodec";
import { installMockRawLayout, rawBinding, type RawBinding } from "./atomicJournalHarness";
import { canonical, checksum } from "../sqliteCatalog";
import { indices, migrateToV2, saveStorageState, storageState } from "../storageMigration";
import { SegmentWriter } from "../segmentWriter";
import { segmentPath } from "../segmentReader";
import { ReaderSession, verifyReaderSession } from "./readerSession";
import { sqlPages } from "./boundedSqlReader";

it.each(["v1", "v2-sql", "both", "chunk-only", "mixed", "two-chunks"])
  ("integrates %s with identical original hash and full legacy indexRoot", mode => withStore(({ catalog, journal, scope }) => {
    journal.append(scope.id, F01_BOOK.events);
    const oracle = journal.records(), originalHash = checksum(oracle);
    if (mode !== "v1") migrateToV2(journal);
    if (!["v1", "v2-sql"].includes(mode)) {
      const writer = new SegmentWriter(journal);
      const info = writer.write(scope.id, "L2_MBP", mode === "mixed" ? ["2", "3"] :
        mode === "two-chunks" ? ["1", "3", "5"] : ["1", "2", "3", "4", "5"]);
      if (mode === "chunk-only" || mode === "mixed") writer.releaseSqliteCopies(info);
      if (mode === "two-chunks") writer.write(scope.id, "L2_MBP", ["2", "4"]);
    }
    const indexRoot = mode === "v1" ? null : checksum(indices(catalog));
    catalog.close();
    const before = checksum(readFileSync(catalog.filename).toString("base64"));
    const session = new ReaderSession(catalog.filename);
    try {
      const receipt = verifyReaderSession(session, 2);
      expect(receipt.records).toBe(5); expect(receipt.originalsHash).toBe(originalHash);
      expect(receipt.indexRoot).toBe(indexRoot);
      expect(receipt.chunkRecords).toBe(mode === "mixed" ? 2 : ["both", "chunk-only", "two-chunks"].includes(mode) ? 5 : 0);
      expect(receipt.mirroredRecords).toBe(["both", "two-chunks"].includes(mode) ? 5 : 0);
      expect(() => session.db.exec("DELETE FROM records")).toThrow();
    } finally { session.close(); }
    expect(checksum(readFileSync(catalog.filename).toString("base64"))).toBe(before);
  }));
it.each([1, 2])("returns fully verified empty v%s", v => withStore(({ catalog, journal }) => {
  if (v === 2) migrateToV2(journal); catalog.close();
  const session = new ReaderSession(catalog.filename);
  try { expect(verifyReaderSession(session).originalsHash).toBe(checksum([])); }
  finally { session.close(); }
}));
it("supports one record without special empty/final-page assumptions", () => withStore(({ catalog, journal, scope }) => {
  journal.append(scope.id, [F01_BOOK.events[0]]); const hash = checksum(journal.records()); catalog.close();
  const session = new ReaderSession(catalog.filename);
  try { expect(verifyReaderSession(session, 1)).toMatchObject({ records: 1, originalsHash: hash }); }
  finally { session.close(); }
}));
it("rejects SQL/chunk mismatch even when both records have internally valid checksums", () => withStore(({ catalog, journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  new SegmentWriter(journal).write(scope.id, "L2_MBP", ["1", "2", "3", "4", "5"]);
  const r = journal.records()[1], { checksum: _old, ...body } = r;
  const changed = { ...body, reason: body.reason + "tampered" }, hash = checksum(changed);
  catalog.database.prepare("UPDATE records SET reason=?,checksum=? WHERE position=2").run(changed.reason, hash);
  catalog.close(); const session = new ReaderSession(catalog.filename);
  try { expect(() => verifyReaderSession(session)).toThrow("MIRROR_CONFLICT"); }
  finally { session.close(); }
}));
it("never falls back to valid SQL when a later chunk footer is corrupt", () => withStore(({ catalog, journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  const info = new SegmentWriter(journal).write(scope.id, "L2_MBP", ["1", "2", "3", "4", "5"]);
  const file = segmentPath(catalog, info);
  writeFileSync(file, readFileSync(file, "utf8").replace('"FINALIZED"', '"CORRUPTED"'));
  catalog.close(); const session = new ReaderSession(catalog.filename);
  let receipt: unknown;
  try { expect(() => { receipt = verifyReaderSession(session); }).toThrow(); expect(receipt).toBeUndefined(); }
  finally { session.close(); }
}));
it.each(["raw", "descriptor", "root", "manifest", "retention", "pending"])
  ("rejects %s failure without changing the existing DB", failure => withStore(({ catalog, journal, scope }) => {
    journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
    if (failure === "raw") catalog.database.exec("DELETE FROM records WHERE position=3");
    if (failure === "descriptor") catalog.database.exec("DELETE FROM r15_records WHERE position=3");
    if (failure === "root") {
      const state = { ...storageState(catalog), indexRoot: "0".repeat(64) };
      catalog.database.prepare("UPDATE r15_meta SET payload=?,checksum=? WHERE id=1").run(canonical(state), checksum(state));
    }
    if (failure === "manifest") catalog.database.exec("UPDATE meta SET checksum='invalid' WHERE key='manifest'");
    if (failure === "retention") saveStorageState(catalog, { ...storageState(catalog), cutoffNs: "0" });
    if (failure === "pending") {
      const state = { ...storageState(catalog), pendingRetention: {} };
      catalog.database.prepare("UPDATE r15_meta SET payload=?,checksum=? WHERE id=1").run(canonical(state), checksum(state));
    }
    catalog.close(); const before = readFileSync(catalog.filename);
    expect(() => {
      const session = new ReaderSession(catalog.filename);
      try { verifyReaderSession(session); } finally { session.close(); }
    }).toThrow();
    expect(readFileSync(catalog.filename)).toEqual(before);
  }));
it.each([
  { readBufferBytes: 1024 * 1024 + 1 }, { recordBytes: 1024 * 1024 + 1 },
  { workingBytes: 16 * 1024 * 1024 + 1 }, { spoolBytes: -1 },
])("rejects invalid resource cap %j before opening data", budget => {
  expect(() => new ReaderSession("/must-not-open.sqlite", budget)).toThrow("BUDGET_EXCEEDED");
});
it("rejects aggregate chunk+SQL working budget and closes all private spools", () => withStore(({ catalog, journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  const info = new SegmentWriter(journal).write(scope.id, "L2_MBP", ["1", "2", "3", "4", "5"]);
  catalog.close();
  const chunkReservation = Buffer.byteLength(canonical(info)) * 16 + info.bytes * 16 + 8192 + 4096 + 4096;
  const session = new ReaderSession(catalog.filename, {
    workingBytes: chunkReservation + 1024, recordBytes: 8192, readBufferBytes: 4096,
  });
  try { expect(() => verifyReaderSession(session)).toThrow("BUDGET_EXCEEDED"); }
  finally { session.close(); }
}));

function withTrial(run: (ledger: SqliteLedger, source: Parameters<Parameters<typeof withStore>[0]>[0]) => void,
  mode: "v1" | "v2" | "both" = "v2") {
  return withStore(source => {
    source.journal.append(source.scope.id, F01_BOOK.events);
    if (mode !== "v1") migrateToV2(source.journal);
    if (mode === "both") new SegmentWriter(source.journal).write(source.scope.id, "L2_MBP", ["1", "2", "3", "4", "5"]);
    const ledger = SqliteLedger.create({ scopeId: encodeIdentity(F01_BOOK.events[0]).scopeId,
      epoch: "E1", evidence: "Complete independent MOCK F-01" });
    try { run(ledger, source); }
    finally { ledger.close(); rmSync(ledger.location.directory, { recursive: true, force: true }); }
  });
}
function openTrial(ledger: SqliteLedger) {
  const { scopeId, epoch, coverage } = ledger.verify();
  return ReaderSession.openPrototype(ledger.location, ledger.receipt(), { scopeId, epoch, coverage });
}
it.each(["v1", "v2", "both"] as const)(
  "the REAL bounded reader certifies prototype %s, then serves position pages", mode =>
    withTrial((ledger, source) => {
      installMockRawLayout(ledger, source.catalog);
      const reader = openTrial(ledger);
      try {
        expect(verifyReaderSession(reader, 1).originalsHash).toBe(checksum(source.journal.records()));
        const table = mode === "v1" ? "records" : "r15_records";
        const found = [...sqlPages(reader, table, { through: "5", expectedCount: 5, pageRows: 2 })].flat();
        expect(found.map(row => row.position)).toEqual(["1", "2", "3", "4", "5"]);
        expect(reader.version).toBe(mode === "v1" ? 1 : 2); // physical trial user_version stays 1
        expect(reader.db.pragma("user_version", { simple: true })).toBe(1);
      } finally { reader.close(); }
    }, mode));

it("rejects the original four-table P1-B DB although its marker and application ID are real", () =>
  withTrial(ledger => { expect(() => openTrial(ledger)).toThrow(); }, "v1"));

it.each(["scopeId", "epoch", "coverage"] as const)(
  "rejects independently supplied %s that does not match the ledger", field =>
    withTrial((ledger, source) => {
      installMockRawLayout(ledger, source.catalog);
      const snapshot = ledger.verify();
      const value = { scopeId: snapshot.scopeId, epoch: snapshot.epoch, coverage: snapshot.coverage };
      const altered = { ...value, [field]: field === "coverage" ? "UNPROVEN" : "different" };
      expect(() => ReaderSession.openPrototype(ledger.location, ledger.receipt(), altered)).toThrow("RAW_BINDING");
    }));

it.each(["missing", "changed"] as const)("rejects %s ownership marker", failure =>
  withTrial((ledger, source) => {
    installMockRawLayout(ledger, source.catalog);
    const marker = join(ledger.location.directory, ".r166-p1b-owner");
    if (failure === "missing") unlinkSync(marker); else writeFileSync(marker, "wrong");
    // A missing marker fails at lstat (ENOENT); a changed marker fails with LEDGER_OWNERSHIP.
    expect(() => openTrial(ledger)).toThrow(failure === "changed" ? "LEDGER_OWNERSHIP" : "ENOENT");
  }));

it.each(["app", "version", "table", "constraint", "manifest", "raw", "index", "chain"] as const)(
  "rejects %s corruption before publishing a reader", failure =>
    withTrial((ledger, source) => {
      installMockRawLayout(ledger, source.catalog);
      const db = ledger.db;
      if (failure === "app") db.pragma("application_id=123");
      if (failure === "version") db.pragma("user_version=2");
      if (failure === "table") db.exec("DROP TABLE r15_records");
      if (failure === "constraint") db.exec("ALTER TABLE records ADD COLUMN extra TEXT");
      if (failure === "manifest") db.exec("UPDATE meta SET checksum='bad' WHERE key='manifest'");
      if (failure === "raw") db.exec("UPDATE records SET reason='changed' WHERE position=2");
      if (failure === "index") {
        const row = db.prepare("SELECT payload FROM r15_meta WHERE id=1").get() as { payload: string };
        const state = { ...JSON.parse(row.payload) as object, indexRoot: "f".repeat(64) };
        db.prepare("UPDATE r15_meta SET payload=?,checksum=? WHERE id=1").run(canonical(state), checksum(state));
        const binding: RawBinding = { ...rawBinding(db), indexRoot: state.indexRoot };
        db.prepare("UPDATE r166_raw_layout SET payload=?,checksum=? WHERE id=1")
          .run(canonical(binding), checksum(binding));
      }
      if (failure === "chain") {
        const before = source.journal.records()[1], { checksum: _hash, ...body } = before;
        const altered = { ...body, previousHash: "0".repeat(64) };
        db.prepare("UPDATE records SET previous_hash=?,checksum=? WHERE position=2")
          .run(altered.previousHash, checksum(altered));
      }
      let returned: ReaderSession | undefined;
      expect(() => { returned = openTrial(ledger); }).toThrow();
      expect(returned).toBeUndefined();
    }));

it("rejects internally valid SQL changes that disagree with a mirrored original", () =>
  withTrial((ledger, source) => {
    installMockRawLayout(ledger, source.catalog);
    const before = source.journal.records()[1], { checksum: _hash, ...body } = before;
    const changed = { ...body, reason: `${body.reason} CHANGED` };
    ledger.db.prepare("UPDATE records SET reason=?,checksum=? WHERE position=2")
      .run(changed.reason, checksum(changed));
    expect(() => openTrial(ledger)).toThrow("MIRROR_CONFLICT");
  }, "both"));

it("keeps the original WAL read snapshot and refuses a newly corrupted generation", () =>
  withTrial((ledger, source) => {
    installMockRawLayout(ledger, source.catalog);
    const reader = openTrial(ledger);
    try {
      const first = verifyReaderSession(reader);
      ledger.db.exec("UPDATE records SET reason='changed' WHERE position=1");
      expect(verifyReaderSession(reader)).toEqual(first);
      expect(() => openTrial(ledger)).toThrow();
    } finally { reader.close(); }
  }));

it("rejects the reader's lost read transaction and changed private binding", () =>
  withTrial((ledger, source) => {
    installMockRawLayout(ledger, source.catalog);
    const reader = openTrial(ledger);
    try {
      reader.db.exec("ROLLBACK");
      expect(() => reader.assertPinned()).toThrow("GENERATION_CHANGED");
    } finally { reader.close(); }
    ledger.db.exec("UPDATE r166_raw_layout SET checksum='changed' WHERE id=1");
    expect(() => openTrial(ledger)).toThrow();
  }));

it("refuses trial-specific invalid budgets, just like the normal reader", () =>
  withTrial((ledger, source) => {
    installMockRawLayout(ledger, source.catalog);
    const snapshot = ledger.verify();
    for (const budget of [
      { readBufferBytes: 1024 * 1024 + 1 }, { recordBytes: 1024 * 1024 + 1 },
      { workingBytes: 16 * 1024 * 1024 + 1 }, { spoolBytes: 64 * 1024 * 1024 + 1 },
    ]) {
      expect(() => ReaderSession.openPrototype(ledger.location, ledger.receipt(), snapshot, budget))
        .toThrow("BUDGET_EXCEEDED");
    }
  }));

it("verifies originals of multiple MOCK scopes without treating them as one ledger scope", () =>
  withTrial((ledger, source) => {
    const first = F01_BOOK.events[0];
    const second = { ...first, header: { ...first.header,
      sessionId: `${first.header.sessionId}-OTHER`, eventId: "P1-C1b-OTHER", sequence: "1" } };
    const other = source.journal.register(mockConfig(second), at(0));
    source.journal.append(other.id, [second]);
    installMockRawLayout(ledger, source.catalog);
    const reader = openTrial(ledger);
    try {
      expect(verifyReaderSession(reader)).toMatchObject({
        records: 6, originalsHash: checksum(source.journal.records()),
      });
      expect(ledger.verify().scopeId).toBe(encodeIdentity(first).scopeId);
    } finally { reader.close(); }
  }));

it("refuses bytes beyond the original 1 MiB record cap without returning a prefix", () =>
  withTrial((ledger, source) => {
    installMockRawLayout(ledger, source.catalog);
    const row = ledger.db.prepare("SELECT payload FROM records WHERE position=1").get() as { payload: string };
    ledger.db.prepare("UPDATE records SET payload=? WHERE position=1")
      .run(row.payload + " ".repeat(1024 * 1024));
    expect(() => openTrial(ledger)).toThrow("BUDGET_EXCEEDED");
  }));

it("rejects disk spool bytes above the P1-A configured bound", () =>
  withTrial((ledger, source) => {
    installMockRawLayout(ledger, source.catalog);
    const m = ledger.verify();
    expect(() => ReaderSession.openPrototype(ledger.location, ledger.receipt(), m, {
      spoolBytes: 1,
    })).toThrow("BUDGET_EXCEEDED");
  }, "both"));

it("rejects changed ledger epoch after layout binding without treating stale raw data as current", () =>
  withTrial((ledger, source) => {
    installMockRawLayout(ledger, source.catalog);
    ledger.switchEpoch("E2", ledger.receipt());
    expect(() => openTrial(ledger)).toThrow("RAW_BINDING");
  }));

it("rejects an UNPROVEN ledger even if its real ownership marker is valid", () =>
  withStore(source => {
    const ledger = SqliteLedger.create({ scopeId: encodeIdentity(F01_BOOK.events[0]).scopeId,
      epoch: "E1", coverage: "UNPROVEN", evidence: "Unknown MOCK origin" });
    try {
      expect(() => installMockRawLayout(ledger, source.catalog)).toThrow("COVERAGE_UNPROVEN");
      expect(() => openTrial(ledger)).toThrow("COVERAGE_UNPROVEN");
    } finally { ledger.close(); rmSync(ledger.location.directory, { recursive: true, force: true }); }
  }));
