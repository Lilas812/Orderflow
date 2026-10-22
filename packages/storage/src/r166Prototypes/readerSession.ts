import Database from "better-sqlite3";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { canonical, checksum, EMPTY_HASH, insist, type Manifest } from "../sqliteCatalog";
import { descriptor, type RecordIndex, type SegmentInfo, type StorageState } from "../storageMigration";
import type { JournalRecord } from "../eventJournal";
import { arrayHasher, canonicalDigest } from "./canonicalStream";
import { originalAt, sqlPages } from "./boundedSqlReader";
import { verifySegment, type VerifiedSpool } from "./boundedSegmentReader";
import { rawBinding, verifyRawShape, type RawBinding } from "./atomicJournalHarness";
import { SqliteLedger, type LedgerReceipt, type OwnedLedgerLocation } from "./sqliteLedger";

const TRIAL = Symbol("explicit-p1-c1-trial-reader");
interface TrialOptions { token: typeof TRIAL; receipt: LedgerReceipt; expected: {
  scopeId: string; epoch: string; coverage: "FULL_SCOPE_FROM_START" | "UNPROVEN";
} }

/** MOCK-only planning limits, NOT vendor/CME limits. JS accounting is conservative
 * byte estimation, not a hard process RSS guarantee. SQLite cache is separate. */
