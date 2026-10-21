import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const STORAGE_SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x4f464c42;
export class StorageError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}
export function insist(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new StorageError(code, message);
}
/** SQLite INTEGER is signed int64. Never coerce a nanosecond value through Number. */
export function sqliteNs(value: string): bigint {
  insist(typeof value === "string" && value !== "-0" && /^-?(0|[1-9]\d*)$/.test(value), "INVALID_NS", "Canonical decimal UTC ns required");
  const n = BigInt(value);
  insist(n >= -(1n << 63n) && n < (1n << 63n), "NS_RANGE", "UTC ns outside SQLite signed int64");
  return n;
}
export function canonical(value: unknown): string {
  if (value instanceof Map) return canonical({ $storageMap: [...value.entries()] });
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k =>
      `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  insist(value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value)), "NON_JSON", "Lossless JSON primitives required");
  return JSON.stringify(value);
}
export const checksum = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function decode<T>(json: string): T {
  return JSON.parse(json, (_key, value: unknown) => {
    if (value && typeof value === "object" && "$storageMap" in value) {
      const entries = (value as { $storageMap: unknown }).$storageMap;
      insist(Array.isArray(entries) && entries.every(e => Array.isArray(e) && e.length === 2),
        "CORRUPT_STATE", "Invalid checkpoint Map");
      return new Map(entries as [unknown, unknown][]);
    }
    return value;
  }) as T;
}
export interface Manifest {
  schemaVersion: 1;
  recordCount: string;
  head: string;
  snapshotCount: string;
  snapshotHead: string;
}
export const EMPTY_HASH = checksum([]);
export function defaultDatabasePath(workspace = process.cwd()): string {
  const key = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 24);
  return join(homedir(), ".local", "share", "orderflow-lab", key, "market-r14", "events.v1.sqlite");
}
function inside(file: string, root: string): boolean {
  const r = relative(root, file);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** Node-only. One exclusive SQLite connection is the only writer/reader for this DB.
 * SQLite owns the OS lock: process death releases it without unsafe stale-lock deletion.
 * Native-driver details intentionally remain inside this package.
 */
export class SqliteCatalog {
  readonly database: Database.Database;
  readonly filename: string;
  readonly sqliteVersion: string;
  private closed = false;

  constructor(filename = defaultDatabasePath()) {
    this.filename = resolve(filename);
    const workspace = resolve(import.meta.dirname, "../../..");
    insist(!inside(this.filename, workspace), "PRIVATE_PATH", "Database must be outside workspace/public file serving");
    const parent = dirname(this.filename);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    insist(!lstatSync(parent).isSymbolicLink(), "PRIVATE_PATH", "Symlink database directory rejected");
    insist(!inside(realpathSync(parent), realpathSync(workspace)), "PRIVATE_PATH", "Resolved database directory is inside workspace");
    insist((statSync(parent).mode & 0o077) === 0, "PRIVATE_PATH", "Database directory must be private (0700)");
    if (existsSync(this.filename)) {
      insist(lstatSync(this.filename).isFile() && !lstatSync(this.filename).isSymbolicLink(),
        "PRIVATE_PATH", "Database must be a regular non-symlink file");
    }
    const db = new Database(this.filename, { timeout: 0 });
    this.database = db;
    try {
      chmodSync(this.filename, 0o600);
      this.sqliteVersion = (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
      const [major, minor, patch] = this.sqliteVersion.split(".").map(Number);
      insist(major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3))),
        "UNSAFE_SQLITE", "SQLite 3.51.3+ required for WAL-reset fix");
      db.pragma("locking_mode=EXCLUSIVE");
      insist(db.pragma("journal_mode=WAL", { simple: true }) === "wal", "WAL_REQUIRED", "WAL unavailable");
      db.pragma("synchronous=FULL");
      db.pragma("foreign_keys=ON");
      insist(db.pragma("quick_check", { simple: true }) === "ok", "CORRUPT_DATABASE", "SQLite quick_check failed");
      const version = db.pragma("user_version", { simple: true });
      const application = db.pragma("application_id", { simple: true });
      if (version === 0 && application === 0) {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        insist(tables.length === 0, "SCHEMA_UNKNOWN", "Refuse to initialize an unrelated database");
        this.initialize();
      } else {
        insist(version === STORAGE_SCHEMA_VERSION && application === APPLICATION_ID,
          "SCHEMA_UNKNOWN", "Unknown storage schema/application ID");
      }
      this.manifest();
      insist((db.pragma("foreign_key_check") as unknown[]).length === 0, "CORRUPT_DATABASE", "Foreign key check failed");
    } catch (e) { db.close(); throw e; }
  }

  private initialize(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, payload TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
        CREATE TABLE scopes (
          id TEXT PRIMARY KEY, payload TEXT NOT NULL, checksum TEXT NOT NULL,
          environment TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
          instrument TEXT NOT NULL, session TEXT NOT NULL, start_ns INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX scopes_identity ON scopes(environment,source,source_id,instrument,session);
        CREATE TABLE records (
          position INTEGER PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
          channel TEXT NOT NULL, event_ns INTEGER, receive_ns INTEGER NOT NULL,
          payload TEXT NOT NULL, applied INTEGER NOT NULL CHECK(applied IN (0,1)),
          outcome TEXT NOT NULL, reason TEXT NOT NULL,
          previous_hash TEXT NOT NULL, checksum TEXT NOT NULL
        ) STRICT;
        CREATE INDEX records_scope_position ON records(scope_id,position);
        CREATE INDEX records_scope_channel_time ON records(scope_id,channel,event_ns,position);
        CREATE TABLE snapshots (
          scope_id TEXT NOT NULL REFERENCES scopes(id), at_ns INTEGER NOT NULL,
          audit_position INTEGER NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL,
          PRIMARY KEY(scope_id,at_ns)
        ) STRICT;
        CREATE INDEX snapshots_scope_time ON snapshots(scope_id,at_ns);
        PRAGMA user_version=1;
        PRAGMA application_id=${APPLICATION_ID};
      `);
      this.setManifest({
        schemaVersion: 1, recordCount: "0", head: EMPTY_HASH,
        snapshotCount: "0", snapshotHead: EMPTY_HASH,
      });
    });
  }
  manifest(): Manifest {
    const row = this.database.prepare("SELECT payload,checksum FROM meta WHERE key='manifest'").get() as
      { payload: string; checksum: string } | undefined;
    insist(row, "CORRUPT_MANIFEST", "Missing committed manifest");
    const value = decode<Manifest>(row.payload);
    insist(checksum(value) === row.checksum && value.schemaVersion === 1 &&
      /^(0|[1-9]\d*)$/.test(value.recordCount) && /^(0|[1-9]\d*)$/.test(value.snapshotCount),
    "CORRUPT_MANIFEST", "Manifest checksum/version/count invalid");
    return value;
  }
  setManifest(value: Manifest): void {
    this.database.prepare("INSERT OR REPLACE INTO meta VALUES ('manifest',?,?)")
      .run(canonical(value), checksum(value));
  }
  transaction<T>(operation: () => T): T {
    insist(!this.closed && !this.database.inTransaction, "WRITER_STATE", "Closed or nested Writer transaction");
    return this.database.transaction(operation).immediate();
  }
  close(): void {
    if (!this.closed) { this.database.close(); this.closed = true; }
  }
}
