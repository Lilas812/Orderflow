import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { withStore, F01_BOOK } from "../r15Fixtures";
import { canonical, checksum } from "../sqliteCatalog";
import { indices, migrateToV2, saveStorageState, storageState } from "../storageMigration";
import { SegmentWriter } from "../segmentWriter";
import { segmentPath } from "../segmentReader";
import { ReaderSession, verifyReaderSession } from "./readerSession";

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