export interface ReaderBudget {
  readBufferBytes: number; recordBytes: number; workingBytes: number; spoolBytes: number;
}
export const MOCK_BUDGET: Readonly<ReaderBudget> = Object.freeze({
  readBufferBytes: 1024 * 1024, recordBytes: 1024 * 1024,
  workingBytes: 16 * 1024 * 1024, spoolBytes: 64 * 1024 * 1024,
});
export function validateBudget(budget: ReaderBudget): void {
  for (const key of Object.keys(MOCK_BUDGET) as (keyof ReaderBudget)[]) {
    insist(Number.isSafeInteger(budget[key]) && budget[key] > 0 && budget[key] <= MOCK_BUDGET[key],
      "BUDGET_EXCEEDED", `Invalid MOCK ${key}`);
  }
  insist(budget.readBufferBytes + budget.recordBytes < budget.workingBytes,
    "BUDGET_EXCEEDED", "No decoded working space");
}
export class ReaderSession {
  readonly db: Database.Database;
  readonly budget: ReaderBudget;
  readonly version: 1 | 2;
  readonly manifest: Manifest;
  private stamp: string;
  private token = "";
  private closed = false;
  private reserved = 0;
  private trial: RawBinding | null = null;
  /** This entry is separate from the production-schema constructor. The caller supplies independent
   * ledger evidence AND the expected scope, epoch and coverage. Never return an unverified session. */
  static openPrototype(location: OwnedLedgerLocation, receipt: LedgerReceipt,
    expected: TrialOptions["expected"], options: Partial<ReaderBudget> = {}): ReaderSession {
    const ledger = SqliteLedger.open(location, receipt);
    try {
      const snapshot = ledger.verify(receipt);
      insist(snapshot.scopeId === expected.scopeId && snapshot.epoch === expected.epoch &&
        snapshot.coverage === expected.coverage, "RAW_BINDING", "Requested ledger scope/epoch/coverage differs");
      insist(snapshot.coverage === "FULL_SCOPE_FROM_START", "COVERAGE_UNPROVEN",
        "Unproven ledger cannot bind complete original history");
    } finally { ledger.close(); }
    const session = new ReaderSession(join(location.directory, "prototype-ledger.sqlite"),
      options, { token: TRIAL, receipt, expected });
    try {
      verifyReaderSession(session); // NO prefix/session published until full P1-A verification.
      return session;
    } catch (error) { session.close(); throw error; }
  }
  constructor(readonly filename: string, options: Partial<ReaderBudget> = {}, trial?: TrialOptions) {
    this.budget = Object.freeze({ ...MOCK_BUDGET, ...options });
    validateBudget(this.budget);
    const stat = lstatSync(filename);
    insist(stat.isFile() && !stat.isSymbolicLink(), "SQL_PATH", "Regular DB only");
    this.stamp = `${stat.dev}:${stat.ino}`;
    this.db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      // Connection-local only: no persisted settings or product Writer changes.
      this.db.pragma("query_only=ON"); this.db.pragma("cache_size=-2048");
      this.db.pragma("mmap_size=0"); this.db.pragma("temp_store=FILE");
      this.db.exec("BEGIN"); // owned deferred read transaction; first read pins snapshot
      const version = this.db.pragma("user_version", { simple: true });
      const app = this.db.pragma("application_id", { simple: true });
      if (trial?.token === TRIAL) {
        insist(version === 1 && app === 0x5031424c, "SCHEMA", "Trial DB application/version mismatch");
        this.trial = rawBinding(this.db);
        const binding = this.trial;
        insist(binding.scopeId === trial.expected.scopeId && binding.epoch === trial.expected.epoch &&
          binding.coverage === trial.expected.coverage && binding.ledgerRoot === trial.receipt.root &&
          binding.ledgerMetadataChecksum === trial.receipt.metadataChecksum,
        "RAW_BINDING", "Unbound original/ledger snapshot");
        verifyRawShape(this.db, binding.rawVersion);
        insist(this.db.pragma("quick_check", { simple: true }) === "ok", "RAW_LAYOUT", "SQLite integrity failed");
        const ledgerRow = this.db.prepare(`SELECT CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN payload END AS payload,
          CASE WHEN length(checksum)=64 THEN checksum END AS checksum FROM ledger_meta WHERE id=1`)
          .get() as { payload: string | null; checksum: string | null } | undefined;
        insist(ledgerRow?.payload && ledgerRow.checksum, "RAW_BINDING", "Missing ledger header");
        const header = JSON.parse(ledgerRow.payload) as { root: string; scopeId: string;
          epoch: string; coverage: string };
        insist(checksum(header) === ledgerRow.checksum && ledgerRow.checksum === trial.receipt.metadataChecksum &&
          header.root === trial.receipt.root && header.scopeId === binding.scopeId &&
          header.epoch === binding.epoch && header.coverage === binding.coverage,
        "RAW_BINDING", "Ledger generation changed");
        // Physical user_version=1 remains unchanged. version here selects the independently
        // validated raw layout for the existing P1-A verifier, not the trial DB's schema ID.
        this.version = binding.rawVersion;
      } else {
        insist(!trial && (version === 1 || version === 2) && app === 0x4f464c42,
          "SCHEMA", "Existing v1/v2 only");
        this.version = version;
      }
      this.manifest = this.metadata<Manifest>("meta", "key='manifest'");
      insist(this.manifest.schemaVersion === 1 && /^(0|[1-9]\d*)$/.test(this.manifest.recordCount) &&
        /^[a-f0-9]{64}$/.test(this.manifest.head), "MANIFEST", "Invalid manifest");
      if (this.trial) {
        insist(this.manifest.head === this.trial.manifestHead &&
          this.manifest.recordCount === this.trial.manifestCount, "RAW_BINDING", "Original head/count changed");
        if (this.version === 2) {
          const state = this.metadata<StorageState>("r15_meta", "id=1");
          insist(state.indexRoot === this.trial.indexRoot, "RAW_BINDING", "Index root changed");
        } else insist(this.trial.indexRoot === null, "RAW_BINDING", "v1 cannot bind v2 index");
      }
      this.token = this.generation();
    } catch (e) { this.db.close(); throw e; }
  }
  metadata<T>(table: "meta" | "r15_meta", where: "key='manifest'" | "id=1"): T {
    const r = this.db.prepare(`SELECT CASE WHEN length(checksum)=64 THEN checksum ELSE NULL END AS checksum,
      length(CAST(payload AS BLOB)) AS bytes,
      CASE WHEN length(CAST(payload AS BLOB))<=? THEN CAST(payload AS BLOB) ELSE NULL END AS payload FROM ${table} WHERE ${where}`)
      .get(this.budget.recordBytes) as { checksum: string | null; bytes: number; payload: Buffer | null } | undefined;
    insist(r, "METADATA", "Missing metadata");
    insist(r.payload !== null && r.bytes * 16 <= this.budget.workingBytes,
      "BUDGET_EXCEEDED", "Metadata exceeds working budget");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(r.payload)) as T;
    insist(canonicalDigest(value) === r.checksum, "METADATA_CHECKSUM", "Metadata checksum differs");
    return value;
  }
  private generation(): string {
    const m = this.db.prepare("SELECT CASE WHEN length(checksum)=64 THEN checksum ELSE NULL END AS checksum FROM meta WHERE key='manifest'").get();
    const r = this.version === 2 ? this.db.prepare("SELECT CASE WHEN length(checksum)=64 THEN checksum ELSE NULL END AS checksum FROM r15_meta WHERE id=1").get() : null;
    const b = this.trial ? this.db.prepare("SELECT checksum FROM r166_raw_layout WHERE id=1").get() : null;
    const l = this.trial ? this.db.prepare("SELECT checksum FROM ledger_meta WHERE id=1").get() : null;
    return canonical([this.db.pragma("data_version", { simple: true }),
      this.db.pragma("schema_version", { simple: true }), this.db.pragma("application_id", { simple: true }),
      this.db.pragma("user_version", { simple: true }), this.db.prepare("SELECT total_changes() AS n").get(), m, r, b, l]);
  }
  reserveWorking(bytes: number): () => void {
    insist(Number.isSafeInteger(bytes) && bytes >= 0 && this.reserved + bytes <= this.budget.workingBytes,
      "BUDGET_EXCEEDED", "Aggregate decoded/buffer working budget");
    this.reserved += bytes;
    let released = false;
    return () => { if (!released) { released = true; this.reserved -= bytes; } };
  }
  assertPinned(): void {
    insist(!this.closed && this.db.inTransaction && this.db.readonly, "GENERATION_CHANGED", "Read transaction lost");
    const s = lstatSync(this.filename);
    insist(!s.isSymbolicLink() && `${s.dev}:${s.ino}` === this.stamp && this.generation() === this.token,
      "GENERATION_CHANGED", "Cursor/generation/file identity changed");
    // Concurrent WAL commits remain invisible in this pinned snapshot. No pages
    // are reopened under a newer generation. No claim to freeze external chunks.
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      try { if (this.db.inTransaction) this.db.exec("ROLLBACK"); } finally { this.db.close(); }
    }
  }
}

