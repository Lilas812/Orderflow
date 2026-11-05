import test from "node:test";
import assert from "node:assert/strict";
import { OrderBook, mbo, metadata } from "./mbo_dbn.mjs";
import { encodeColumns, decodeColumns } from "../server/src/store/binary.ts";

const event = (action, orderId, side, price, size, flags = 128) => ({
  action, orderId: BigInt(orderId), side, nsPrice: BigInt(price) * 100000000n, size, flags,
});
function seeded() {
  const book = new OrderBook();
  book.apply(event("R", 0, "N", 0, 0));
  book.apply(event("A", 1, "B", 40000, 4));
  book.apply(event("A", 2, "A", 40002, 5));
  return book;
}
test("clear, add, modify and partial/full cancellation preserve quantities", () => {
  const b = seeded();
  b.apply(event("A", 3, "B", 40000, 3));
  assert.equal(b.bids.get(40000), 7);
  b.apply(event("M", 3, "B", 39999, 2));
  assert.equal(b.bids.get(40000), 4); assert.equal(b.bids.get(39999), 2);
  b.apply(event("C", 1, "B", 40000, 1));
  assert.equal(b.bids.get(40000), 3);
  b.apply(event("C", 1, "B", 40000, 3));
  assert.equal(b.bids.has(40000), false);
  b.apply(event("R", 0, "N", 0, 0));
  assert.equal(b.orders.size, 0);
});
test("T and F never double-subtract a resting order", () => {
  const b = seeded();
  b.apply(event("T", 1, "A", 40000, 2)); b.apply(event("F", 1, "B", 40000, 2));
  assert.equal(b.bids.get(40000), 4);
  b.apply(event("C", 1, "B", 40000, 2));
  assert.equal(b.bids.get(40000), 2);
});
test("uninitialized book is not assumed empty and unknown cancel invalidates", () => {
  const b = new OrderBook(); b.apply(event("A", 1, "B", 40000, 1));
  assert.equal(b.column(1), null);
  const c = seeded(); c.apply(event("C", 999, "B", 40000, 1));
  assert.equal(c.column(1), null); assert.equal(c.errors.cancel_unknown_order, 1);
});
test("orders use exact uint64 IDs, and price must align to GC 0.10", () => {
  const b = seeded();
  b.apply(event("A", 9007199254740993n, "B", 39999, 1));
  b.apply(event("A", 9007199254740994n, "B", 39999, 2));
  assert.equal(b.bids.get(39999), 3);
  b.apply({ ...event("A", 4, "B", 39999, 2), nsPrice: 3999900000001n });
  assert.equal(b.errors.side_or_off_tick, 1);
});
test("output uses the unchanged application binary encoder/decoder and 400 ticks per side", () => {
  const b = seeded();
  b.apply(event("A", 3, "B", 39602, 2)); b.apply(event("A", 4, "B", 39601, 9));
  b.apply(event("A", 5, "A", 40401, 2)); b.apply(event("A", 6, "A", 40402, 9));
  const column = b.column(1793664000);
  assert.equal(column.bids.at(-1).price, 39602);
  assert.equal(column.asks.at(-1).price, 40401);
  assert.deepEqual(decodeColumns(encodeColumns([column])), [column]);
});
test("negative cancellation and crossed completed book are not accepted", () => {
  const b = seeded(); b.apply(event("C", 1, "B", 40000, 100));
  assert.equal(b.column(1), null); assert.equal(b.negative, 0);
  const c = seeded(); c.apply(event("A", 3, "B", 40003, 1));
  assert.equal(c.column(1).crossed, true);
});
test("DBN MBO offsets include original nanoseconds, flags and sequence", () => {
  const r = Buffer.alloc(56);
  r[0] = 14; r[1] = 160; r.writeUInt32LE(41271, 4);
  r.writeBigUInt64LE(1793664000123456789n, 8); r.writeBigUInt64LE(9007199254740993n, 16);
  r.writeBigInt64LE(4000000000000n, 24); r.writeUInt32LE(4, 32);
  r[36] = 168; r[38] = 65; r[39] = 66;
  r.writeBigUInt64LE(1793664000000000000n, 40); r.writeUInt32LE(123, 52);
  const decoded = mbo(r);
  assert.equal(decoded.orderId, 9007199254740993n);
  assert.equal(decoded.tsEvent, 1793664000123456789n);
  assert.equal(decoded.flags, 168); assert.equal(decoded.sequence, 123);
});
test("DBN v3 metadata has fixed little-endian fields and rejects padding corruption", () => {
  const b = Buffer.alloc(128);
  b.write("DBN", 0); b[3] = 3; b.writeUInt32LE(120, 4);
  b.write("GLBX.MDP3", 8); b.writeBigUInt64LE(1793664000000000000n, 26);
  b.writeBigUInt64LE(1793750400000000000n, 34); b.writeUInt16LE(71, 53);
  const result = metadata(b);
  assert.equal(result.dataset, "GLBX.MDP3");
  assert.equal(result.startNs, "1793664000000000000");
  assert.deepEqual(result.mappings, []);
  const short = b.subarray(0, 127);
  assert.throws(() => metadata(short), /metadata_length/);
  b[52] = 1;
  assert.throws(() => metadata(b), /ts_out/);
});
test("provider bad-book quality remains invalid until a clean clear; MBP/TOB is not MBO", () => {
  const b = seeded();
  b.apply(event("N", 0, "N", 0, 0, 132));
  assert.equal(b.column(1), null);
  b.apply(event("A", 5, "B", 39999, 1));
  assert.equal(b.column(1), null);
  b.apply(event("R", 0, "N", 0, 0, 128));
  assert.equal(b.valid, true);
  b.apply(event("A", 6, "B", 39999, 1, 144));
  assert.equal(b.valid, false);
});
