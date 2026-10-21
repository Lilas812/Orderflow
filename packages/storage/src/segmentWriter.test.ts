import { expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { withStore, F01_BOOK } from "./r15Fixtures";
import { migrateToV2, segments } from "./storageMigration";
import { SegmentWriter, type WritePhase } from "./segmentWriter";
import { segmentDirectory } from "./segmentReader";
import { canonical } from "./sqliteCatalog";

it("requires explicit migration before writing", () => withStore(({ journal }) => {
  expect(() => new SegmentWriter(journal)).toThrow("MIGRATION_REQUIRED");
}));
it("seals without losing/changing the original; explicit release preserves logical records", () => withStore(({ journal, scope, catalog }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  const before = canonical(journal.records()), writer = new SegmentWriter(journal);
  const info = writer.write(scope.id, "L2_MBP", journal.records().map(r => r.position));
  expect(info.recordCount).toBe(5);
  expect(info.formatVersion).toBe(1); expect(info.finalizationStatus).toBe("FINALIZED");
  expect(catalog.database.prepare("SELECT count(*) AS n FROM records").get()).toEqual({ n: 5 });
  expect(canonical(journal.records())).toBe(before);
  writer.releaseSqliteCopies(info);
  expect(catalog.database.prepare("SELECT count(*) AS n FROM records").get()).toEqual({ n: 0 });
  expect(canonical(journal.records())).toBe(before);
}));
it.each(["after-temp", "after-flush", "after-rename", "before-commit"] as WritePhase[])(
  "fault at %s keeps originals and quarantines incomplete/unregistered files", phase =>
    withStore(({ journal, scope, catalog }) => {
      journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
      const writer = new SegmentWriter(journal), before = canonical(journal.records());
      expect(() => writer.write(scope.id, "L2_MBP", ["1","2"], p => {
        if (p === phase) throw new Error("injected disk/catalog failure");
      })).toThrow("injected");
      expect(segments(catalog)).toEqual([]);
      expect(canonical(journal.records())).toBe(before);
      expect(writer.quarantineInterrupted()).toHaveLength(1);
      expect(writer.quarantineInterrupted()).toHaveLength(0);
      expect(readdirSync(segmentDirectory(catalog))).toEqual(["quarantine"]);
    }));
it.each([{ positions: [] }, { positions: ["1","1"] }, { positions: ["999"] }])("rejects invalid position selection $positions", ({ positions }) => withStore(({ journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  expect(() => new SegmentWriter(journal).write(scope.id, "L2_MBP", positions)).toThrow();
}));
it("rejects wrong channel and overlapping assignment", () => withStore(({ journal, scope }) => {
  journal.append(scope.id, F01_BOOK.events); migrateToV2(journal);
  const writer = new SegmentWriter(journal);
  expect(() => writer.write(scope.id, "TRADES", ["1"])).toThrow("SEGMENT_SCOPE");
  writer.write(scope.id, "L2_MBP", ["1","2"]);
  expect(() => writer.write(scope.id, "L2_MBP", ["2","3"])).toThrow("SEGMENT_OVERLAP");
}));
