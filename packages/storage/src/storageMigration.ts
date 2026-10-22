import type { MarketQualityState } from "@workspace/core/quality-timeline";
import type { JournalRecord, EventJournal } from "./eventJournal";
import { SnapshotStore } from "./snapshotStore";
import { randomUUID } from "node:crypto";
import { canonical, checksum, decode, EMPTY_HASH, insist, type SqliteCatalog } from "./sqliteCatalog";

export interface RecordIndex extends Omit<JournalRecord, "input"> {
  eventCount: number;
  isSnapshot: boolean;
  isQuality: boolean;
  qualityEndNs: string | null;
}
export interface SegmentInfo {
  schemaVersion: 2;
  formatVersion: 1;
  segmentId: string;
  scopeId: string;
  source: string;
  instrumentId: string;
  session: string;
  channel: string;
  startNs: string;
  endNs: string; // exclusive; BigInt comparison, not lexicographic
  recordCount: number;
  positions: string[];
  checksum: string;
  bodyChecksum: string;
  bytes: number;
  filename: string;
  finalizationStatus: "FINALIZED" | "DELETING" | "DELETED" | "CORRUPT";
}
export interface RetentionAnchor {
  schemaVersion: 2;
  kind: "RETENTION_STATE_NOT_EXCHANGE_SNAPSHOT";
  scopeId: string;
  auditPosition: string;
  lastAppliedPosition: string | null;
  clockAligned: boolean;
  state: MarketQualityState;
  /** Only the nearest normal checkpoint, stripped of historical fingerprints. */
  precedingCheckpoint: { checkpointNs: string; state: MarketQualityState } | null;
}
export interface StorageState {
  schemaVersion: 2;
  formatVersion: 1;
  floorPosition: string;
  floorHash: string;
  cutoffNs: string | null;
  durableThrough: string;
  indexRoot: string;
  segmentsRoot: string;
  anchorsRoot: string;
  /** Payloads deleted by committed intent, with original hash-chain descriptors retained as proof. */
  retiredPositions?: string[];
  pendingRetention?: {
    floorPosition: string; floorHash: string; cutoffNs: string;
    purgedPositions: string[]; retiredPositions: string[];
    segmentIds: string[]; anchors: RetentionAnchor[];
    snapshots: { scopeId: string; atNs: string; payload: string; checksum: string; auditPosition: string }[];
  };
}
export const isV2 = (c: SqliteCatalog): boolean => c.database.pragma("user_version", { simple: true }) === 2;
export function descriptor(r: JournalRecord): RecordIndex {
  const { input, ...rest } = r;
  const events = input.type === "EVENT" ? [input.event] : input.type === "BATCH" ? input.events : [];
  return { ...rest, eventCount: events.length, isSnapshot: events.some(e => e.kind === "L2_SNAPSHOT"),
    isQuality: input.type === "QUALITY_INTERVAL",
    qualityEndNs: input.type === "QUALITY_INTERVAL" ? input.interval.endNs : null };
}
function rows<T>(c: SqliteCatalog, table: string, key: string): T[] {
  const values = c.database.prepare(`SELECT payload,checksum FROM ${table} ORDER BY ${key}`).all() as { payload: string; checksum: string }[];
  return values.map(r => {
    const value = decode<T>(r.payload);
    insist(checksum(value) === r.checksum, "CATALOG_CHECKSUM", `${table} metadata corrupt`);
    return value;
  });
}
export const indices = (c: SqliteCatalog): RecordIndex[] => rows(c, "r15_records", "position");
export function liveIndices(c: SqliteCatalog): RecordIndex[] {
  const retired = new Set(storageState(c).retiredPositions ?? []);
  return indices(c).filter(r => !retired.has(r.position));
}
export const segments = (c: SqliteCatalog): SegmentInfo[] => rows(c, "r15_segments", "id");
export const anchors = (c: SqliteCatalog): RetentionAnchor[] => rows(c, "r15_anchors", "scope_id");
export const anchorFor = (c: SqliteCatalog, scopeId: string): RetentionAnchor | undefined =>
  isV2(c) ? anchors(c).find(a => a.scopeId === scopeId) : undefined;
