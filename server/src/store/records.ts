import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { decodeColumns } from "./binary.ts";
import type { Column } from "../aggregate/columns.ts";
import type { Trade } from "../types.ts";

function input(file: string, signal?: AbortSignal, observe?: (bytes: Buffer) => void) {
  signal?.throwIfAborted();
  const raw = createReadStream(file, { signal });
  if (observe) raw.on("data", bytes => observe(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)));
  if (!file.endsWith(".gz")) return raw;
  const inflated = createGunzip();
  raw.on("error", error => inflated.destroy(error));
  inflated.on("close", () => raw.destroy());
  return raw.pipe(inflated);
}

/** Inspect the unchanged binary format without allocating level objects. */
export function columnRecords(bytes: Buffer, visit: (second: number, record: Buffer) => void): void {
  let previous = -1, offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 9) throw Error("incomplete_column_header");
    const second = bytes.readUInt32LE(offset), source = bytes.readUInt8(offset + 4);
    const length = 9 + 8 * (bytes.readUInt16LE(offset + 5) + bytes.readUInt16LE(offset + 7));
    if (source > 1 || second <= previous || length > bytes.length - offset) throw Error("invalid_column_record");
    previous = second; visit(second, bytes.subarray(offset, offset + length)); offset += length;
  }
}

export function decodeColumnRange(bytes: Buffer, start: number, end: number): Column[] {
  const columns: Column[] = [];
  columnRecords(bytes, (second, record) => {
    if (second >= start && second < end) columns.push(decodeColumns(record)[0]);
  });
  return columns;
}

/** Disk wins on duplicate seconds, without expanding an hour into level objects. */
export function mergeColumnRecords(existing: Buffer, pending: ReadonlyMap<number, Buffer>) {
  const records = new Map<number, Buffer>();
  let lastExisting = -1;
  columnRecords(existing, (second, record) => { records.set(second, record); lastExisting = second; });
  const fresh = [...pending.entries()].filter(([second]) => !records.has(second)).sort((a, b) => a[0] - b[0]);
  for (const [second, record] of fresh) records.set(second, record);
  const all = [...records.entries()].sort((a, b) => a[0] - b[0]);
  return {
    bytes: Buffer.concat(all.map(([, record]) => record)),
    fresh: Buffer.concat(fresh.map(([, record]) => record)),
    freshCount: fresh.length,
    appendOnly: fresh.length === 0 || fresh[0][0] > lastExisting,
    lastSecond: all.at(-1)?.[0] ?? -1,
  };
}

/** Startup only needs seconds/coverage: never materialize 800 objects per second. */
export async function scanColumnFile(file: string, visit: (second: number) => void, signal?: AbortSignal): Promise<void> {
  const header = Buffer.alloc(9);
  let filled = 0, remaining = 0, previous = -1;
  for await (const chunk of input(file, signal)) {
    signal?.throwIfAborted();
    const bytes = chunk as Buffer;
    let offset = 0;
    while (offset < bytes.length) {
      if (remaining) {
        const size = Math.min(remaining, bytes.length - offset);
        offset += size; remaining -= size; continue;
      }
      const size = Math.min(9 - filled, bytes.length - offset);
      bytes.copy(header, filled, offset, offset + size); filled += size; offset += size;
      if (filled !== 9) continue;
      const second = header.readUInt32LE(0), source = header.readUInt8(4);
      if (source > 1 || second <= previous) throw Error("invalid_column_record");
      previous = second; visit(second); filled = 0;
      remaining = 8 * (header.readUInt16LE(5) + header.readUInt16LE(7));
    }
  }
  if (remaining) throw Error("invalid_column_record");
  if (filled) throw Error("incomplete_column_header");
}

/** Read one record at a time; never inflate an old hour into a single buffer. */
export async function* columnFileRange(file: string, start: number, end: number): AsyncGenerator<Column> {
  let bytes = Buffer.alloc(0), previous = -1;
  for await (const chunk of input(file)) {
    bytes = Buffer.concat([bytes, chunk as Buffer]);
    while (bytes.length >= 9) {
      const length = 9 + 8 * (bytes.readUInt16LE(5) + bytes.readUInt16LE(7));
      if (bytes.length < length) break;
      const second = bytes.readUInt32LE(0);
      if (second <= previous) throw Error("invalid_column_record");
      previous = second;
      if (second >= start && second < end) yield decodeColumns(bytes.subarray(0, length))[0];
      bytes = bytes.subarray(length);
    }
  }
  if (bytes.length) throw Error("incomplete_column_record");
}

export async function* tradeFileEntries(file: string, signal?: AbortSignal,
  observe?: (bytes: Buffer) => void): AsyncGenerator<{ line: string; trade: Trade }> {
  const stream = input(file, signal, observe);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let failure: Error | null = null;
  const fail = (error: Error) => { failure = error; lines.close(); };
  stream.once("error", fail); lines.once("error", fail);
  try {
    for await (const line of lines) if (line) {
      signal?.throwIfAborted();
      yield { line, trade: JSON.parse(line) as Trade };
    }
    if (failure) throw failure;
    signal?.throwIfAborted();
  }
  finally { lines.close(); stream.destroy(); }
}

export async function* tradeFileRows(file: string, signal?: AbortSignal): AsyncGenerator<Trade> {
  for await (const entry of tradeFileEntries(file, signal)) yield entry.trade;
}
