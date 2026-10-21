import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JournalRecord } from "./eventJournal";
import { canonical, checksum, insist, type SqliteCatalog } from "./sqliteCatalog";
import { descriptor, segments, type RecordIndex, type SegmentInfo } from "./storageMigration";

export const segmentDirectory = (c: SqliteCatalog): string => join(dirname(c.filename), "market-cache", "segments");
export function segmentPath(c: SqliteCatalog, s: SegmentInfo): string {
  insist(/^[a-f0-9]{64}\.jsonl$/.test(s.filename) && s.filename === `${s.segmentId}.jsonl`,
    "SEGMENT_PATH", "Only catalog-owned segment names allowed");
  for (const dir of [dirname(segmentDirectory(c)), segmentDirectory(c)]) if (existsSync(dir)) {
    const stat = lstatSync(dir);
    insist(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
      "SEGMENT_PATH", "Chunk directories must be private, non-symlink directories");
  }
  return join(segmentDirectory(c), s.filename);
}
export const byteChecksum = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export function validateRecord(r: JournalRecord): void {
  const { checksum: hash, ...body } = r;
  insist(checksum(body) === hash, "SEGMENT_RECORD_CHECKSUM", "Record content changed");
}
export function decodeSegment(text: string, info: SegmentInfo): JournalRecord[] {
  const lines = text.split("\n");
  insist(lines.pop() === "" && lines.length >= 3, "INCOMPLETE_SEGMENT", "Missing final newline/footer");
  const header = JSON.parse(lines[0]) as Record<string, unknown>;
  const footer = JSON.parse(lines.at(-1)!) as { checksum: string; finalizationStatus: string; recordCount: number };
  const body = lines.slice(0, -1).join("\n") + "\n";
  const records = lines.slice(1, -1).map(l => JSON.parse(l) as JournalRecord);
  const expectedHeader = {
    magic: "ORDERFLOW_NORMALIZED_MOCK_JSONL", schemaVersion: 2, formatVersion: 1,
    segmentId: info.segmentId, scopeId: info.scopeId, source: info.source,
    instrumentId: info.instrumentId, session: info.session, channel: info.channel,
    startNs: info.startNs, endNs: info.endNs, recordCount: info.recordCount,
  };
  insist(canonical(header) === canonical(expectedHeader) && footer.finalizationStatus === "FINALIZED" &&
    footer.checksum === byteChecksum(body) && footer.checksum === info.bodyChecksum &&
    byteChecksum(text) === info.checksum &&
    footer.recordCount === records.length && records.length === info.recordCount &&
    Buffer.byteLength(text, "utf8") === info.bytes, "SEGMENT_CHECKSUM", "Segment header/footer/hash/size mismatch");
  insist(canonical(records.map(r => r.position)) === canonical(info.positions), "SEGMENT_ORDER", "Stored positions changed");
  for (const r of records) {
    validateRecord(r);
    insist(r.scopeId === info.scopeId && r.channel === info.channel, "SEGMENT_SCOPE", "Mixed scope/channel");
    const time = r.eventNs ?? r.receiveNs;
    insist(BigInt(time) >= BigInt(info.startNs) && BigInt(time) < BigInt(info.endNs),
      "SEGMENT_TIME", "Record outside segment range");
  }
  return records;
}
export class SegmentReader {
  readonly filesRead = new Set<string>();
  constructor(readonly catalog: SqliteCatalog) {}
  read(info: SegmentInfo): JournalRecord[] {
    insist(info.finalizationStatus === "FINALIZED", "SEGMENT_NOT_FINALIZED", "Segment is not queryable");
    const file = segmentPath(this.catalog, info);
    insist(existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(),
      "SEGMENT_MISSING", `Finalized segment missing/unsafe: ${info.segmentId}`);
    this.filesRead.add(info.segmentId);
    const bytes = readFileSync(file), text = bytes.toString("utf8");
    insist(Buffer.from(text, "utf8").equals(bytes), "SEGMENT_UTF8", "Invalid UTF-8 bytes");
    return decodeSegment(text, info);
  }
  /** Each position has one logical result even when SQL and file copies both exist. */
  records(selected: readonly RecordIndex[]): JournalRecord[] {
    const map = new Map<string, JournalRecord>();
    const wanted = new Set(selected.map(r => r.position));
    insist(!segments(this.catalog).some(s => s.finalizationStatus === "CORRUPT" && s.positions.some(p => wanted.has(p))),
      "SEGMENT_CORRUPT", "Quarantined segment is not a valid source");
    for (const s of segments(this.catalog).filter(s => s.finalizationStatus === "FINALIZED" &&
      s.positions.some(p => wanted.has(p)))) {
      for (const r of this.read(s)) if (wanted.has(r.position)) {
        const previous = map.get(r.position);
        insist(!previous || canonical(previous) === canonical(r), "DUPLICATE_SOURCE_CONFLICT", "Conflicting segment copies");
        map.set(r.position, r);
      }
    }
    for (const d of selected) {
      const row = this.catalog.database.prepare("SELECT * FROM records WHERE position=?").safeIntegers()
        .get(BigInt(d.position)) as Record<string, unknown> | undefined;
      if (row) {
        const r: JournalRecord = {
          position: String(row.position), scopeId: row.scope_id as string, channel: row.channel as JournalRecord["channel"],
          eventNs: row.event_ns === null ? null : String(row.event_ns), receiveNs: String(row.receive_ns),
          input: JSON.parse(row.payload as string) as JournalRecord["input"], applied: row.applied === 1n,
          outcome: row.outcome as string, reason: row.reason as string,
          previousHash: row.previous_hash as string, checksum: row.checksum as string,
        };
        validateRecord(r);
        insist(!map.has(r.position) || canonical(map.get(r.position)) === canonical(r),
          "DUPLICATE_SOURCE_CONFLICT", "SQLite and chunk differ");
        map.set(r.position, r);
      }
      const result = map.get(d.position);
      insist(result && canonical(descriptor(result)) === canonical(d), "RAW_SOURCE_MISSING",
        `No verified original for position ${d.position}`);
    }
    return selected.map(d => map.get(d.position)!);
  }
}
