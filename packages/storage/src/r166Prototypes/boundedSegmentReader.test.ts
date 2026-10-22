import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { withStore, F01_BOOK } from "../r15Fixtures";
import { migrateToV2, type SegmentInfo } from "../storageMigration";
import { SegmentWriter } from "../segmentWriter";
import { segmentPath, decodeSegment } from "../segmentReader";
import { checksum } from "../sqliteCatalog";
import { MOCK_BUDGET } from "./readerSession";
import { verifySegment } from "./boundedSegmentReader";

function fixture(run: (file: string, info: SegmentInfo) => void) {
  withStore(({ catalog, journal, scope }) => {
    const events = F01_BOOK.events.map(e => ({ ...e, header: { ...e.header, eventId: `${e.header.eventId}日本語😀\n` } }));
    journal.append(scope.id, events); migrateToV2(journal);
    const info = new SegmentWriter(journal).write(scope.id, "L2_MBP", ["1", "2", "3", "4", "5"]);
    run(segmentPath(catalog, info), info);
  });
}
function rehash(file: string, info: SegmentInfo, text: string) {
  const bytes = Buffer.from(text);
  writeFileSync(file, bytes);
  return { ...info, bytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex") };
}
it.each([1, 2, 3, 7, 1024, 1024 * 1024])("validates Unicode chunk across %s-byte reads", readBufferBytes => fixture((file, info) => {
  const before = readFileSync(file), oracle = decodeSegment(before.toString(), info);
  const spool = verifySegment(file, info, { ...MOCK_BUDGET, readBufferBytes });
  try {
    const result = [];
    for (let r = spool.next(); r; r = spool.next()) result.push(r);
    expect(result).toEqual(oracle); expect(checksum(result)).toBe(checksum(oracle));
    expect(spool.records).toBe(5); expect(spool.next()).toBeUndefined();
    expect(readFileSync(file)).toEqual(before);
  } finally { spool.close(); }
  expect(() => spool.next()).toThrow("READER_STATE");
}));
it.each(["final-newline", "footer", "header", "record-checksum", "extra-line", "truncated", "invalid-utf8", "body-hash", "file-hash"])
  ("rejects %s without publishing a spool", mode => fixture((file, info) => {
    const original = readFileSync(file), text = original.toString();
    if (mode === "invalid-utf8") {
      const b = Buffer.from(original); b[b.indexOf(Buffer.from("日本語"))] = 0xff; writeFileSync(file, b);
    } else {
      const changed = mode === "final-newline" ? text.slice(0, -1) :
        mode === "footer" ? text.replace('"FINALIZED"', '"UNSEALED"') :
        mode === "header" ? text.replace('"formatVersion":1', '"formatVersion":9') :
        mode === "record-checksum" ? text.replace('"qty":40', '"qty":41') :
        mode === "extra-line" ? text + "{}\n" :
        mode === "truncated" ? text.slice(0, Math.floor(text.length / 2)) : text;
      writeFileSync(file, changed);
    }
    const bad = mode === "body-hash" ? { ...info, bodyChecksum: "f".repeat(64) } :
      mode === "file-hash" ? { ...info, checksum: "f".repeat(64) } : info;
    let published = false;
    expect(() => {
      const spool = verifySegment(file, bad, { ...MOCK_BUDGET, readBufferBytes: 17 }, {
        afterRead() { expect(published).toBe(false); },
      });
      published = true; spool.close();
    }).toThrow();
    expect(published).toBe(false);
  }));
it.each(["duplicate", "reversed", "scope", "channel", "time", "count"])
  ("rejects metadata %s", mode => fixture((file, info) => {
    const bad = { ...info, positions: [...info.positions] };
    if (mode === "duplicate") bad.positions[1] = bad.positions[0];
    if (mode === "reversed") bad.positions.reverse();
    if (mode === "scope") bad.scopeId = "foreign";
    if (mode === "channel") bad.channel = "TRADES";
    if (mode === "time") bad.endNs = bad.startNs;
    if (mode === "count") bad.recordCount++;
    expect(() => verifySegment(file, bad, MOCK_BUDGET)).toThrow();
  }));
it.each(["symlink", "replace", "truncate", "delete", "mutate"])
  ("detects %s during read / open", mode => fixture((file, info) => {
    if (mode === "symlink") { renameSync(file, file + ".old"); symlinkSync(file + ".old", file); }
    let changed = false;
    expect(() => {
      const spool = verifySegment(file, info, { ...MOCK_BUDGET, readBufferBytes: 16 }, {
        afterRead() {
          if (changed) return; changed = true;
          if (mode === "replace") { renameSync(file, file + ".old"); writeFileSync(file, readFileSync(file + ".old")); }
          if (mode === "truncate") truncateSync(file, 20);
          if (mode === "delete") unlinkSync(file);
          if (mode === "mutate") writeFileSync(file, readFileSync(file)); // content equal, ctime/mtime differs
        },
      }); spool.close();
    }).toThrow();
  }));
it("requires full chunk verification even if caller wants just the first record", () => fixture((file, info) => {
  const text = readFileSync(file, "utf8").replace('"qty":60', '"qty":61');
  const bad = rehash(file, info, text); // file checksum alone cannot hide bad later record
  expect(() => verifySegment(file, bad, MOCK_BUDGET)).toThrow("RECORD_CHECKSUM");
}));
it.each(["line", "disk", "decoded"])("refuses %s budget with no spool result", mode => fixture((file, info) => {
  const budget = { ...MOCK_BUDGET, readBufferBytes: 16 };
  if (mode === "line") budget.recordBytes = 64;
  if (mode === "disk") budget.spoolBytes = info.bytes - 1;
  if (mode === "decoded") budget.workingBytes = 2048;
  expect(() => verifySegment(file, info, budget)).toThrow("BUDGET_EXCEEDED");
}));
it("propagates a read-loop failure before any externally readable record", () => fixture((file, info) => {
  expect(() => verifySegment(file, info, MOCK_BUDGET, { afterRead() { throw new Error("injected read failure"); } }))
    .toThrow("injected read failure");
}));
