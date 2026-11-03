import { encodeColumns, decodeColumns } from "../store/binary.ts";
import type { Column } from "../aggregate/columns.ts";
import type { BookSnapshot } from "../types.ts";

export type FrameKind = 1 | 2 | 3;
export function encodeFrame(kind: FrameKind, reqId: number, columns: Column[]): Buffer {
  if (![1, 2, 3].includes(kind) || !Number.isInteger(reqId) || reqId < 0 || reqId > 0xffffffff
    || (kind !== 2 && reqId !== 0) || (kind !== 2 && columns.length !== 1)) throw Error("invalid_frame");
  const head = Buffer.alloc(9);
  head.writeUInt8(kind, 0); head.writeUInt32LE(reqId, 1); head.writeUInt32LE(columns.length, 5);
  return Buffer.concat([head, encodeColumns(columns)]);
}
export function decodeFrame(bytes: Buffer) {
  if (bytes.length < 9) throw Error("incomplete_frame");
  const kind = bytes.readUInt8(0) as FrameKind, reqId = bytes.readUInt32LE(1);
  if (![1, 2, 3].includes(kind) || (kind !== 2 && reqId !== 0)) throw Error("invalid_frame");
  const columns = decodeColumns(bytes.subarray(9));
  if (columns.length !== bytes.readUInt32LE(5) || (kind !== 2 && columns.length !== 1)) throw Error("invalid_frame_count");
  return { kind, reqId, columns };
}
export const boardColumn = (book: BookSnapshot): Column => ({
  tsSec: Math.floor(book.tsUs / 1_000_000), source: book.source, bids: book.bids, asks: book.asks,
});
export function parseRange(value: unknown): { reqId: number; fromSec: number; toSec: number } {
  const r = value as Record<string, unknown> | null;
  if (!r || r.op !== "range" || !Number.isInteger(r.reqId) || (r.reqId as number) < 1 || (r.reqId as number) > 0xffffffff
    || ![r.fromSec, r.toSec].every(v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff)
    || (r.fromSec as number) >= (r.toSec as number) || (r.toSec as number) - (r.fromSec as number) > 3600) {
    throw Error("invalid_range");
  }
  return { reqId: r.reqId as number, fromSec: r.fromSec as number, toSec: r.toSec as number };
}
export function replayParams(url: URL, saved: { fromSec: number; toSec: number } | null) {
  const mode = url.searchParams.get("mode");
  if (mode === null || mode === "live") {
    if (url.searchParams.has("from") || url.searchParams.has("speed")) throw Error("invalid_replay_parameters");
    return null;
  }
  const from = url.searchParams.get("from"), speed = url.searchParams.get("speed");
  if (mode !== "replay" || !from || !/^\d+$/.test(from) || !["1", "2", "5", "10", "30", "60"].includes(speed ?? "")
    || !saved || !Number.isSafeInteger(Number(from)) || Number(from) < saved.fromSec || Number(from) >= saved.toSec) {
    throw Error("invalid_replay_parameters");
  }
  const fromSec = Number(from), headValue = url.searchParams.get("headUs");
  const headUs = headValue === null ? fromSec * 1_000_000 : Number(headValue);
  if (!Number.isSafeInteger(headUs) || headUs < fromSec * 1_000_000 || headUs > saved.toSec * 1_000_000) {
    throw Error("invalid_replay_parameters");
  }
  return { fromSec, toSec: saved.toSec, speed: Number(speed), headUs };
}
