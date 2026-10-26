import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { Hub, attachHub, BOARD_LIMIT, CLOSE_LIMIT } from "../src/hub/hub.ts";
import type { Source } from "../src/hub/hub.ts";
import { encodeFrame, decodeFrame } from "../src/hub/frame.ts";

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; output: (string | Buffer)[] = []; codes: number[] = [];
  send(data: string | Buffer, cb?: (error?: Error) => void) { this.output.push(data); cb?.(); }
  close(code: number) { this.codes.push(code); this.readyState = 3; this.emit("close", code); }
  terminate() { this.close(1006); }
}
const column = (tsSec: number) => ({ tsSec, source: "live" as const,
  bids: Array.from({ length: 400 }, (_, i) => ({ price: 40000 - i, size: 8 })),
  asks: Array.from({ length: 400 }, (_, i) => ({ price: 40001 + i, size: 8 })) });
const src: Source = {
  savedRange: () => ({ fromSec: 1, toSec: 10000 }),
  read: async (a, b) => ({ columns: [column(a), column(b - 1)], trades: [] }),
  status: () => ({ dummy: true }),
};
const turn = () => new Promise<void>(r => setImmediate(r));

test("ダミー：30分は6組、650秒rangeは3組、最後のrangeDoneだけで完了", async () => {
  const hub = new Hub(src, () => {}), socket = new Socket();
  try {
    await hub.connect(socket, new URL("http://localhost/api/ws"));
    const json = socket.output.filter(x => typeof x === "string").map(x => JSON.parse(x as string));
    assert.equal(json.filter(x => x.type === "rangeTrades").length, 6);
    assert.equal(json.filter(x => x.type === "rangeDone").length, 1);
    assert.equal(json.find(x => x.type === "rangeDone").chunks, 6);
    socket.output = [];
    socket.emit("message", Buffer.from(JSON.stringify({ op: "range", reqId: 9, fromSec: 100, toSec: 750 })), false);
    await turn();
    assert.deepEqual(socket.output.slice(0, 6).map(x => Buffer.isBuffer(x) ? decodeFrame(x).kind : JSON.parse(x).type),
      [2, "rangeTrades", 2, "rangeTrades", 2, "rangeTrades"]);
    const done = JSON.parse(socket.output.at(-1) as string);
    assert.deepEqual(done, { type: "rangeDone", reqId: 9, fromSec: 100, toSec: 750, columns: 6, trades: 0, chunks: 3 });
  } finally { hub.stop(); }
});

test("ダミー：4MiBちょうどで次の区切りを待つ。range中は16MiBで自己切断しない", async () => {
  const reads: number[] = [], hub = new Hub({ ...src, read: async (a, b) => {
    reads.push(a); return src.read(a, b);
  } }, () => {});
  const socket = new Socket();
  try {
    await hub.connect(socket, new URL("http://localhost/api/ws"));
    socket.output = []; reads.length = 0;
    const originalSend = socket.send.bind(socket);
    socket.send = (data, cb) => {
      originalSend(data, cb);
      if (Buffer.isBuffer(data) && data[0] === 2) socket.bufferedAmount = CLOSE_LIMIT + 1;
    };
    socket.emit("message", Buffer.from(JSON.stringify({ op: "range", reqId: 1, fromSec: 100, toSec: 750 })), false);
    await turn();
    assert.equal(reads.length, 1);
    assert.equal(socket.output.length, 2, "pair was sent despite inflated backlog");
    assert.deepEqual(socket.codes, []);
    socket.bufferedAmount = BOARD_LIMIT;
    await new Promise(r => setTimeout(r, 65));
    assert.equal(reads.length, 1, "exactly 4MiB is not below threshold");
    socket.send = originalSend; socket.bufferedAmount = BOARD_LIMIT - 1;
    await new Promise(r => setTimeout(r, 65));
    assert.equal(reads.length, 3);
    assert.equal(JSON.parse(socket.output.at(-1) as string).type, "rangeDone");
    assert.equal(hub.snapshot().slowClosed, 0);
  } finally { hub.stop(); }
});

test("ダミー：送信待ち中のブラウザ切断を中断し、接続IDと処理段階を記録", async () => {
  const logs: { event: string; details: any }[] = [];
  const hub = new Hub(src, (event, details) => logs.push({ event, details }));
  const socket = new Socket();
  try {
    await hub.connect(socket, new URL("http://localhost/api/ws"));
    socket.bufferedAmount = BOARD_LIMIT;
    socket.emit("message", Buffer.from(JSON.stringify({ op: "range", reqId: 2, fromSec: 100, toSec: 750 })), false);
    await turn(); socket.close(1000);
    await new Promise(r => setTimeout(r, 65));
    const close = logs.find(x => x.event === "hub_closed")!;
    assert.equal(close.details.phase, "range"); assert.equal(close.details.reqId, 2);
    assert.equal(close.details.code, 1000); assert.ok(close.details.peerId);
    assert.ok(logs.some(x => x.event === "hub_range_aborted"));
  } finally { hub.stop(); }
});

for (const mode of ["none", "reset", "keep"] as const) test(`ダミー：圧縮${mode}の実WS交渉・バイナリが元と完全一致`, async () => {
  const server = createServer(), hub = new Hub(src, () => {}), wss = attachHub(server, hub);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, {
    perMessageDeflate: mode === "none" ? false : { clientNoContextTakeover: true,
      ...(mode === "reset" ? { serverNoContextTakeover: true } : {}) },
  });
  let extensions = "";
  ws.on("upgrade", r => { extensions = String(r.headers["sec-websocket-extensions"] ?? ""); });
  const payloads: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (bytes, binary) => {
        if (binary) payloads.push(Buffer.from(bytes as Buffer));
        else if (JSON.parse(bytes.toString()).type === "rangeDone") resolve();
      });
    });
    assert.equal(payloads.length, 6);
    for (const frame of payloads) {
      const decoded = decodeFrame(frame);
      assert.deepEqual(frame, encodeFrame(2, 0, decoded.columns));
    }
    if (mode === "none") assert.equal(extensions, "");
    else {
      assert.match(extensions, /permessage-deflate/);
      assert.equal(extensions.includes("server_no_context_takeover"), mode === "reset");
      assert.match(extensions, /client_no_context_takeover/);
    }
  } finally {
    ws.close(); hub.stop(); wss.close(); await new Promise<void>(r => server.close(() => r()));
  }
});