export function storageState(c: SqliteCatalog): StorageState {
  const row = c.database.prepare("SELECT payload,checksum FROM r15_meta WHERE id=1").get() as { payload: string; checksum: string } | undefined;
  insist(row, "CATALOG_MISSING", "R15 manifest missing");
  const s = decode<StorageState>(row.payload);
  insist(checksum(s) === row.checksum && s.schemaVersion === 2 && s.formatVersion === 1,
    "CATALOG_CHECKSUM", "R15 manifest corrupt/unsupported");
  return s;
}
export function saveStorageState(c: SqliteCatalog, state: StorageState): void {
  const value = {
    ...state, durableThrough: c.manifest().recordCount,
    indexRoot: checksum(indices(c)), segmentsRoot: checksum(segments(c)), anchorsRoot: checksum(anchors(c)),
  };
  c.database.prepare("INSERT OR REPLACE INTO r15_meta VALUES (1,?,?)").run(canonical(value), checksum(value));
}
export function insertIndex(c: SqliteCatalog, r: JournalRecord): void {
  const d = descriptor(r);
  c.database.prepare("INSERT INTO r15_records VALUES (?,?,?,?,?,?,?)").run(
    BigInt(d.position), d.scopeId, d.channel, d.eventNs === null ? null : BigInt(d.eventNs),
    BigInt(d.receiveNs), canonical(d), checksum(d));
}
export function putSegment(c: SqliteCatalog, s: SegmentInfo): void {
  c.database.prepare("INSERT OR REPLACE INTO r15_segments VALUES (?,?,?)").run(s.segmentId, canonical(s), checksum(s));
}
export type IndexLookupMode = "map" | "find-reference";
export interface IndexLookupMeasurement {
  mode: IndexLookupMode;
  descriptorEntries: number;
  indexedRows: number;
  matchedRows: number;
  mapEntries: number;
  buildMs: number;
  lookupAndCompareMs: number;
  totalMs: number;
}
type IndexColumnRow = {
  position: bigint; scope_id: string; channel: string; event_ns: bigint | null; receive_ns: bigint;
};
// Only diagnostic mode/observer values live across calls. NEVER retain descriptors or lookup Maps here.
const indexDiagnostics = new WeakMap<SqliteCatalog, {
  mode: IndexLookupMode; observe?: (m: IndexLookupMeasurement) => void;
}>();
/** Node diagnostic/reference selection, per catalog; does not alter any persisted setting or schema. */
export function selectIndexLookupForDiagnostics(c: SqliteCatalog, mode: IndexLookupMode,
  observe?: (m: IndexLookupMeasurement) => void): () => void {
  insist(mode === "map" || mode === "find-reference", "DIAGNOSTIC_MODE", "Unknown index lookup mode");
  const previous = indexDiagnostics.get(c);
  indexDiagnostics.set(c, { mode, observe });
  return () => { if (previous) indexDiagnostics.set(c, previous); else indexDiagnostics.delete(c); };
}
/** Shared structural checks + the original field comparisons. Exported for adversarial reference tests. */
export function verifyIndexColumns(index: readonly RecordIndex[], indexed: readonly IndexColumnRow[],
  mode: IndexLookupMode = "map", observe?: (m: IndexLookupMeasurement) => void): void {
  insist(mode === "map" || mode === "find-reference", "DIAGNOSTIC_MODE", "Unknown index lookup mode");
  const start = observe ? performance.now() : 0;
  insist(index.length === indexed.length, "CATALOG_INDEX", "Descriptor/index row counts differ");
  const positions = mode === "map" ? new Map<string, RecordIndex>() : new Set<string>();
  for (const d of index) {
    // Same key as the old string === bigint.toString() rule; no Number coercion or zero stripping.
    insist(typeof d.position === "string" && /^[1-9]\d*$/.test(d.position) &&
      BigInt(d.position) <= (1n << 63n) - 1n, "CATALOG_INDEX", "Invalid descriptor position");
    insist(!positions.has(d.position), "CATALOG_INDEX", "Duplicate descriptor position");
    if (positions instanceof Map) positions.set(d.position, d); else positions.add(d.position);
  }
  const built = observe ? performance.now() : 0, seenRows = new Set<string>();
  for (const r of indexed) {
    insist(typeof r.position === "bigint" && r.position > 0n && r.position <= (1n << 63n) - 1n,
      "CATALOG_INDEX", "Invalid SQLite index position");
    const key = r.position.toString();
    insist(!seenRows.has(key), "CATALOG_INDEX", "Duplicate SQLite index position");
    seenRows.add(key);
    const d = positions instanceof Map ? positions.get(key) : index.find(v => v.position === r.position.toString());
    insist(d, "CATALOG_INDEX", "Unknown SQLite index position");
    insist(d.scopeId === r.scope_id && d.channel === r.channel &&
      d.eventNs === (r.event_ns?.toString() ?? null) && d.receiveNs === r.receive_ns.toString(),
    "CATALOG_INDEX", "Search index differs from protected metadata");
  }
  insist(seenRows.size === positions.size, "CATALOG_INDEX", "Missing SQLite index position");
  if (observe) {
    const end = performance.now();
    observe({mode,descriptorEntries:index.length,indexedRows:indexed.length,matchedRows:seenRows.size,
      mapEntries:positions instanceof Map ? positions.size : 0,
      buildMs:built-start,lookupAndCompareMs:end-built,totalMs:end-start});
  }
}
export function verifyMetadata(c: SqliteCatalog, allowPending = false): void {
  verifiedMetadata(c, allowPending);
}
/** Complete metadata verification only. This does NOT certify any original event bytes. */
function verifiedMetadata(c: SqliteCatalog, allowPending = false) {
  const state = storageState(c), index = indices(c), segs = segments(c), seeds = anchors(c);
  insist(allowPending || !state.pendingRetention, "RETENTION_PENDING", "Resume the committed retention intent before querying");
  insist(state.indexRoot === checksum(index) && state.segmentsRoot === checksum(segs) &&
    state.anchorsRoot === checksum(seeds), "CATALOG_MANIFEST", "Missing or changed R15 metadata");
  let position = BigInt(state.floorPosition), previous = state.floorHash;
  for (const r of index) {
    insist(BigInt(r.position) === ++position && r.previousHash === previous,
      "JOURNAL_CONTINUITY", "Uncertified missing journal position");
    previous = r.checksum;
  }
  const legacy = c.manifest();
  const retired = state.retiredPositions ?? [];
  insist(new Set(retired).size === retired.length && retired.every(p => index.some(r => r.position === p)) &&
    retired.every(p => segs.some(s => s.finalizationStatus === "DELETED" && s.positions.includes(p))),
    "RETENTION_CERTIFICATE", "Missing committed deletion evidence");
  insist(position.toString() === legacy.recordCount && previous === legacy.head &&
    state.durableThrough === legacy.recordCount, "DURABLE_POSITION", "Committed position/head differs");
  const indexed = c.database.prepare("SELECT position,scope_id,channel,event_ns,receive_ns FROM r15_records").safeIntegers().all() as
    { position: bigint; scope_id: string; channel: string; event_ns: bigint | null; receive_ns: bigint }[];
  const diagnostic = indexDiagnostics.get(c);
  verifyIndexColumns(index, indexed, diagnostic?.mode ?? "map", diagnostic?.observe);
  return { index, retired };
}

