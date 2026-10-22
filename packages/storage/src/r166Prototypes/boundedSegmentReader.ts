import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync,
  rmdirSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import type { JournalRecord } from "../eventJournal";
import { canonical, insist, sqliteNs } from "../sqliteCatalog";
import type { SegmentInfo } from "../storageMigration";
import { validateOriginal, position } from "./boundedSqlReader";
import { validateBudget, type ReaderBudget } from "./readerSession";

type Stamp = ReturnType<typeof fstatSync>;
const same = (a: Stamp, b: Stamp) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
/** Private, already-unlinked spool. No record escapes until source footer/hash,
 * size and identity validation has completed. Remaining threat: hostile same-user
 * process/kernel; stat checks are NOT a cryptographic immutable-filesystem claim. */
export interface VerifiedSpool {
  next(): JournalRecord | undefined;
  close(): void;
  readonly records: number;
  readonly bytes: number;
}
export function verifySegment(file: string, info: SegmentInfo, budget: ReaderBudget,
  hooks: { afterRead?: (total: number) => void } = {}): VerifiedSpool {
  validateBudget(budget);
  insist(info.finalizationStatus === "FINALIZED" && info.schemaVersion === 2 && info.formatVersion === 1 &&
    /^[a-f0-9]{64}$/.test(info.segmentId) && info.filename === `${info.segmentId}.jsonl` &&
    Number.isSafeInteger(info.recordCount) && info.recordCount > 0 &&
    info.positions.length === info.recordCount && Number.isSafeInteger(info.bytes) && info.bytes > 0,
  "SEGMENT_METADATA", "Invalid segment metadata");
  sqliteNs(info.startNs); sqliteNs(info.endNs);
  insist(BigInt(info.startNs) < BigInt(info.endNs), "SEGMENT_TIME", "Invalid segment interval");
  insist(info.bytes <= budget.spoolBytes, "BUDGET_EXCEEDED", "Private spool disk cap");
  let prevPosition = 0n;
  for (const p of info.positions) {
    const current = position(p);
    insist(current > prevPosition, "SEGMENT_ORDER", "Duplicate/reversed segment positions"); prevPosition = current;
  }
  for (const dir of [dirname(dirname(file)), dirname(file)]) {
    const st = lstatSync(dir);
    insist(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0,
      "SEGMENT_PATH", "Private non-symlink segment parents required");
  }
  const before = lstatSync(file);
  insist(before.isFile() && !before.isSymbolicLink(), "SEGMENT_PATH", "Regular non-symlink file required");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let dir = "";
  let spool = -1, success = false;
  try {
    dir = mkdtempSync(join(tmpdir(), "r166-private-spool-"));
    insist(same(before, fstatSync(fd)), "SEGMENT_CHANGED", "Source replaced before open");
    spool = openSync(join(dir, "records"), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    unlinkSync(join(dir, "records")); rmdirSync(dir);
    const buffer = Buffer.alloc(budget.readBufferBytes);
    // Fixed line buffer: never Buffer.concat(), whole-file decode, or split().
    const line = Buffer.alloc(budget.recordBytes);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const fileHash = createHash("sha256"), bodyHash = createHash("sha256");
    let used = 0, total = 0, lines = 0, records = 0, spooled = 0;
    let footer = false;
    const expectedHeader = {
      magic: "ORDERFLOW_NORMALIZED_MOCK_JSONL", schemaVersion: 2, formatVersion: 1,
      segmentId: info.segmentId, scopeId: info.scopeId, source: info.source,
      instrumentId: info.instrumentId, session: info.session, channel: info.channel,
      startNs: info.startNs, endNs: info.endNs, recordCount: info.recordCount,
    };
    function completeLine() {
      insist(!footer, "SEGMENT_FOOTER", "Extra data after footer");
      const raw = line.subarray(0, used);
      insist(used * 16 + budget.readBufferBytes + budget.recordBytes <= budget.workingBytes,
        "BUDGET_EXCEEDED", "Decoded segment line budget");
      const text = decoder.decode(raw);
      insist(!text.startsWith("\uFEFF"), "SEGMENT_UTF8", "BOM is not canonical chunk bytes");
      const value = JSON.parse(text);
      if (lines === 0) {
        insist(canonical(value) === canonical(expectedHeader), "SEGMENT_HEADER", "Header differs");
      } else if (records < info.recordCount) {
        insist(used * 16 + budget.readBufferBytes + budget.recordBytes <= budget.workingBytes,
          "BUDGET_EXCEEDED", "Decoded segment record budget");
        const r = value as JournalRecord;
        validateOriginal(r);
        insist(r.position === info.positions[records] && r.scopeId === info.scopeId &&
          r.channel === info.channel, "SEGMENT_ORDER", "Position/scope/channel changed");
        const ns = BigInt(r.eventNs ?? r.receiveNs);
        insist(ns >= BigInt(info.startNs) && ns < BigInt(info.endNs), "SEGMENT_TIME", "Record outside range");
        let written = 0;
        while (written < raw.length) {
          const n = writeSync(spool, raw, written, raw.length - written);
          insist(n > 0, "SPOOL_WRITE", "Spool write made no progress"); written += n;
        }
        insist(writeSync(spool, Buffer.from("\n")) === 1, "SPOOL_WRITE", "Short spool newline write");
        spooled += used + 1; records++;
      } else {
        insist(value && value.finalizationStatus === "FINALIZED" && value.recordCount === records &&
          value.checksum === info.bodyChecksum && bodyHash.digest("hex") === info.bodyChecksum,
        "SEGMENT_FOOTER", "Footer/body checksum mismatch");
        footer = true;
      }
      if (!footer) { bodyHash.update(raw); bodyHash.update("\n"); }
      lines++; used = 0;
    }
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      total += n;
      insist(total <= info.bytes && total <= budget.spoolBytes, "BUDGET_EXCEEDED", "Chunk size exceeds catalog/disk cap");
      fileHash.update(buffer.subarray(0, n));
      for (let i = 0; i < n; i++) {
        if (buffer[i] === 10) completeLine();
        else {
          insist(used < line.length, "BUDGET_EXCEEDED", "Line exceeds MOCK byte cap");
          line[used++] = buffer[i];
        }
      }
      hooks.afterRead?.(total);
    }
    insist(used === 0 && footer && records === info.recordCount && lines === info.recordCount + 2 &&
      total === info.bytes && fileHash.digest("hex") === info.checksum,
    "SEGMENT_CHECKSUM", "Missing final newline/footer, truncation, size or file hash mismatch");
    insist(same(before, fstatSync(fd)) && same(before, lstatSync(file)),
      "SEGMENT_CHANGED", "Source replaced/mutated during verification");
    let offset = 0, closed = false;
    success = true;
    return {
      records, bytes: spooled,
      next() {
        insist(!closed, "READER_STATE", "Spool closed");
        if (offset === spooled) return undefined;
        let length = 0;
        // Positional reads avoid sharing mutable file cursor with writer.
        while (offset < spooled) {
          const n = readSync(spool, buffer, 0, Math.min(buffer.length, spooled - offset), offset);
          insist(n > 0, "SPOOL_READ", "Unexpected spool EOF");
          const newline = buffer.subarray(0, n).indexOf(10), take = newline < 0 ? n : newline;
          insist(length + take <= line.length, "BUDGET_EXCEEDED", "Spool line budget");
          buffer.copy(line, length, 0, take); length += take; offset += take;
          if (newline >= 0) { offset++; break; }
        }
        const r = JSON.parse(decoder.decode(line.subarray(0, length))) as JournalRecord;
        validateOriginal(r); return r;
      },
      close() { if (!closed) { closed = true; closeSync(spool); } },
    };
  } finally {
    closeSync(fd);
    if (!success) {
      if (spool >= 0) closeSync(spool);
      if (dir) {
        try { unlinkSync(join(dir, "records")); } catch { /* unlinked spool is automatically reclaimed */ }
        try { rmdirSync(dir); } catch { /* already removed */ }
      }
    }
  }
}
