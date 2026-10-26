import type { HeatColumn, Source } from "../src/domain.ts";

export function column(second: number, options: {
  source?: Source;
  bids?: [number, number][];
  asks?: [number, number][];
} = {}): HeatColumn {
  const levels = (entries: [number, number][] = []) => ({
    prices: Int32Array.from(entries.map(([price]) => price)),
    sizes: Uint32Array.from(entries.map(([, size]) => size)),
  });
  return {
    timeUs: second * 1_000_000,
    source: options.source ?? "live",
    bids: levels(options.bids),
    asks: levels(options.asks),
  };
}

export function makeFrame(kind: 1 | 2 | 3, reqId: number, records: {
  tsSec: number;
  source?: 0 | 1;
  bids?: [number, number][];
  asks?: [number, number][];
}[]): Uint8Array {
  const recordBytes = records.reduce((sum, record) => sum + 9 + 8 * ((record.bids?.length ?? 0) + (record.asks?.length ?? 0)), 0);
  const bytes = new Uint8Array(9 + recordBytes);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, reqId, true);
  view.setUint32(5, records.length, true);
  let offset = 9;
  for (const record of records) {
    const bids = record.bids ?? [];
    const asks = record.asks ?? [];
    view.setUint32(offset, record.tsSec, true);
    view.setUint8(offset + 4, record.source ?? 0);
    view.setUint16(offset + 5, bids.length, true);
    view.setUint16(offset + 7, asks.length, true);
    offset += 9;
    for (const [price, size] of [...bids, ...asks]) {
      view.setInt32(offset, price, true);
      view.setUint32(offset + 4, size, true);
      offset += 8;
    }
  }
  return bytes;
}