export interface CommitReadMeasurement {
  preflightMs: number; guardMs: number; metadataMs: number; originalReadMs: number;
  setupMs: number; freezeMs: number; disposeMs: number;
  descriptors: number; serializedBytes: number; success: boolean;
  error?: string;
}
const commitReadDiagnostics = new WeakMap<SqliteCatalog, {
  mode: "reuse" | "reference"; observe?: (m: CommitReadMeasurement) => void;
  fault?: (phase: "verified" | "originals-read") => void;
}>();
/** Finite Node diagnostics only; no view, descriptor, token or persisted configuration escapes. */
export function selectCommitReadForDiagnostics(c: SqliteCatalog, mode: "reuse" | "reference",
  observe?: (m: CommitReadMeasurement) => void,
  fault?: (phase: "verified" | "originals-read") => void): () => void {
  const previous = commitReadDiagnostics.get(c);
  commitReadDiagnostics.set(c, { mode, observe, fault });
  return () => { if (previous) commitReadDiagnostics.set(c, previous); else commitReadDiagnostics.delete(c); };
}
// Approval of the temporary budget is LIMITED to finite R16.3 MOCK validation.
// Existing/default writers and old diagnostic observers retain their independent reference path.
export const usesCommitMetadataRead = (c: SqliteCatalog): boolean => commitReadDiagnostics.get(c)?.mode === "reuse";

// One synchronous read view process-wide; no across-commit cache. The token never leaves this module.
let activeReadToken: symbol | null = null;
const MAX_DESCRIPTORS = 16_384n, MAX_DESCRIPTOR_BYTES = 16n * 1024n * 1024n;
/** Private metadata only; never an original-event certificate or a cross-call cache. */
interface VerifiedMetadataView {
  readonly index: readonly RecordIndex[];
  readonly retired: readonly string[];
}

/**
 * Internal private-write helper, NOT a replacement for public read/replay.
 * The only consumer is EventJournal.private commit, inside its existing native transaction.
 * A local SAVEPOINT is a transaction-identity sentinel, not a new commit/rollback boundary.
 * RELEASE must succeed on every check: COMMIT/ROLLBACK followed by BEGIN cannot reuse the token.
 */
