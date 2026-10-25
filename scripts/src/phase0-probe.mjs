import { gzipSync, createGzip } from "node:zlib";
import { once } from "node:events";

// Phase 0 only: read-only requests, one upstream socket, no reconnect and no recorder.
// Raw market data exists only in memory. stdout contains a redacted measurement summary.
const key = process.env.TICKSTREAM_API_KEY;
if (!key) {
  process.stderr.write("TICKSTREAM_API_KEY is required; register it in Secrets.\n");
  process.exit(1);
}
const startedUs = Date.now() * 1000;
const redact = (value) => String(value)
  .replaceAll(key, "[REDACTED]")
  .replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi, "[URL REDACTED]")
  .replace(/sk_(?:live|test)_[A-Za-z0-9_-]+/g, "[REDACTED]");
const log = (event, details = {}) => process.stderr.write(
  JSON.stringify({ recvUs: Date.now() * 1000, event, details },
    (_name, value) => typeof value === "string" ? redact(value) : value) + "\n",
);
const scalarFields = (row) => Object.fromEntries(
  ["type", "symbol", "ts", "tsu", "side", "level", "price", "size", "flag", "seq", "sequence"]
    .filter((name) => row?.[name] !== undefined)
    .map((name) => [name, row[name]]),
);
const windows = [
  { name: "us-open", start: 1792762200, end: 1792762260 },
  { name: "normal", start: 1792771200, end: 1792771260 },
];

