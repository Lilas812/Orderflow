import { expect, it } from "vitest";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { withStore, F01_BOOK } from "./r15Fixtures";
import { indices, migrateToV2 } from "./storageMigration";
import { SegmentWriter } from "./segmentWriter";
import { decodeSegment, segmentPath, SegmentReader } from "./segmentReader";

it.each(["SQLite-only", "both", "chunk-only"])("reads %s once, with original order/ns/hash", mode =>
  withStore(({ journal, scope, catalog }) => {
    journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
    const before = journal.records(), writer = new SegmentWriter(journal);
    if (mode !== "SQLite-only") {
      const info = writer.write(scope.id, "L2_MBP", before.map(r => r.position));
      if (mode === "chunk-only") writer.releaseSqliteCopies(info);
    }
    expect(new SegmentReader(catalog).records(indices(catalog))).toEqual(before);
    expect(journal.records()).toHaveLength(5);
  }));
it.each(["truncate", "mutate", "missing", "extra-footer"])("fails closed on %s", corruption =>
  withStore(({ journal, scope, catalog }) => {
    journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
    const writer = new SegmentWriter(journal), info = writer.write(scope.id, "L2_MBP", ["1","2"]);
    const file = segmentPath(catalog, info), text = readFileSync(file, "utf8");
    if (corruption === "missing") unlinkSync(file);
    else writeFileSync(file, corruption === "truncate" ? text.slice(0, -20) :
      corruption === "mutate" ? text.replace('"qty":40', '"qty":41') : text + "{}\n");
    expect(() => new SegmentReader(catalog).records(indices(catalog))).toThrow();
    // Even a valid SQL copy must not conceal a corrupt finalized chunk.
    expect(() => writer.releaseSqliteCopies(info)).toThrow();
  }));
it("rejects unsupported chunk format", () => withStore(({ journal, scope, catalog }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  const info = new SegmentWriter(journal).write(scope.id, "L2_MBP", ["1"]);
  expect(() => decodeSegment(readFileSync(segmentPath(catalog, info), "utf8").replace('"formatVersion":1', '"formatVersion":2'), info)).toThrow();
}));
it("detects missing SQLite originals without a committed chunk", () => withStore(({ journal, scope, catalog }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  catalog.database.prepare("DELETE FROM records WHERE position=2").run();
  expect(() => journal.verify()).toThrow("RAW_SOURCE_MISSING");
}));
it("quarantines damaged finalized chunks explicitly, and never silently falls back", () => withStore(({ journal, scope, catalog }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  const writer = new SegmentWriter(journal), info = writer.write(scope.id, "L2_MBP", ["1","2"]);
  expect(() => writer.quarantineCorrupt(info.segmentId)).toThrow("SEGMENT_VALID");
  writeFileSync(segmentPath(catalog, info), "broken\n");
  writer.quarantineCorrupt(info.segmentId);
  expect(() => writer.quarantineCorrupt(info.segmentId)).not.toThrow();
  expect(() => new SegmentReader(catalog).records(indices(catalog))).toThrow("SEGMENT_CORRUPT");
}));
