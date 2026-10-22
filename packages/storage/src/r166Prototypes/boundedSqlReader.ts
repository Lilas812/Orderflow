import type Database from "better-sqlite3";
import { TextDecoder } from "node:util";
import { inputMetadata, type JournalRecord } from "../eventJournal";
import { insist, sqliteNs } from "../sqliteCatalog";
import { type RecordIndex } from "../storageMigration";
import type { ReaderSession } from "./readerSession";
import { canonicalDigest } from "./canonicalStream";

export const MAX_PAGE_ROWS = 128;
type Row = Record<string, unknown>;
const MAX_POSITION = (1n << 63n) - 1n;
export function position(value: unknown, zero = false): bigint {
  insist(typeof value === "string" && (zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value),
    "POSITION", "Canonical position required");
  const result = BigInt(value);
  insist(result <= MAX_POSITION, "POSITION", "Position exceeds int64");
  return result;
}
export function validateOriginal(record: JournalRecord): void {
  insist(record && typeof record === "object", "RECORD", "Missing record");
  position(record.position); sqliteNs(record.receiveNs);
  if (record.eventNs !== null) sqliteNs(record.eventNs);
  insist(typeof record.scopeId === "string" && record.scopeId.length > 0 &&
    typeof record.applied === "boolean" && typeof record.outcome === "string" &&
    typeof record.reason === "string" && /^[0-9a-f]{64}$/.test(record.previousHash) &&
    /^[0-9a-f]{64}$/.test(record.checksum), "RECORD", "Invalid record columns");
  const { checksum: hash, ...body } = record;
  insist(Object.keys(record).length === 11 && canonicalDigest(body) === hash,
    "RECORD_CHECKSUM", "Original checksum/columns mismatch");
  const meta = inputMetadata(record.input);
  insist(meta.channel === record.channel && meta.eventNs === record.eventNs &&
    meta.receiveNs === record.receiveNs, "RECORD_METADATA", "Input and journal columns differ");
}
function exactColumns(row: Row, d: JournalRecord | RecordIndex): void {
  insist(typeof row.position === "bigint" && String(row.position) === d.position &&
    row.scope_id === d.scopeId && row.channel === d.channel &&
    (row.event_ns === null ? null : String(row.event_ns)) === d.eventNs &&
    String(row.receive_ns) === d.receiveNs, "INDEX_COLUMNS", "Search columns differ from payload");
}
function decodeRow(session: ReaderSession, row: Row, table: "records" | "r15_records"): JournalRecord | RecordIndex {
  insist(typeof row.row_bytes === "bigint" && row.row_bytes <= BigInt(session.budget.recordBytes),
    "BUDGET_EXCEEDED", "SQL full row exceeds record budget");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const key of textColumns(table)) {
    insist(Buffer.isBuffer(row[key]), "SQL_COLUMNS", "Missing or non-text column");
    row[key] = decoder.decode(row[key] as Buffer);
  }
  if (table === "records") {
    insist(row.applied === 0n || row.applied === 1n, "RECORD", "Invalid applied column");
    const r: JournalRecord = {
      position: String(row.position), scopeId: row.scope_id as string, channel: row.channel as JournalRecord["channel"],
      eventNs: row.event_ns === null ? null : String(row.event_ns), receiveNs: String(row.receive_ns),
      input: JSON.parse(row.payload as string), applied: row.applied === 1n,
      outcome: row.outcome as string, reason: row.reason as string,
      previousHash: row.previous_hash as string, checksum: row.checksum as string,
    };
    validateOriginal(r); exactColumns(row, r);
    return r;
  }
  const d = JSON.parse(row.payload as string) as RecordIndex;
  insist(d && typeof d === "object", "INDEX", "Descriptor is not an object");
  position(d.position); sqliteNs(d.receiveNs);
  if (d.eventNs !== null) sqliteNs(d.eventNs);
  insist(Object.keys(d).length === 14 && typeof d.scopeId === "string" &&
    ["L1", "L2_MBP", "TRADES"].includes(d.channel) && typeof d.applied === "boolean" &&
    typeof d.outcome === "string" && typeof d.reason === "string" &&
    /^[0-9a-f]{64}$/.test(d.checksum) && /^[0-9a-f]{64}$/.test(d.previousHash) &&
    Number.isSafeInteger(d.eventCount) && d.eventCount >= 0 && typeof d.isSnapshot === "boolean" &&
    typeof d.isQuality === "boolean" &&
    (d.qualityEndNs === null || typeof d.qualityEndNs === "string") &&
    canonicalDigest(d) === row.checksum, "INDEX_CHECKSUM", "Invalid descriptor/checksum");
  if (d.qualityEndNs !== null) sqliteNs(d.qualityEndNs);
  exactColumns(row, d);
  return d;
}
function select(table: "records" | "r15_records") {
  const texts = textColumns(table);
  const bytes = texts.map(c => `coalesce(length(CAST(${c} AS BLOB)),0)`).join("+");
  const columns = texts.map(c => `CASE WHEN ${bytes}<=@maxBytes THEN CAST(${c} AS BLOB) ELSE NULL END AS ${c}`);
  return `SELECT position,event_ns,receive_ns${table === "records" ? ",applied" : ""},
    ${columns.join(",")},(${bytes}) AS row_bytes FROM ${table}`;
}
function textColumns(table: "records" | "r15_records"): string[] {
  return table === "records" ? ["scope_id", "channel", "payload", "outcome", "reason", "previous_hash", "checksum"] :
    ["scope_id", "channel", "payload", "checksum"];
}
/** Page materialization is capped, statements fully finalized before yielding.
 * Caller supplies a pinned inclusive high-watermark and exact expected row count.
 * requireContiguous=false is ONLY for SQL copies mirrored by chunks; the session
 * still checks the complete descriptor chain and rejects every unaccounted hole. */