async function request(path, params) {
  const url = new URL(`https://api.tick-stream.xyz/v1${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  const begin = performance.now();
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch {
      log("rest_invalid_json", { path, status: response.status });
      return { measurement: { path, params, status: response.status, invalidJson: true }, rows: [] };
    }
    const rows = Array.isArray(body?.book) ? body.book : Array.isArray(body?.ticks) ? body.ticks : [];
    const timestamps = rows.map((r) => r.ts);
    const perTs = new Map();
    const perSide = new Map();
    const flags = new Map();
    let zeroSizes = 0;
    let invalidPriceTicks = 0;
    let invalidTimeUs = 0;
    let outOfOrder = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      perTs.set(row.ts, (perTs.get(row.ts) ?? 0) + 1);
      const id = `${row.ts}:${row.side}`;
      perSide.set(id, Math.max(perSide.get(id) ?? 0, row.level ?? 0));
      flags.set(row.flag, (flags.get(row.flag) ?? 0) + 1);
      if (row.size === 0) zeroSizes++;
      if (!Number.isSafeInteger(row.price * 4)) invalidPriceTicks++;
      // Documented REST row unit: microseconds. Do not infer it from magnitude.
      if (!Number.isSafeInteger(row.ts) ||
          row.ts < params.start * 1_000_000 || row.ts > params.end * 1_000_000) invalidTimeUs++;
      if (i && row.ts < rows[i - 1].ts) outOfOrder++;
    }
    const jsonl = rows.map((r) => JSON.stringify(r) + "\n").join("");
    const measurement = {
      path, params, status: response.status, elapsedMs: Math.round(performance.now() - begin),
      responseBytes: Buffer.byteLength(text), envelopeKeys: Object.keys(body ?? {}),
      count: body?.count, truncated: body?.truncated, historyClamped: body?.history_clamped,
      errorCode: body?.error?.code, rows: rows.length,
      sample: rows.length ? scalarFields(rows[0]) : null,
      rowKeys: rows.length ? Object.keys(rows[0]) : [],
      firstTs: timestamps[0], lastTs: timestamps.at(-1), distinctTimestamps: perTs.size,
      rowsPerTimestampMin: perTs.size ? Math.min(...perTs.values()) : null,
      rowsPerTimestampMax: perTs.size ? Math.max(...perTs.values()) : null,
      maxDepth: perSide.size ? Math.max(...perSide.values()) : null,
      flags: Object.fromEntries(flags), zeroSizes, invalidPriceTicks, invalidTimeUs, outOfOrder,
      jsonlBytes: Buffer.byteLength(jsonl), gzipJsonlBytes: gzipSync(jsonl).length,
    };
    log("rest_complete", { path, status: response.status, rows: rows.length });
    return { measurement, rows };
  } catch {
    log("rest_network_or_timeout", { path });
    return { measurement: { path, params, failure: "network_or_30s_timeout" }, rows: [] };
  }
}

async function live() {
  const summary = {
    requestedSeconds: 60, connected: false, messages: 0, bytes: 0,
    types: {}, schemas: {}, samples: {}, controls: [], invalidJson: 0,
    maxBids: 0, maxAsks: 0, zeroSizes: 0, invalidPriceTicks: 0,
    invalidDocumentedSeconds: 0, jsonPongsSent: 0, perSecond: {},
  };
  const compressor = createGzip();
  let compressedBytes = 0;
  compressor.on("data", (chunk) => { compressedBytes += chunk.length; });
  const compressedDone = once(compressor, "end");
  const url = new URL("wss://stream.tick-stream.xyz/v1/stream");
  url.searchParams.set("key", key);
  url.searchParams.set("symbols", "NQ");
  const begin = Date.now();
  await new Promise((resolve) => {
    const socket = new WebSocket(url);
    let done = false;
    let timer;
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      summary.finishReason = reason;
      summary.observedMs = Date.now() - begin;
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Phase 0 complete");
      else if (socket.readyState === WebSocket.CONNECTING) socket.close();
      resolve();
    };
    const connectTimer = setTimeout(() => finish("connect_timeout"), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      summary.connected = true;
      summary.openUs = Date.now() * 1000;
      socket.send(JSON.stringify({ op: "subscribe", channel: "book", symbols: ["NQ"] }));
      log("ws_open");
      timer = setTimeout(() => finish("observation_complete"), 60_000);
    });
    socket.addEventListener("message", (event) => {
      if (done) return;
      const raw = String(event.data);
      summary.bytes += Buffer.byteLength(raw);
      compressor.write(raw + "\n");
      let payload;
      try { payload = JSON.parse(raw); } catch {
        summary.invalidJson++;
        log("ws_invalid_json");
        return;
      }
      for (const row of Array.isArray(payload) ? payload : [payload]) {
        const type = typeof row?.type === "string" ? row.type : "missing_type";
        summary.messages++;
        summary.types[type] = (summary.types[type] ?? 0) + 1;
        summary.schemas[type] ??= Object.keys(row ?? {});
        if (type === "ping") {
          socket.send(JSON.stringify({ op: "pong" }));
          summary.jsonPongsSent++;
        }
        if (["welcome", "warning", "feed", "error"].includes(type)) {
          // Do not emit arbitrary payloads that might contain account or credential data.
          const control = { type, code: row.error?.code ?? row.code,
            message: typeof row.message === "string" ? redact(row.message) :
              typeof row.error?.message === "string" ? redact(row.error.message) : undefined,
            keys: Object.keys(row) };
          summary.controls.push(control);
          log("ws_control", control);
        }
        if (type === "tick" || type === "book") {
          summary.samples[type] ??= scalarFields(row);
          const second = Math.floor(Date.now() / 1000);
          summary.perSecond[second] ??= {};
          summary.perSecond[second][type] = (summary.perSecond[second][type] ?? 0) + 1;
          // Documented live unit: seconds. A mismatch is recorded, never auto-corrected.
          if (typeof row.ts !== "number" || !Number.isSafeInteger(row.ts * 1_000_000) ||
              Math.abs(row.ts * 1_000_000 - Date.now() * 1000) > 86400 * 1_000_000)
            summary.invalidDocumentedSeconds++;
          if (type === "book") {
            summary.maxBids = Math.max(summary.maxBids, row.bids?.length ?? 0);
            summary.maxAsks = Math.max(summary.maxAsks, row.asks?.length ?? 0);
            summary.samples.bookBids ??= row.bids?.slice(0, 2);
            summary.samples.bookAsks ??= row.asks?.slice(0, 2);
            for (const [price, size] of [...(row.bids ?? []), ...(row.asks ?? [])]) {
              if (size === 0) summary.zeroSizes++;
              if (!Number.isSafeInteger(price * 4)) summary.invalidPriceTicks++;
            }
          } else if (!Number.isSafeInteger(row.price * 4)) summary.invalidPriceTicks++;
        }
      }
    });
    socket.addEventListener("error", () => {
      log("ws_network_error");
      finish("network_error");
    });
    socket.addEventListener("close", (event) => {
      summary.closeCode = event.code;
      log("ws_close", { code: event.code });
      finish("remote_close");
    });
  });
  compressor.end();
  await compressedDone;
  summary.gzipBytes = compressedBytes;
  return summary;
}

async function main() {
  const result = { startedUs, windows, live: await live(), rest: [], paging: [] };
  for (const window of windows) {
    for (const path of ["/history/book", "/history/ticks"]) {
      const params = { symbol: "NQ", start: window.start, end: window.end, limit: 1000 };
      const first = await request(path, params);
      result.rest.push({ window: window.name, ...first.measurement });
      if (first.measurement.status !== 200) continue;
      const full = await request(path, { ...params, limit: 500000 });
      result.rest.push({ window: window.name, ...full.measurement });
      if (first.rows.length && first.measurement.truncated) {
        const start = Math.floor(first.rows.at(-1).ts / 1_000_000);
        const next = await request(path, { ...params, start });
        result.rest.push({ window: window.name, page: "boundary", ...next.measurement });
        result.paging.push({
          window: window.name, path, requestedStartSeconds: start,
          lastFirstPageTsUs: first.rows.at(-1).ts, firstNextPageTsUs: next.rows[0]?.ts,
          note: "Overlapping boundary seconds require occurrence-aware deduplication; no unique ID assumed.",
        });
      }
    }
  }
  const recent = await request("/ticks", {
    symbol: "NQ", start: windows[0].start, end: windows[0].end, limit: 1000,
  });
  result.rest.push({ window: "us-open-recent-api", ...recent.measurement });
  result.finishedUs = Date.now() * 1000;
  process.stdout.write(JSON.stringify(result, (_name, value) =>
    typeof value === "string" ? redact(value) : value, 2) + "\n");
}
main().catch(() => {
  log("probe_failed", { reason: "Unexpected failure; raw exception intentionally withheld." });
  process.exitCode = 1;
});
