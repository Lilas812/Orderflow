import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventJournal } from "./eventJournal";
import { canonical, checksum, insist } from "./sqliteCatalog";
import { byteChecksum, decodeSegment, segmentDirectory, segmentPath, SegmentReader } from "./segmentReader";
import { liveIndices, isV2, putSegment, saveStorageState, segments, storageState, verifyMetadata, type SegmentInfo } from "./storageMigration";

export type WritePhase = "after-temp" | "after-flush" | "after-rename" | "before-commit";
function flushDirectory(dir: string): void {
  const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export class SegmentWriter {
  constructor(readonly journal: EventJournal) {
    insist(isV2(journal.catalog), "MIGRATION_REQUIRED", "Explicit v2 migration required");
    for (const dir of [dirname(segmentDirectory(journal.catalog)), segmentDirectory(journal.catalog)]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const s = lstatSync(dir);
      insist(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0,
        "SEGMENT_PATH", "Private non-symlink segment directory required");
    }
  }
  write(scopeId: string, channel: string, positions: readonly string[], fault?: (phase: WritePhase) => void): SegmentInfo {
    const c = this.journal.catalog; verifyMetadata(c);
    insist(positions.length > 0 && new Set(positions).size === positions.length, "SEGMENT_INPUT", "Nonempty unique positions required");
    const selected = liveIndices(c).filter(r => positions.includes(r.position));
    insist(selected.length === positions.length && selected.every(r => r.scopeId === scopeId && r.channel === channel),
      "SEGMENT_SCOPE", "Unknown/mixed positions");
    const existing = segments(c).filter(s => s.finalizationStatus !== "DELETED");
    insist(!existing.some(s => s.positions.some(p => positions.includes(p))), "SEGMENT_OVERLAP", "Position already assigned to a segment");
    const records = new SegmentReader(c).records(selected);
    const scope = this.journal.scope(scopeId);
    const times = records.map(r => BigInt(r.eventNs ?? r.receiveNs));
    const start = times.reduce((a,b) => a < b ? a : b), end = times.reduce((a,b) => a > b ? a : b) + 1n;
    const segmentId = checksum({ scopeId, channel, records: records.map(r => r.checksum) });
    const info: SegmentInfo = {
      schemaVersion: 2, formatVersion: 1, segmentId, scopeId, channel,
      source: scope.config.identity.source, instrumentId: scope.config.identity.canonicalInstrumentId,
      session: scope.config.identity.sessionId, startNs: start.toString(), endNs: end.toString(),
      recordCount: records.length, positions: records.map(r => r.position), checksum: "", bodyChecksum: "", bytes: 0,
      filename: `${segmentId}.jsonl`, finalizationStatus: "FINALIZED",
    };
    const header = { magic: "ORDERFLOW_NORMALIZED_MOCK_JSONL", schemaVersion: 2, formatVersion: 1,
      segmentId, scopeId, source: info.source, instrumentId: info.instrumentId, session: info.session,
      channel, startNs: info.startNs, endNs: info.endNs, recordCount: info.recordCount };
    const body = [canonical(header), ...records.map(canonical)].join("\n") + "\n";
    info.bodyChecksum = byteChecksum(body);
    const text = body + canonical({ finalizationStatus: "FINALIZED", recordCount: records.length, checksum: info.bodyChecksum }) + "\n";
    info.checksum = byteChecksum(text);
    info.bytes = Buffer.byteLength(text, "utf8");
    const dir = segmentDirectory(c), temp = join(dir, `${segmentId}.${randomUUID()}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      const bytes = Buffer.from(text, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        insist(written > 0, "SHORT_WRITE", "No progress writing chunk");
        offset += written;
      }
      fault?.("after-temp");
      fsyncSync(fd); fault?.("after-flush");
    } finally { closeSync(fd); }
    decodeSegment(readFileSync(temp, "utf8"), info);
    const final = segmentPath(c, info);
    insist(!readdirSync(dir).includes(info.filename), "SEGMENT_EXISTS", "Existing sealed segment cannot be overwritten");
    renameSync(temp, final); flushDirectory(dir); fault?.("after-rename");
    c.transaction(() => {
      putSegment(c, info); saveStorageState(c, storageState(c)); fault?.("before-commit");
    });
    return info;
  }
  /** Explicit move only after all file/cursor/hash checks; never called by write(). */
  releaseSqliteCopies(info: SegmentInfo): void {
    const c = this.journal.catalog; verifyMetadata(c);
    const registered = segments(c).find(s => s.segmentId === info.segmentId);
    insist(registered && canonical(registered) === canonical(info), "SEGMENT_NOT_REGISTERED", "Segment commit not confirmed");
    new SegmentReader(c).read(registered);
    c.transaction(() => {
      for (const position of info.positions) c.database.prepare("DELETE FROM records WHERE position=?").run(BigInt(position));
    });
  }
  /** Unregistered sealed files and interrupted temp files are evidence, not data. */
  quarantineInterrupted(): string[] {
    const c = this.journal.catalog, dir = segmentDirectory(c);
    const known = new Set(segments(c).filter(s => s.finalizationStatus !== "DELETED").map(s => s.filename));
    const moved: string[] = [];
    const quarantine = join(dir, "quarantine");
    for (const name of readdirSync(dir)) {
      if (!(name.endsWith(".tmp") || (name.endsWith(".jsonl") && !known.has(name)))) continue;
      mkdirSync(quarantine, { recursive: true, mode: 0o700 });
      insist(!lstatSync(quarantine).isSymbolicLink(), "SEGMENT_PATH", "Unsafe quarantine directory");
      renameSync(join(dir, name), join(quarantine, `${randomUUID()}-${name}`)); moved.push(name);
    }
    if (moved.length) flushDirectory(dir);
    return moved;
  }
  /** Explicit quarantine; never mutate files from the read-only range API. */
  quarantineCorrupt(segmentId: string): void {
    const c = this.journal.catalog; verifyMetadata(c);
    const info = segments(c).find(s => s.segmentId === segmentId);
    insist(info && (info.finalizationStatus === "FINALIZED" || info.finalizationStatus === "CORRUPT"),
      "SEGMENT_NOT_REGISTERED", "Only catalog-owned damaged segments can be quarantined");
    if (info.finalizationStatus === "CORRUPT") return;
    let valid = true;
    try { new SegmentReader(c).read(info); } catch { valid = false; }
    insist(!valid, "SEGMENT_VALID", "A valid chunk must not be quarantined as corrupt");
    const file = segmentPath(c, info);
    if (existsSync(file)) {
      const dir = join(segmentDirectory(c), "quarantine");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      insist(!lstatSync(dir).isSymbolicLink(), "SEGMENT_PATH", "Unsafe quarantine directory");
      renameSync(file, join(dir, `${randomUUID()}-${info.filename}.corrupt`));
      flushDirectory(dir); flushDirectory(segmentDirectory(c));
    }
    c.transaction(() => {
      putSegment(c, { ...info, finalizationStatus: "CORRUPT" });
      saveStorageState(c, storageState(c));
    });
  }
}
