import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectBookSeconds } from "./book-seconds.ts";
import type { Objects } from "./objects.ts";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";
import { clipRanges } from "./coverage.ts";
import type { Coverage } from "./local.ts";

export interface BoardAuditRow {
  symbol: MarketSymbol; utcHour: string; tickCoverage: number; bookCoverage: number;
  actualSeconds: number | null; actualRatio: number | null; actualOutsideCoverage: number | null;
  coverageWithoutActual: number | null; filePresent: boolean; generation: string | null;
  compressedBytes: number; error: string | null;
}
const seconds = (r: number[][]) => r.reduce((n, [a, b]) => n + b - a, 0);
function parseIndex(value: string): Coverage {
  const v = JSON.parse(value) as Coverage;
  if (!v || !Array.isArray(v.book) || !Array.isArray(v.tick)) throw Error("invalid_audit_coverage");
  for (const ranges of [v.book, v.tick]) {
    let end = -Infinity;
    for (const r of ranges) {
      if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isSafeInteger) || r[0] >= r[1] || r[0] < end)
        throw Error("invalid_audit_coverage");
      end = r[1];
    }
  }
  return v;
}
/** Read-only cloud audit. Sequential downloads, one bounded decoder and one
 * private temporary file at a time; never initializes a production writer. */
export async function auditStoredBoards(objects: Objects, start: number, end: number,
  prefix = "prod/", symbols: MarketSymbol[] = ["NQ", "GC"]) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start % 3600 || end % 3600 || start >= end)
    throw Error("audit_requires_utc_hour_boundaries");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orderflow-board-audit-"));
  const rows: BoardAuditRow[] = [];
  const changedIndexes: MarketSymbol[] = [];
  try {
    for (const symbol of symbols) {
      const base = prefix + (symbol === "NQ" ? "" : "instruments/GC/");
      const indexFile = path.join(directory, "coverage.json");
      const exists = await objects.exists(base + "coverage.json");
      let before = "";
      if (exists) { await objects.download(base + "coverage.json", indexFile); before = await fs.readFile(indexFile, "utf8"); }
      const coverage = exists ? parseIndex(before) : { book: [], tick: [] };
      for (let hour = start; hour < end; hour += 3600) {
        const iso = new Date(hour * 1000).toISOString(), date = iso.slice(0, 10), hh = iso.slice(11, 13);
        const name = `${base}columns/${symbol}/1s/${date}/${hh}.bin.gz`;
        const file = path.join(directory, "hour.bin.gz");
        const book = clipRanges(coverage.book, hour, hour + 3600);
        const row: BoardAuditRow = { symbol, utcHour: iso, tickCoverage: seconds(clipRanges(coverage.tick, hour, hour + 3600)),
          bookCoverage: seconds(book), actualSeconds: 0, actualRatio: 0, actualOutsideCoverage: 0,
          coverageWithoutActual: seconds(book), filePresent: false, generation: null, compressedBytes: 0, error: null };
        try {
          if (objects.downloadVersion) {
            row.generation = await objects.downloadVersion(name, file);
            row.filePresent = row.generation !== null;
          } else if (await objects.exists(name)) {
            row.filePresent = true; await objects.download(name, file);
          }
          if (row.filePresent) {
            row.compressedBytes = (await fs.stat(file)).size;
            const actual = await inspectBookSeconds(file, hour);
            const intersection = actual.intervals.reduce((n, [a, b]) =>
              n + seconds(clipRanges(book, a, b)), 0);
            row.actualSeconds = actual.count; row.actualRatio = actual.count / 3600;
            row.actualOutsideCoverage = actual.count - intersection;
            row.coverageWithoutActual = row.bookCoverage - intersection;
          }
        } catch {
          row.error = "object_read_or_decode_failed"; row.actualSeconds = row.actualRatio = null;
          row.actualOutsideCoverage = row.coverageWithoutActual = null;
        } finally { await fs.rm(file, { force: true }); }
        rows.push(row);
      }
      const existsAfter = await objects.exists(base + "coverage.json");
      if (existsAfter) {
        await objects.download(base + "coverage.json", indexFile);
        if (!exists || before !== await fs.readFile(indexFile, "utf8")) changedIndexes.push(symbol);
      } else if (exists) changedIndexes.push(symbol);
    }
    return { startUtc: new Date(start * 1000).toISOString(), endUtcExclusive: new Date(end * 1000).toISOString(),
      note: "Fetched coverage is not actual column availability; scheduled maintenance is not automatically excluded.",
      changedIndexes, rows };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
