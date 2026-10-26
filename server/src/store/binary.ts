import type { Column } from "../aggregate/columns.ts";

export function encodeColumns(columns: Column[]): Buffer {
  const out = Buffer.alloc(columns.reduce((n, c) => n + 9 + 8 * (c.bids.length + c.asks.length), 0));
  let offset = 0;
  let previous = -1;
  for (const c of columns) {
    if (!Number.isInteger(c.tsSec) || c.tsSec <= previous) throw Error("columns_not_strictly_ascending");
    previous = c.tsSec;
    out.writeUInt32LE(c.tsSec, offset); offset += 4;
    out.writeUInt8(c.source === "live" ? 0 : 1, offset++);
    out.writeUInt16LE(c.bids.length, offset); offset += 2;
    out.writeUInt16LE(c.asks.length, offset); offset += 2;
    for (const level of [...c.bids, ...c.asks]) {
      if (!Number.isInteger(level.price) || !Number.isInteger(level.size) || level.size <= 0) {
        throw Error("unrepresentable_column_level");
      }
      out.writeInt32LE(level.price, offset); offset += 4;
      out.writeUInt32LE(level.size, offset); offset += 4;
    }
  }
  return out;
}

export function decodeColumns(input: Buffer): Column[] {
  const columns: Column[] = [];
  let offset = 0;
  let previous = -1;
  while (offset < input.length) {
    if (input.length - offset < 9) throw Error("incomplete_column_header");
    const tsSec = input.readUInt32LE(offset); offset += 4;
    const source = input.readUInt8(offset++);
    const nBids = input.readUInt16LE(offset); offset += 2;
    const nAsks = input.readUInt16LE(offset); offset += 2;
    if (source > 1 || tsSec <= previous || input.length - offset < 8 * (nBids + nAsks)) {
      throw Error("invalid_column_record");
    }
    previous = tsSec;
    const levels = Array.from({ length: nBids + nAsks }, () => {
      const price = input.readInt32LE(offset); offset += 4;
      const size = input.readUInt32LE(offset); offset += 4;
      return { price, size };
    });
    columns.push({ tsSec, source: source === 0 ? "live" : "history", bids: levels.slice(0, nBids), asks: levels.slice(nBids) });
  }
  return columns;
}