export interface ReaderReceipt {
  records: number; originalsHash: string; indexRoot: string | null;
  mirroredRecords: number; chunkRecords: number; chunks: number;
}
/** Full finite, unretired v1/v2 prototype verification, not semantic replay.
 * Retained manifests/seeds need P2 proof handling: explicit refusal, never skip.
 * No record callback is exposed. Receipt is returned only after ALL verification. */
export function verifyReaderSession(session: ReaderSession, pageRows = 64): ReaderReceipt {
  session.assertPinned();
  const originals = arrayHasher(), indexHash = arrayHasher();
  let previous = EMPTY_HASH, count = 0, mirrored = 0, chunkRecords = 0, sqlCount = 0;
  const spools: { spool: VerifiedSpool; head: JournalRecord | undefined }[] = [];
  const releases: (() => void)[] = [];
  try {
    let expected = Number(session.manifest.recordCount);
    insist(Number.isSafeInteger(expected), "BUDGET_EXCEEDED", "Finite prototype count exceeds safe range");
    let state: StorageState | undefined;
    if (session.version === 2) {
      state = session.metadata<StorageState>("r15_meta", "id=1");
      insist(state.schemaVersion === 2 && state.formatVersion === 1 && !state.pendingRetention &&
        state.floorPosition === "0" && state.floorHash === EMPTY_HASH &&
        state.cutoffNs === null && !(state.retiredPositions?.length),
      "UNSUPPORTED_RETENTION", "P1-A does not certify retirement/anchor semantics");
      insist(state.durableThrough === session.manifest.recordCount, "DURABLE_POSITION", "High watermark differs");
      const segHash = arrayHasher(), anchorHash = arrayHasher();
      let spoolTotal = 0;
      for (const table of ["r15_segments", "r15_anchors"] as const) {
        // Indexed order, one row at a time. No SQL sort-temp or full .all().
        const key = table === "r15_segments" ? "id" : "scope_id";
        const query = `SELECT CASE WHEN length(CAST(${key} AS BLOB))<=@maxBytes THEN ${key} ELSE NULL END AS key,
          CASE WHEN length(checksum)=64 THEN checksum ELSE NULL END AS checksum,length(CAST(payload AS BLOB)) AS bytes,
          CASE WHEN length(CAST(payload AS BLOB))<=@maxBytes THEN CAST(payload AS BLOB) ELSE NULL END AS payload FROM ${table} ORDER BY ${key}`;
        const plan = session.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all({ maxBytes: session.budget.recordBytes }) as { detail: string }[];
        insist(plan.length <= 4 && plan.every(p => !/TEMP/i.test(p.detail)),
          "SQL_PLAN", "Metadata sort/temp plan rejected");
        const statement = session.db.prepare(query);
        for (const row of statement.iterate({ maxBytes: session.budget.recordBytes }) as Iterable<{
          key: string | null; checksum: string | null; bytes: number; payload: Buffer | null;
        }>) {
          insist(row.payload !== null && row.bytes * 16 <= session.budget.workingBytes,
            "BUDGET_EXCEEDED", "Segment/anchor metadata budget");
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(row.payload));
          insist(canonicalDigest(value) === row.checksum, "METADATA_CHECKSUM", "Metadata row changed");
          (table === "r15_segments" ? segHash : anchorHash).add(value);
          insist(table !== "r15_anchors", "UNSUPPORTED_RETENTION", "Unexpected retention anchor");
          const info = value as SegmentInfo;
          insist(row.key === info.segmentId && info.finalizationStatus === "FINALIZED", "SEGMENT_METADATA", "Unsafe segment");
          // Keep only bounded metadata, buffers and one decoded head per chunk.
          const maxHead = Math.min(info.bytes, session.budget.recordBytes) * 16;
          releases.push(session.reserveWorking(row.bytes * 16 + session.budget.readBufferBytes +
            session.budget.recordBytes + maxHead + 4096));
          spoolTotal += info.bytes;
          insist(spoolTotal <= session.budget.spoolBytes, "BUDGET_EXCEEDED", "Total private spool disk budget");
          const spool = verifySegment(join(dirname(session.filename), "market-cache", "segments", info.filename),
            info, session.budget);
          const entry = { spool, head: undefined as JournalRecord | undefined };
          spools.push(entry); entry.head = spool.next();
        }
      }
      insist(segHash.finish() === state.segmentsRoot && anchorHash.finish() === state.anchorsRoot,
        "METADATA_ROOT", "Segments/anchors root mismatch");
    }
    for (const page of sqlPages(session, session.version === 1 ? "records" : "r15_records", {
      through: session.manifest.recordCount, expectedCount: expected, pageRows,
    })) for (const d of page) {
      let r: JournalRecord | undefined = session.version === 1 ? d as JournalRecord : originalAt(session, d.position);
      if (r) sqlCount++;
      let matchedChunk = false;
      for (const item of spools) {
        insist(!item.head || BigInt(item.head.position) >= BigInt(d.position), "ORPHAN_CHUNK", "Unindexed chunk record");
        if (item.head?.position === d.position) {
          if (r) {
            insist(canonicalDigest(r) === canonicalDigest(item.head) && canonical(r) === canonical(item.head),
              "MIRROR_CONFLICT", "SQL/chunk originals differ");
            mirrored++;
          }
          r = item.head; matchedChunk = true; item.head = item.spool.next();
        }
      }
      insist(r, "RAW_SOURCE_MISSING", "No original for descriptor");
      if (matchedChunk) chunkRecords++;
      if (session.version === 2) {
        insist(canonical(descriptor(r)) === canonical(d), "INDEX_COLUMNS", "Descriptor/original differs");
        indexHash.add(d);
      }
      insist(r.previousHash === previous, "JOURNAL_CONTINUITY", "Broken checksum chain");
      previous = r.checksum; originals.add(r); count++;
    }
    for (const item of spools) insist(!item.head, "ORPHAN_CHUNK", "Unindexed tail record");
    const actualSqlCount = session.db.prepare("SELECT count(*) AS n FROM records").safeIntegers().get() as { n: bigint };
    insist(actualSqlCount.n === BigInt(sqlCount), "ORPHAN_SQL", "Unindexed SQL rows");
    const root = session.version === 2 ? indexHash.finish() : null;
    insist(!state || root === state.indexRoot, "INDEX_ROOT", "Descriptor root mismatch");
    insist(count === expected && previous === session.manifest.head, "JOURNAL_HEAD", "Manifest head/count mismatch");
    session.assertPinned();
    return { records: count, originalsHash: originals.finish(), indexRoot: root,
      mirroredRecords: mirrored, chunkRecords, chunks: spools.length };
  } finally {
    for (const item of spools) item.spool.close();
    for (const release of releases) release();
  }
}
