import { copyFileSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { canonical, checksum, insist, type SqliteCatalog } from "../sqliteCatalog";
import { EventJournal } from "../eventJournal";
import { type SegmentInfo } from "../storageMigration";
import { segmentPath } from "../segmentReader";
import { SqliteLedger, type LedgerReceipt } from "./sqliteLedger";
import { type LedgerSnapshot } from "./historicalLedgerView";

/** Exact product DDL declarations, except PRAGMA/initial data. A live schema-comparison test
 * detects drift. These declarations are ONLY installed in a marker-owned disposable MOCK DB. */
export const RAW_V1_DDL = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, payload TEXT NOT NULL, checksum TEXT NOT NULL) STRICT`,
  `CREATE TABLE scopes (
          id TEXT PRIMARY KEY, payload TEXT NOT NULL, checksum TEXT NOT NULL,
          environment TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
          instrument TEXT NOT NULL, session TEXT NOT NULL, start_ns INTEGER NOT NULL
        ) STRICT`,
  `CREATE INDEX scopes_identity ON scopes(environment,source,source_id,instrument,session)`,
  `CREATE TABLE records (
          position INTEGER PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id),
          channel TEXT NOT NULL, event_ns INTEGER, receive_ns INTEGER NOT NULL,
          payload TEXT NOT NULL, applied INTEGER NOT NULL CHECK(applied IN (0,1)),
          outcome TEXT NOT NULL, reason TEXT NOT NULL,
          previous_hash TEXT NOT NULL, checksum TEXT NOT NULL
        ) STRICT`,
  `CREATE INDEX records_scope_position ON records(scope_id,position)`,
  `CREATE INDEX records_scope_channel_time ON records(scope_id,channel,event_ns,position)`,
  `CREATE TABLE snapshots (
          scope_id TEXT NOT NULL REFERENCES scopes(id), at_ns INTEGER NOT NULL,
          audit_position INTEGER NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL,
          PRIMARY KEY(scope_id,at_ns)
        ) STRICT`,
  `CREATE INDEX snapshots_scope_time ON snapshots(scope_id,at_ns)`,
] as const;
export const RAW_V2_DDL = [
  `CREATE TABLE r15_meta(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT`,
  `CREATE TABLE r15_records(position INTEGER PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),
        channel TEXT NOT NULL,event_ns INTEGER,receive_ns INTEGER NOT NULL,payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT`,
  `CREATE INDEX r15_range ON r15_records(scope_id,channel,event_ns,position)`,
  `CREATE TABLE r15_segments(id TEXT PRIMARY KEY,payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT`,
  `CREATE TABLE r15_anchors(scope_id TEXT PRIMARY KEY REFERENCES scopes(id),payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT`,
] as const;
export const RAW_BINDING_DDL =
  `CREATE TABLE r166_raw_layout(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT`;

export function ddlShape(db: Database.Database, names: readonly string[]): { name: string; type: string; sql: string }[] {
  return names.map(name => {
    const row = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name=? AND type IN ('table','index')")
      .get(name) as { name: string; type: string; sql: string } | undefined;
    insist(row?.sql && row.name === name, "RAW_LAYOUT", `Missing schema declaration: ${name}`);
    return { ...row, sql: row.sql.replace(/\s+/g, " ").trim() };
  });
}
export function rawSchemaNames(version: 1 | 2): string[] {
  return [...RAW_V1_DDL, ...(version === 2 ? RAW_V2_DDL : []), RAW_BINDING_DDL]
    .map(sql => /CREATE (?:TABLE|INDEX) ([a-z0-9_]+)/.exec(sql)![1]);
}
export function verifyRawShape(db: Database.Database, version: 1 | 2): void {
  for (const sql of [...RAW_V1_DDL, ...(version === 2 ? RAW_V2_DDL : []), RAW_BINDING_DDL]) {
    const name = /CREATE (?:TABLE|INDEX) ([a-z0-9_]+)/.exec(sql)![1];
    const [actual] = ddlShape(db, [name]);
    insist(actual.sql === sql.replace(/\s+/g, " ").trim(), "RAW_LAYOUT",
      `Raw declaration or constraint differs: ${name}`);
  }
  if (version === 1) {
    const unexpected = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'r15_%'").get() as { n: number };
    insist(unexpected.n === 0, "RAW_LAYOUT", "v1 contains unexpected v2 declarations");
  }
  const allowed = new Set(["ledger_meta", "ledger_entries", "fingerprint_parts", "ledger_seed",
    ...rawSchemaNames(version)]);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
    .all() as { name: string }[]) {
    insist(row.name.startsWith("sqlite_") || allowed.has(row.name), "RAW_LAYOUT",
      `Unknown trial table/index: ${row.name}`);
  }
  insist((db.pragma("foreign_key_check") as unknown[]).length === 0, "RAW_LAYOUT", "Broken scope references");
}

export interface RawBinding {
  schemaVersion: 1; rawVersion: 1 | 2; scopeId: string; epoch: string;
  coverage: LedgerSnapshot["coverage"]; ledgerRoot: string; ledgerMetadataChecksum: string;
  manifestHead: string; manifestCount: string; indexRoot: string | null;
}
export function rawBinding(db: Database.Database): RawBinding {
  const row = db.prepare(`SELECT CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN payload END AS payload,
    CASE WHEN length(checksum)=64 THEN checksum END AS checksum FROM r166_raw_layout WHERE id=1`)
    .get() as { payload: string | null; checksum: string | null } | undefined;
  insist(row?.payload && row.checksum, "RAW_BINDING", "Missing/oversized raw binding");
  const value = JSON.parse(row.payload) as RawBinding;
  insist(checksum(value) === row.checksum && Object.keys(value).length === 10 &&
    value.schemaVersion === 1 && (value.rawVersion === 1 || value.rawVersion === 2) &&
    typeof value.scopeId === "string" && typeof value.epoch === "string" &&
    ["FULL_SCOPE_FROM_START", "UNPROVEN"].includes(value.coverage) &&
    typeof value.ledgerRoot === "string" && typeof value.ledgerMetadataChecksum === "string" &&
    typeof value.manifestHead === "string" && typeof value.manifestCount === "string" &&
    (value.indexRoot === null || typeof value.indexRoot === "string"), "RAW_BINDING", "Invalid raw binding");
  return value;
}

const TABLES_V1 = ["meta", "scopes", "records", "snapshots"] as const;
const TABLES_V2 = ["r15_meta", "r15_records", "r15_segments", "r15_anchors"] as const;
/** Fixture import only. Never connects a production DB: source MUST be a private R15 MOCK test DB.
 * Does NOT append a ledger entry, publish, or claim a cross-DB atomic commit. */
export function installMockRawLayout(ledger: SqliteLedger, source: SqliteCatalog): RawBinding {
  const file = resolve(source.filename), parent = dirname(file);
  insist(dirname(parent) === resolve(tmpdir()) && /^orderflow-r15-test-/.test(basename(parent)) &&
    lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink() &&
    (lstatSync(parent).mode & 0o077) === 0 &&
    source.database.pragma("application_id", { simple: true }) === 0x4f464c42,
  "MOCK_ONLY", "Only a private existing MOCK test fixture is eligible");
  // Preflight the complete MOCK fixture before invoking the legacy full-history oracle,
  // which otherwise decodes all records and chunks before our reader budgets can apply.
  const version = source.database.pragma("user_version", { simple: true }) as 1 | 2;
  insist(version === 1 || version === 2, "RAW_LAYOUT", "Only existing v1/v2 source");
  const db = ledger.db, tables = [...TABLES_V1, ...(version === 2 ? TABLES_V2 : [])];
  const total = tables.reduce((n, table) => {
    const counts = source.database.prepare(`SELECT count(*) AS n,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes
      FROM ${table}`).get() as { n: number; bytes: number };
    insist(counts.n <= 128 && counts.bytes <= 16 * 1024 * 1024 &&
      n + counts.bytes <= 16 * 1024 * 1024, "BUDGET_EXCEEDED", "Fixture import budget");
    return n + counts.bytes;
  }, 0);
  insist(total <= 16 * 1024 * 1024, "BUDGET_EXCEEDED", "Aggregate fixture decode budget");
  const infos = version === 2 ? source.database.prepare("SELECT payload FROM r15_segments").all()
    .map(row => JSON.parse((row as { payload: string }).payload) as SegmentInfo) : [];
  let spoolBytes = 0;
  for (const info of infos) {
    insist(info.finalizationStatus === "FINALIZED" && info.scopeId.length > 0 &&
      /^[a-f0-9]{64}\.jsonl$/.test(info.filename) && info.bytes <= 64 * 1024 * 1024,
    "SEGMENT_PATH", "Only finite finalized MOCK segments");
    const stat = lstatSync(segmentPath(source, info));
    spoolBytes += stat.size;
    insist(stat.isFile() && !stat.isSymbolicLink() && stat.size === info.bytes &&
      spoolBytes <= 64 * 1024 * 1024, "BUDGET_EXCEEDED", "Fixture spool cap or chunk size differs");
  }
  const journal = new EventJournal(source); // product checksum/chain oracle, after finite preflight
  const snapshot = ledger.verify(), receipt = ledger.receipt();
  const independent = SqliteLedger.open(ledger.location, receipt);
  try { independent.verify(receipt); } finally { independent.close(); }
  insist(snapshot.coverage === "FULL_SCOPE_FROM_START", "COVERAGE_UNPROVEN",
    "A complete MOCK ledger scope is required before binding originals");
  const selected = JSON.parse(snapshot.scopeId) as string[];
  insist(selected[0] === "MOCK" && selected.length === 6, "MOCK_ONLY", "Unexpected ledger scope");
  const scope = source.database.prepare(`SELECT payload FROM scopes WHERE environment=? AND source=? AND source_id=?
    AND instrument=? AND session=?`).all(...selected.slice(0, 5)) as { payload: string }[];
  insist(scope.length === 1 && JSON.parse(scope[0].payload).config.identity.environment === "MOCK",
    "RAW_BINDING", "No single matching MOCK scope");
  const copied: string[] = [];
  try {
    for (const info of infos) {
      const from = segmentPath(source, info);
      insist(lstatSync(from).isFile() && !lstatSync(from).isSymbolicLink() &&
        info.bytes <= 64 * 1024 * 1024 && /^[a-f0-9]{64}\.jsonl$/.test(info.filename),
      "SEGMENT_PATH", "Unsafe fixture chunk");
      const target = join(ledger.location.directory, "market-cache", "segments");
      mkdirSync(target, { recursive: true, mode: 0o700 });
      const to = join(target, info.filename);
      insist(!existsSync(to), "SEGMENT_EXISTS", "Refuse to overwrite fixture chunk");
      copyFileSync(from, to); copied.push(to);
    }
    const manifest = source.manifest();
    const state = version === 2 ? source.database.prepare("SELECT payload FROM r15_meta WHERE id=1")
      .get() as { payload: string } | undefined : undefined;
    insist(version !== 2 || state, "RAW_LAYOUT", "Missing v2 state");
    const binding: RawBinding = {
      schemaVersion: 1, rawVersion: version, scopeId: snapshot.scopeId, epoch: snapshot.epoch,
      coverage: snapshot.coverage, ledgerRoot: receipt.root, ledgerMetadataChecksum: receipt.metadataChecksum,
      manifestHead: manifest.head, manifestCount: manifest.recordCount,
      indexRoot: state ? (JSON.parse(state.payload) as { indexRoot: string }).indexRoot : null,
    };
    db.transaction(() => {
      insist(db.pragma("application_id", { simple: true }) === 0x5031424c &&
        db.pragma("user_version", { simple: true }) === 1 && db.inTransaction,
      "RAW_LAYOUT", "Only ledger-owned trial DB");
      db.exec([...RAW_V1_DDL, ...(version === 2 ? RAW_V2_DDL : []), RAW_BINDING_DDL].join(";\n") + ";");
      for (const table of tables) {
        const columns = source.database.pragma(`table_info(${table})`) as { name: string }[];
        const select = source.database.prepare(`SELECT * FROM ${table}`);
        const insert = db.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => "?").join(",")})`);
        for (const row of select.iterate() as Iterable<Record<string, unknown>>) {
          insist(Buffer.byteLength(row.payload as string) <= 1024 * 1024,
          "BUDGET_EXCEEDED", "Fixture record exceeds 1 MiB");
          insert.run(...columns.map(c => row[c.name] as string | number | bigint | null));
        }
      }
      db.prepare("INSERT INTO r166_raw_layout VALUES(1,?,?)").run(canonical(binding), checksum(binding));
      verifyRawShape(db, version);
      ledger.verify(receipt);
    }).immediate();
    return binding;
  } catch (error) {
    for (const file of copied) try { unlinkSync(file); } catch { /* preserve the original error */ }
    throw error;
  }
}
