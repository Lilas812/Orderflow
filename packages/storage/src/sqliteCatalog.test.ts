import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteCatalog, sqliteNs } from "./sqliteCatalog";

const dirs: string[] = [];
const catalogs: SqliteCatalog[] = [];
function open(): SqliteCatalog {
  const dir = mkdtempSync(join(tmpdir(), "orderflow-r14-catalog-")); dirs.push(dir);
  const c = new SqliteCatalog(join(dir, "events.sqlite")); catalogs.push(c); return c;
}
afterEach(() => {
  for (const c of catalogs.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("real SQLite catalog", () => {
  it("loads a WAL-reset-fixed SQLite and uses WAL/FULL/exclusive writer", () => {
    const c = open();
    expect(c.sqliteVersion.split(".").map(Number)).toEqual([3, 53, 4]);
    expect(c.database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(c.database.pragma("synchronous", { simple: true })).toBe(2);
    expect(c.database.pragma("locking_mode", { simple: true })).toBe("exclusive");
    expect(statSync(c.filename).mode & 0o777).toBe(0o600);
  });
  it("rejects a second writer and releases its OS lock on close", () => {
    const c = open();
    expect(() => new SqliteCatalog(c.filename)).toThrow();
    c.close();
    const reopened = new SqliteCatalog(c.filename); catalogs.push(reopened);
    expect(reopened.sqliteVersion).toBe("3.53.4");
  });
  it("rejects paths inside the workspace", () => {
    expect(() => new SqliteCatalog(join(process.cwd(), "forbidden.sqlite"))).toThrow(/workspace/i);
  });
  it.each(["1767225600000000123", "-1", "0", "9223372036854775807", "-9223372036854775808"])(
    "preserves and numerically indexes ns %s", (ns) => {
      const c = open();
      const q = c.database.prepare("SELECT ? AS ns").safeIntegers();
      expect((q.get(sqliteNs(ns)) as { ns: bigint }).ns.toString()).toBe(ns);
    },
  );
  it.each(["1.1", "01", "1e9", "9223372036854775808", "-9223372036854775809"])(
    "rejects unsupported ns %s without rounding", (ns) => expect(() => sqliteNs(ns)).toThrow(),
  );
  it("rolls back a failing transaction", () => {
    const c = open();
    expect(() => c.transaction(() => {
      c.database.prepare("INSERT INTO meta VALUES ('rollback', 'x', 'x')").run();
      throw new Error("injected write failure");
    })).toThrow("injected write failure");
    expect(c.database.prepare("SELECT * FROM meta WHERE key='rollback'").get()).toBeUndefined();
  });
  it("rejects unknown schema versions", () => {
    const c = open(); c.database.pragma("user_version=99"); c.close();
    expect(() => new SqliteCatalog(c.filename)).toThrow(/SCHEMA/);
  });
});