export function* sqlPages(session: ReaderSession, table: "records" | "r15_records",
  options: { pageRows?: number; through: string; expectedCount: number; after?: string; requireContiguous?: boolean },
): Generator<readonly (JournalRecord | RecordIndex)[]> {
  const pageRows = options.pageRows ?? 64;
  insist(Number.isSafeInteger(pageRows) && pageRows > 0 && pageRows <= MAX_PAGE_ROWS,
    "BUDGET_EXCEEDED", "pageRows outside explicit MOCK cap");
  const through = position(options.through, true);
  let cursor = position(options.after ?? "0", true), count = 0;
  insist(cursor <= through && Number.isSafeInteger(options.expectedCount) && options.expectedCount >= 0,
    "POSITION", "Invalid pinned range/count");
  const query = `${select(table)} WHERE position>@after AND position<=@through ORDER BY position LIMIT @rows`;
  const plan = session.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(
    { maxBytes: session.budget.recordBytes, after: cursor, through, rows: pageRows }) as { detail: string }[];
  insist(plan.length <= 4 && plan.every(p => !/TEMP|SCAN/i.test(p.detail)) &&
    plan.some(p => /INTEGER PRIMARY KEY/i.test(p.detail)), "SQL_PLAN", "Unbounded sort/scan plan rejected");
  const statement = session.db.prepare(query).safeIntegers();
  while (cursor < through) {
    session.assertPinned();
    const page: (JournalRecord | RecordIndex)[] = [];
    const releases: (() => void)[] = [];
    let charge = 0, next = cursor;
    try {
    // Never .all(): ALL text columns (not just payload) are masked in SQLite.
    for (const row of statement.iterate({
      maxBytes: session.budget.recordBytes, after: cursor, through, rows: pageRows,
    }) as Iterable<Row>) {
      const bytes = Number(row.row_bytes);
      charge += 1024 + bytes * 16; // conservative MOCK decoded estimate, not a V8 hard heap limit
      insist(Number.isSafeInteger(charge) && charge <= session.budget.workingBytes,
        "BUDGET_EXCEEDED", "Decoded SQL page budget");
      releases.push(session.reserveWorking(1024 + bytes * 16));
      const value = decodeRow(session, row, table), p = position(value.position);
      insist(p > next && p <= through && (options.requireContiguous === false || p === next + 1n),
        "POSITION", "Duplicate, missing or reversed SQL position");
      next = p; page.push(value);
    }
    session.assertPinned();
    if (!page.length) break;
    cursor = next; count += page.length;
    insist(count <= options.expectedCount, "ROW_COUNT", "Unexpected SQL rows");
    yield page;
    } finally { for (const release of releases) release(); }
  }
  session.assertPinned();
  insist(count === options.expectedCount, "ROW_COUNT", "Missing SQL rows");
  if (options.requireContiguous !== false) insist(cursor === through, "POSITION", "Missing final position");
}
export function originalAt(session: ReaderSession, p: string): JournalRecord | undefined {
  session.assertPinned();
  const row = session.db.prepare(`${select("records")} WHERE position=@position`).safeIntegers()
    .get({ maxBytes: session.budget.recordBytes, position: position(p) }) as Row | undefined;
  if (!row) return undefined;
  const release = session.reserveWorking(Number(row.row_bytes) * 16 + 1024);
  try { return decodeRow(session, row, "records") as JournalRecord; } finally { release(); }
}
// Keep the driver type out of the public product surface; no product exports added.
export type PrototypeDatabase = Database.Database;