export function readCommitOriginals(c: SqliteCatalog, scopeId: string,
  readOriginals: (descriptors: readonly RecordIndex[]) => JournalRecord[]): JournalRecord[] {
  insist(c.database.inTransaction && !activeReadToken, "READ_TRANSACTION", "One active write-transaction metadata view required");
  const setupStart = performance.now();
  const db = c.database, token = Symbol("commit-read"), sentinel = `c1_${randomUUID().replaceAll("-", "")}`;
  const measurement: CommitReadMeasurement = { preflightMs: 0, guardMs: 0, metadataMs: 0, originalReadMs: 0,
    setupMs: 0, freezeMs: 0, disposeMs: 0,
    descriptors: 0, serializedBytes: 0, success: false };
  const diagnostic = commitReadDiagnostics.get(c), nativeExec = db.exec;
  const execDescriptor = Object.getOwnPropertyDescriptor(db, "exec");
  // Statement prototype hooks cover statements prepared BEFORE this read phase as well.
  // No await/callback publication; all hooks are restored before semantic replay/INSERT.
  const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as Record<string, Function>;
  const originals = new Map<string, PropertyDescriptor>();
  let mutations = 0, created = false;
  activeReadToken = token;
  const exec = (sql: string) => Reflect.apply(nativeExec, db, [sql]);
  const stamp = (): string => {
    const changes = db.prepare("SELECT total_changes() AS n").safeIntegers().get() as { n: bigint };
    return [changes.n.toString(), db.pragma("data_version", { simple: true }),
      db.pragma("schema_version", { simple: true }), db.pragma("user_version", { simple: true }), mutations].join(":");
  };
  let generation = "";
  const guard = () => {
    const start = performance.now();
    try {
      insist(c.database === db && db.open, "READ_CONNECTION", "Metadata belongs to another/closed connection");
      insist(activeReadToken === token && db.inTransaction, "READ_TRANSACTION", "Expired transaction token");
      insist(stamp() === generation, "READ_GENERATION", "DML/DDL/pragma changed the read generation");
      // data_version excludes this connection's own writes; total_changes includes rolled-back DML
      // but not DDL. Statement/exec mutation hooks cover DDL, no-op writes and restored pragmas.
      // Neither is a transaction ID. The unexported sentinel additionally certifies that identity.
      try { exec(`RELEASE SAVEPOINT ${sentinel}`); exec(`SAVEPOINT ${sentinel}`); }
      catch { insist(false, "READ_TRANSACTION", "Original native transaction ended; token cannot be reused"); }
    } finally { measurement.guardMs += performance.now() - start; }
  };
  try {
    exec(`SAVEPOINT ${sentinel}`); created = true;
    for (const method of ["run", "get", "all", "iterate"]) {
      const own = Object.getOwnPropertyDescriptor(proto, method)!; originals.set(method, own);
      const native = own.value;
      Object.defineProperty(proto, method, { ...own, value: function(this: {
        database: typeof db; readonly: boolean; source: string;
      }, ...args: unknown[]) {
        if (this.database === db && (!this.readonly ||
          /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(this.source))) mutations++;
        return Reflect.apply(native, this, args);
      } });
    }
    db.exec = function(this: typeof db, ...args: Parameters<typeof nativeExec>) {
      if (this === db) mutations++;
      return Reflect.apply(nativeExec, this, args);
    } as typeof db.exec;
    generation = stamp();
    measurement.setupMs = performance.now() - setupStart;
    const before = performance.now();
    // Preflight BEFORE .all()/decode/allocation. Counts are BigInt, byte length is UTF-8 BLOB length.
    try {
    const count = db.prepare("SELECT COUNT(*) AS n FROM r15_records").safeIntegers().get() as { n: bigint };
    insist(count.n <= MAX_DESCRIPTORS, "READ_BUDGET", `STOP_REQUIRED: ${count.n} descriptors exceed finite MOCK read budget`);
    const bytes = db.prepare("SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM r15_records")
      .safeIntegers().get() as { n: bigint };
    insist(bytes.n <= MAX_DESCRIPTOR_BYTES, "READ_BUDGET", `STOP_REQUIRED: ${bytes.n} serialized bytes exceed finite MOCK read budget`);
    measurement.descriptors = Number(count.n); measurement.serializedBytes = Number(bytes.n);
    } finally { measurement.preflightMs = performance.now() - before; }
    guard();
    const verifyStart = performance.now();
    const view: VerifiedMetadataView = verifiedMetadata(c), { index, retired } = view;
    measurement.metadataMs = performance.now() - verifyStart;
    // All descriptor fields are primitives. No writable descriptor is exposed to the consumer.
    const freezeStart = performance.now();
    for (const d of index) Object.freeze(d);
    Object.freeze(index);
    measurement.freezeMs = performance.now() - freezeStart;
    diagnostic?.fault?.("verified");
    guard();
    const retiredPositions = new Set(retired);
    const selected = Object.freeze(index.filter(d => d.scopeId === scopeId && !retiredPositions.has(d.position)));
    const readStart = performance.now(), records = readOriginals(selected);
    measurement.originalReadMs = performance.now() - readStart;
    insist(Array.isArray(records), "READ_ASYNC", "Original reader must complete synchronously");
    diagnostic?.fault?.("originals-read");
    guard();
    // Dispose before returning to replay, and necessarily before any INSERT.
    exec(`RELEASE SAVEPOINT ${sentinel}`); created = false;
    measurement.success = true;
    return records;
  } catch (error) {
    measurement.error = String(error);
    throw error;
  } finally {
    const disposeStart = performance.now();
    if (created && db.open && db.inTransaction) {
      try { exec(`RELEASE SAVEPOINT ${sentinel}`); } catch { /* preserve original rejection */ }
    }
    for (const [key, descriptor] of originals) Object.defineProperty(proto, key, descriptor);
    if (execDescriptor) Object.defineProperty(db, "exec", execDescriptor); else Reflect.deleteProperty(db, "exec");
    activeReadToken = null;
    measurement.disposeMs = performance.now() - disposeStart;
    diagnostic?.observe?.(measurement);
  }
}
export function compactState(state: MarketQualityState, cutoffNs: string, keep?: ReadonlySet<string>): MarketQualityState {
  const cutoff = BigInt(cutoffNs);
  return {
    ...state,
    guard: { heads: new Map(state.guard.heads),
      seen: new Map([...state.guard.seen].filter(([, fp]) => !keep || keep.has(fp))) },
    timeline: Object.fromEntries(Object.entries(state.timeline).map(([ch, intervals]) =>
      [ch, intervals.filter(q => q.endNs === null || BigInt(q.endNs) >= cutoff)])) as unknown as MarketQualityState["timeline"],
  };
}
export function refreshSnapshotManifest(c: SqliteCatalog): void {
  const rows = c.database.prepare("SELECT scope_id,at_ns,checksum FROM snapshots ORDER BY scope_id,at_ns").safeIntegers().all() as
    { scope_id: string; at_ns: bigint; checksum: string }[];
  c.setManifest({ ...c.manifest(), snapshotCount: rows.length.toString(),
    snapshotHead: checksum(rows.map(r => [r.scope_id, r.at_ns.toString(), r.checksum])) });
}
/** No auto migration. Caller explicitly requests this against its chosen DB. */
export function migrateToV2(journal: EventJournal, beforeCommit?: () => void) {
  const c = journal.catalog;
  if (isV2(c)) { verifyMetadata(c); return { migrated: false, recordCount: c.manifest().recordCount }; }
  journal.verify(); new SnapshotStore(journal).verify();
  const original = journal.records(), beforeHash = checksum(original);
  c.transaction(() => {
    c.database.exec(`
      CREATE TABLE r15_meta(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
      CREATE TABLE r15_records(position INTEGER PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),
        channel TEXT NOT NULL,event_ns INTEGER,receive_ns INTEGER NOT NULL,payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
      CREATE INDEX r15_range ON r15_records(scope_id,channel,event_ns,position);
      CREATE TABLE r15_segments(id TEXT PRIMARY KEY,payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
      CREATE TABLE r15_anchors(scope_id TEXT PRIMARY KEY REFERENCES scopes(id),payload TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;
    `);
    for (const r of original) insertIndex(c, r);
    saveStorageState(c, { schemaVersion: 2, formatVersion: 1,
      floorPosition: "0", floorHash: EMPTY_HASH, cutoffNs: null, durableThrough: c.manifest().recordCount,
      indexRoot: "", segmentsRoot: "", anchorsRoot: "" });
    c.database.pragma("user_version=2");
    beforeCommit?.();
  });
  insist(checksum(journal.records()) === beforeHash, "MIGRATION_CONTENT", "Migration changed original data");
  return { migrated: true, recordCount: c.manifest().recordCount, checksum: beforeHash };
}
