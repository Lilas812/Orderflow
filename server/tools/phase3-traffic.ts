// Read-only downstream probe. No upstream connection or credentials.
// Usage: node tools/phase3-traffic.ts OUTPUT [none|reset|keep] [old|chunked]
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const [output, mode = "none", protocol = "chunked"] = process.argv.slice(2);
if (!output || !["none", "reset", "keep"].includes(mode)) throw Error("invalid_arguments");
const start = Date.now();
const socket = new WebSocket("ws://localhost/api/ws", {
  perMessageDeflate: mode === "none" ? false : {
    clientNoContextTakeover: true, ...(mode === "reset" ? { serverNoContextTakeover: true } : {}),
  },
});
type Count = { messages: number; expanded: number; wire: number };
const count = (): Count => ({ messages: 0, expanded: 0, wire: 0 });
const initial = count();
const minutes = Array.from({ length: 5 }, () => Object.fromEntries(
  ["columns", "book", "trades", "status", "other"].map(k => [k, count()])));
const frames: { wire: number; compressed: boolean }[] = [];
let raw = Buffer.alloc(0), fragmentBytes = 0, fragmentCompressed = false;
let initialDone: number | null = null, initialColumns = false, negotiated = "";
let totalFrames = 0, totalMessages = 0, compressedMessages = 0;
let initialColumnCount = 0, initialTradeCount = 0, helloTimeUs: number | null = null;
let initialRange: unknown = null;
const errors: string[] = [];
let finished = false;
socket.on("upgrade", response => {
  negotiated = String(response.headers["sec-websocket-extensions"] ?? "");
  // Public IncomingMessage.socket sees actual WS frame bytes, before inflation.
  // ws unshifts the HTTP-upgrade head back onto this socket.
  response.socket.on("data", bytes => {
    raw = Buffer.concat([raw, bytes]);
    while (raw.length >= 2) {
      const opcode = raw[0]! & 15, fin = !!(raw[0]! & 128);
      let length = raw[1]! & 127, header = 2;
      if (length === 126) { if (raw.length < 4) break; length = raw.readUInt16BE(2); header = 4; }
      else if (length === 127) {
        if (raw.length < 10) break;
        const n = raw.readBigUInt64BE(2);
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("frame_too_large");
        length = Number(n); header = 10;
      }
      if (raw[1]! & 128) throw Error("masked_server_frame");
      if (raw.length < header + length) break;
      if (opcode < 8) {
        if (opcode !== 0) fragmentCompressed = !!(raw[0]! & 64);
        fragmentBytes += header + length;
        if (fin) { frames.push({ wire: fragmentBytes, compressed: fragmentCompressed }); fragmentBytes = 0; totalFrames++; }
      }
      raw = raw.subarray(header + length);
    }
  });
});
async function finish(reason: string) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline); clearInterval(tick);
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, "measurement_complete");
  const result = { mode, protocol, startedAt: new Date(start).toISOString(), negotiated,
    initial: { ...initial, elapsedMs: initialDone === null ? null : initialDone - start,
      columns: initialColumnCount, trades: initialTradeCount, helloTimeUs, range: initialRange },
    waitMs: 120000, sampleMs: 300000, minutes, totalFrames, totalMessages, compressedMessages,
    unmatchedFrames: frames.length, unparsedBytes: raw.length, reason, errors,
    units: "wire includes WS headers; excludes HTTP handshake, control frames, TLS and TCP" };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, reason, negotiated, initial: result.initial, errors }));
  if (reason !== "complete" || errors.length || frames.length) process.exitCode = 1;
}
socket.on("message", (data, binary) => {
  totalMessages++;
  const wire = frames.shift();
  if (!wire) { errors.push("message_without_wire_frame"); return; }
  if (wire.compressed) compressedMessages++;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  let kind = "other", done = false;
  if (binary) {
    const tag = bytes[0];
    kind = tag === 3 ? "book" : "columns";
    if (tag === 2 && bytes.readUInt32LE(1) === 0) initialColumns = true;
    if (tag === 2 && initialDone === null) initialColumnCount += bytes.readUInt32LE(5);
  } else {
    const value = JSON.parse(bytes.toString());
    if (value.type === "hello") helloTimeUs = value.serverTimeUs;
    if (value.type === "rangeTrades" && value.reqId === 0 && initialDone === null) initialTradeCount += value.trades.length;
    if (value.type === "rangeDone" && value.reqId === 0) initialRange = value;
    kind = value.type === "trades" || value.type === "rangeTrades" ? "trades" : value.type === "status" ? "status" : "other";
    done = protocol === "old"
      ? value.type === "rangeTrades" && value.reqId === 0 && initialColumns
      : value.type === "rangeDone" && value.reqId === 0;
    if (value.type === "error") errors.push(String(value.code));
  }
  const now = Date.now();
  let target: Count | undefined;
  if (initialDone === null) target = initial;
  else {
    const minute = Math.floor((now - initialDone - 120000) / 60000);
    if (minute >= 0 && minute < 5) target = minutes[minute]![kind];
  }
  if (target) { target.messages++; target.expanded += bytes.length; target.wire += wire.wire; }
  if (done && initialDone === null) {
    initialDone = now;
    console.log(JSON.stringify({ event: "initial_complete", mode, elapsedMs: now - start, negotiated }));
  }
});
socket.on("error", () => { errors.push("transport_error"); void finish("error"); });
socket.on("close", code => { if (!finished) { errors.push(`unexpected_close_${code}`); void finish("closed"); } });
const tick = setInterval(() => {
  if (initialDone !== null && Date.now() >= initialDone + 420000) void finish("complete");
}, 100);
const deadline = setTimeout(() => void finish("initial_or_sample_timeout"), 600000);
