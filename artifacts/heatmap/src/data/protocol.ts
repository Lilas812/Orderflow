import type { HeatColumn, LevelArrays, Source, Trade } from "../domain.ts";
import { US_PER_SECOND } from "../domain.ts";

export type FrameKind = 1 | 2 | 3;
export interface DecodedFrame {
  kind: FrameKind;
  reqId: number;
  columns: HeatColumn[];
}

const HEADER_BYTES = 9;
const LEVEL_BYTES = 8;

function decodeLevels(view: DataView, offset: number, count: number): { levels: LevelArrays; offset: number } {
  const prices = new Int32Array(count);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    const price = view.getInt32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 1) throw new Error("invalid_column_size");
    prices[i] = price;
    sizes[i] = size;
    offset += LEVEL_BYTES;
  }
  return { levels: { prices, sizes }, offset };
}

/** Decodes the SPEC 9 record payload carried by the SPEC 8.3 frame. */
export function decodeFrame(input: ArrayBuffer | Uint8Array): DecodedFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES) throw new Error("incomplete_frame");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kindValue = view.getUint8(0);
  const reqId = view.getUint32(1, true);
  const count = view.getUint32(5, true);
  if (kindValue !== 1 && kindValue !== 2 && kindValue !== 3) throw new Error("invalid_frame_kind");
  const kind = kindValue as FrameKind;
  if (kind !== 2 && reqId !== 0) throw new Error("invalid_frame_req_id");
  if (kind !== 2 && count !== 1) throw new Error("invalid_frame_count");
  if (count > Math.floor((bytes.byteLength - HEADER_BYTES) / 9)) throw new Error("invalid_frame_count");

  const columns: HeatColumn[] = [];
  let offset = HEADER_BYTES;
  let previousSec = -1;
  for (let index = 0; index < count; index += 1) {
    if (bytes.byteLength - offset < 9) throw new Error("incomplete_column_header");
    const tsSec = view.getUint32(offset, true);
    const sourceValue = view.getUint8(offset + 4);
    const nBids = view.getUint16(offset + 5, true);
    const nAsks = view.getUint16(offset + 7, true);
    offset += 9;
    const levelCount = nBids + nAsks;
    if (sourceValue > 1 || tsSec <= previousSec || levelCount > 800) throw new Error("invalid_column_record");
    if (bytes.byteLength - offset < levelCount * LEVEL_BYTES) throw new Error("incomplete_column_record");
    previousSec = tsSec;
    const bidResult = decodeLevels(view, offset, nBids);
    const askResult = decodeLevels(view, bidResult.offset, nAsks);
    offset = askResult.offset;
    columns.push({
      timeUs: tsSec * US_PER_SECOND,
      source: (sourceValue === 0 ? "live" : "history") satisfies Source,
      bids: bidResult.levels,
      asks: askResult.levels,
    });
  }
  if (offset !== bytes.byteLength) throw new Error("trailing_frame_bytes");
  return { kind, reqId, columns };
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid_trade_${key}`);
  return value;
}

export function decodeTrades(value: unknown): Trade[] {
  if (!Array.isArray(value)) throw new Error("invalid_trades");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid_trade");
    const record = item as Record<string, unknown>;
    const trade: Trade = {
      tsUs: numberField(record, "tsUs"),
      recvUs: numberField(record, "recvUs"),
      seq: numberField(record, "seq"),
      price: numberField(record, "price"),
      size: numberField(record, "size"),
      side: record.side === "buy" || record.side === "sell" ? record.side : (() => { throw new Error("invalid_trade_side"); })(),
    };
    if (![trade.tsUs, trade.recvUs, trade.price, trade.seq].every(Number.isSafeInteger)
      || !Number.isInteger(trade.size) || trade.size < 1 || trade.size > 0xffffffff) {
      throw new Error("invalid_trade_values");
    }
    // Optional contract (GC/NQ standard or UNKNOWN); absent stays absent.
    if (typeof record.contract === "string" && record.contract.length > 0 && record.contract.length <= 16) trade.contract = record.contract;
    return trade;
  });
}
