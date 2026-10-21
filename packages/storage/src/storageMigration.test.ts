import { expect, it } from "vitest";
import { withStore } from "./r15Fixtures";
import { canonical } from "./sqliteCatalog";
import { migrateToV2 } from "./storageMigration";
import { F01_BOOK } from "./storageFixtures";

it("migrates v1 losslessly and idempotently", () => withStore(({ journal, scope, catalog }) => {
  journal.append(scope.id, F01_BOOK.events);
  const before = canonical(journal.records()), manifest = catalog.manifest();
  expect(migrateToV2(journal).migrated).toBe(true);
  expect(canonical(journal.records())).toBe(before);
  expect(catalog.manifest()).toEqual(manifest);
  expect(migrateToV2(journal).migrated).toBe(false);
  expect(catalog.database.pragma("user_version", { simple: true })).toBe(2);
}));
it("rolls back migration DDL and protects all v1 data", () => withStore(({ journal, scope, catalog }) => {
  journal.append(scope.id, F01_BOOK.events);
  const before = canonical(journal.records());
  expect(() => migrateToV2(journal, () => { throw new Error("migration failure"); })).toThrow("migration failure");
  expect(catalog.database.pragma("user_version", { simple: true })).toBe(1);
  expect(canonical(journal.records())).toBe(before);
  expect(catalog.database.prepare("SELECT name FROM sqlite_master WHERE name='r15_meta'").get()).toBeUndefined();
}));
