import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrame } from "../src/data/protocol.ts";
import { makeFrame } from "./helpers.ts";
import { readFileSync } from "node:fs";

test("ダミー: existing server encodeFrame golden bytes decode identically for every kind", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/server-frames.json", import.meta.url), "utf8")) as {
    cases: { kind: number; reqId: number; hex: string; columns: { tsSec: number; source: string; bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }[] }[];
  };
  for (const item of fixture.cases) {
    const decoded = decodeFrame(Buffer.from(item.hex, "hex"));
    assert.equal(decoded.kind, item.kind);
    assert.equal(decoded.reqId, item.reqId);
    assert.deepEqual(decoded.columns.map(c => ({
      tsSec: c.timeUs / 1_000_000, source: c.source,
      bids: Array.from(c.bids.prices, (price, i) => ({ price, size: c.bids.sizes[i] })),
      asks: Array.from(c.asks.prices, (price, i) => ({ price, size: c.asks.sizes[i] })),
    })), item.columns);
  }
});

test("decodes kind 1 live column with signed prices and full uint32 sizes", () => {
  const frame = decodeFrame(makeFrame(1, 0, [{
    tsSec: 1_793_000_012,
    bids: [[-120, 0xffff_ffff]],
    asks: [[121, 7]],
  }]));
  assert.equal(frame.kind, 1);
  assert.equal(frame.reqId, 0);
  assert.equal(frame.columns[0]?.timeUs, 1_793_000_012_000_000);
  assert.equal(frame.columns[0]?.source, "live");
  assert.equal(frame.columns[0]?.bids.prices[0], -120);
  assert.equal(frame.columns[0]?.bids.sizes[0], 0xffff_ffff);
  assert.equal(frame.columns[0]?.asks.sizes[0], 7);
});

test("decodes kind 2 history response and accepts Uint8Array views", () => {
  const frameBytes = makeFrame(2, 81, [
    { tsSec: 200, source: 1, bids: [[40, 3]] },
    { tsSec: 201, source: 1, asks: [[41, 4]] },
  ]);
  const backing = new Uint8Array(frameBytes.length + 8);
  backing.set(frameBytes, 4);
  const frame = decodeFrame(backing.subarray(4, 4 + frameBytes.length));
  assert.equal(frame.kind, 2);
  assert.equal(frame.reqId, 81);
  assert.equal(frame.columns.length, 2);
  assert.equal(frame.columns[0]?.source, "history");
  assert.equal(frame.columns[1]?.timeUs, 201_000_000);
});

test("decodes kind 3 latest-book record", () => {
  const frame = decodeFrame(makeFrame(3, 0, [{ tsSec: 55, bids: [[400, 9]], asks: [[401, 12]] }]));
  assert.equal(frame.kind, 3);
  assert.equal(frame.columns[0]?.timeUs, 55_000_000);
  assert.equal(frame.columns[0]?.asks.prices[0], 401);
});

test("rejects malformed frames, invalid counts, zero sizes, and trailing bytes", () => {
  assert.throws(() => decodeFrame(new Uint8Array(8)), /incomplete_frame/);
  const badKind = makeFrame(1, 0, [{ tsSec: 1 }]);
  badKind[0] = 9;
  assert.throws(() => decodeFrame(badKind), /invalid_frame_kind/);
  const wrongReq = makeFrame(1, 1, [{ tsSec: 1 }]);
  assert.throws(() => decodeFrame(wrongReq), /invalid_frame_req_id/);
  const wrongCount = makeFrame(1, 0, []);
  assert.throws(() => decodeFrame(wrongCount), /invalid_frame_count/);
  const zeroSize = makeFrame(1, 0, [{ tsSec: 1, bids: [[1, 0]] }]);
  assert.throws(() => decodeFrame(zeroSize), /invalid_column_size/);
  const trailing = new Uint8Array([...makeFrame(1, 0, [{ tsSec: 1 }]), 0]);
  assert.throws(() => decodeFrame(trailing), /trailing_frame_bytes/);
});
