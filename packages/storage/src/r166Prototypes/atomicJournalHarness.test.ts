import { expect, it } from "vitest";
import { rmSync } from "node:fs";
import { F01_BOOK, withStore } from "../r15Fixtures";
import { checksum, canonical } from "../sqliteCatalog";
import { migrateToV2 } from "../storageMigration";
import { SegmentWriter } from "../segmentWriter";
import { encodeIdentity } from "./identityCodec";
import { SqliteLedger } from "./sqliteLedger";
import { RAW_V1_DDL, RAW_V2_DDL, ddlShape, installMockRawLayout, rawSchemaNames } from "./atomicJournalHarness";
import { ReaderSession, verifyReaderSession } from "./readerSession";

function trial(run: (ledger: SqliteLedger, source: Parameters<typeof withStore>[0] extends (s: infer S) => unknown ? S : never) => void,
  mode: "empty" | "v1" | "v2" | "both" | "chunk-only" = "v2") {
  return withStore(source => {
    if (mode !== "empty") source.journal.append(source.scope.id, F01_BOOK.events);
    if (mode !== "v1") migrateToV2(source.journal);
    if (mode === "both" || mode === "chunk-only") {
      const writer = new SegmentWriter(source.journal);
      const info = writer.write(source.scope.id, "L2_MBP", ["1", "2", "3", "4", "5"]);
      if (mode === "chunk-only") writer.releaseSqliteCopies(info);
    }
    const ledger = SqliteLedger.create({
      scopeId: encodeIdentity(F01_BOOK.events[0]).scopeId, epoch: "E1",
      evidence: "MOCK F-01 complete from empty source",
    });
    try { run(ledger, source); }
    finally { ledger.close(); rmSync(ledger.location.directory, { recursive: true, force: true }); }
  });
}
function expected(ledger: SqliteLedger) {
  const { scopeId, epoch, coverage } = ledger.verify();
  return { scopeId, epoch, coverage };
}
const ddl = (s: string) => s.replace(/\s+/g, " ").trim();

it.each(["v1", "v2"] as const)("copies exact product %s declarations, including PK, FK, CHECK and indexes", v =>
  trial((ledger, source) => {
    installMockRawLayout(ledger, source.catalog);
    const declarations = [...RAW_V1_DDL, ...(v === "v2" ? RAW_V2_DDL : [])];
    for (const sql of declarations) {
      const name = /CREATE (?:TABLE|INDEX) ([a-z0-9_]+)/.exec(sql)![1];
      expect(ddlShape(ledger.db, [name])[0]).toEqual(ddlShape(source.catalog.database, [name])[0]);
      expect(ddlShape(ledger.db, [name])[0].sql).toBe(ddl(sql));
    }
    expect(rawSchemaNames(v === "v1" ? 1 : 2)).toContain("r166_raw_layout");
    expect(ledger.db.pragma("application_id", { simple: true })).toBe(0x5031424c);
    expect(ledger.db.pragma("user_version", { simple: true })).toBe(1);
    expect(ledger.verify().count).toBe(0);
  }, v));

it.each(["empty", "v1", "v2", "both", "chunk-only"] as const)(
  "imports actual MOCK %s originals; P1-A verifier checks all before release", mode =>
    trial((ledger, source) => {
      const oracle = source.journal.records(), indexRoot = mode === "v1" ?
        null : (JSON.parse((source.catalog.database.prepare("SELECT payload FROM r15_meta WHERE id=1")
          .get() as { payload: string }).payload) as { indexRoot: string }).indexRoot;
      const binding = installMockRawLayout(ledger, source.catalog);
      expect(binding.manifestCount).toBe(String(oracle.length));
      expect(binding.indexRoot).toBe(indexRoot);
      expect(() => new ReaderSession(`${ledger.location.directory}/prototype-ledger.sqlite`)).toThrow("SCHEMA");
      const reader = ReaderSession.openPrototype(ledger.location, ledger.receipt(), expected(ledger));
      try {
        const receipt = verifyReaderSession(reader, 2);
        expect(receipt.records).toBe(oracle.length);
        expect(receipt.originalsHash).toBe(checksum(oracle));
        expect(receipt.indexRoot).toBe(indexRoot);
        expect(receipt.chunkRecords).toBe(["both", "chunk-only"].includes(mode) ? 5 : 0);
        expect(receipt.mirroredRecords).toBe(mode === "both" ? 5 : 0);
        expect(reader.db.readonly).toBe(true);
        expect(() => reader.db.exec("DELETE FROM records")).toThrow();
      } finally { reader.close(); }
    }, mode));

it("refuses to import a second raw layout rather than replace verified history", () => trial((ledger, source) => {
  installMockRawLayout(ledger, source.catalog);
  expect(() => installMockRawLayout(ledger, source.catalog)).toThrow();
  const reader = ReaderSession.openPrototype(ledger.location, ledger.receipt(), expected(ledger));
  reader.close();
}, "v1"));

it("rejects over-budget source bytes before full legacy replay or any raw DDL", () => trial((ledger, source) => {
  const row = source.catalog.database.prepare("SELECT payload FROM records WHERE position=1")
    .get() as { payload: string };
  source.catalog.database.prepare("UPDATE records SET payload=? WHERE position=1")
    .run(row.payload + " ".repeat(16 * 1024 * 1024 + 1));
  expect(() => installMockRawLayout(ledger, source.catalog)).toThrow("BUDGET_EXCEEDED");
  expect(ledger.db.prepare("SELECT name FROM sqlite_master WHERE name='records'").get()).toBeUndefined();
  expect(ledger.verify().count).toBe(0);
}, "v1"));
