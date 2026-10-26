import { createGzip, gzipSync } from "node:zlib";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { distribution, histogram, perSecondStats, timestampCandidates, inspectBook,
  halfOpen, splitWindow, compareOccurrences, analyzeHistory } from "./phase0-analysis.mjs";

// Phase 0 only. One upstream socket; no automatic reconnect or repeated live run.
const args = process.argv.slice(2);
const minutes = Number(args[1]);
if (args.length !== 2 || args[0] !== "--minutes" || ![5, 60].includes(minutes)) {
  process.stderr.write("Usage: node scripts/src/phase0-probe.mjs --minutes 5|60\n");
  process.exit(1);
}
const key = process.env.TICKSTREAM_API_KEY;
if (!key) {
  process.stderr.write("TICKSTREAM_API_KEY is required in Secrets.\n");
  process.exit(1);
}
const startedUs = Date.now() * 1000;
const directory = "data/probe";
const redact = (value) => String(value).replaceAll(key, "[REDACTED]")
  .replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi, "[URL REDACTED]");
const safeJson = (value, spaces) => JSON.stringify(value,
  (_name, item) => typeof item === "string" ? redact(item) : item, spaces);
let eventWriter;
const log = (event, details = {}) => {
  const line = safeJson({ recvUs: Date.now() * 1000, event, details }) + "\n";
  process.stderr.write(line);
  eventWriter?.write(line);
};
// Never silently redact evidence: fail if raw bytes would disclose the credential.
function assertSafeRaw(raw) {
  if (raw.includes(key)) throw new Error("credential_in_raw_response");
}

async function gzipWriter(path) {
  const compressor = createGzip();
  const destination = createWriteStream(path, { flags: "wx", mode: 0o600 });
  let failure;
  const done = pipeline(compressor, destination).catch((error) => { failure = error; });
  return {
    async write(text) {
      if (failure) throw new Error("recording_failed");
      if (!compressor.write(text)) await once(compressor, "drain");
    },
    async end() {
      compressor.end();
      await done;
      if (failure) throw new Error("recording_failed");
      return (await stat(path)).size;
    },
  };
}

async function live() {
  const path = `${directory}/ws-${startedUs}.jsonl.gz`;
  const recorder = await gzipWriter(path);
  // Separate gzip measurement for received payload bytes, without metadata/newline.
  const payloadCompressor = createGzip();
  let payloadGzipBytes = 0;
  payloadCompressor.on("data", (chunk) => { payloadGzipBytes += chunk.length; });
  const payloadDone = once(payloadCompressor, "end");
  const result = { requestedMinutes: minutes, path, frames: 0, bytes: 0,
    recordingBytes: 0, types: {}, invalidJson: 0, jsonPongsSent: 0,
    anomalies: {}, examples: {}, bookTs: new Map(), depth: { bids: [], asks: [] },
    digits: [], differencesUs: { seconds: [], milliseconds: [], microseconds: [], nanoseconds: [] },
    imbalance: [], imbalanceErrors: { bestSignedRatio: [], signedRatio: [], bidFraction: [], bidAskRatio: [] },
    imbalanceExamples: [], controls: [] };
  const perTypeSeconds = new Map();
  let lastFrame;
  let queue = Promise.resolve();
  let queueFailure;
  let observationEndedUs;
  let observedTicks = 0;
  const url = new URL("wss://stream.tick-stream.xyz/v1/stream");
  url.searchParams.set("key", key);
  url.searchParams.set("symbols", "NQ");
  await new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let openTimer, noTradeTimer, durationTimer, closeTimer;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      for (const timer of [openTimer, noTradeTimer, durationTimer, closeTimer]) clearTimeout(timer);
      resolve();
    };
    const finish = (reason) => {
      if (result.finishReason) return;
      result.finishReason = reason;
      observationEndedUs = Date.now() * 1000;
      clearTimeout(noTradeTimer);
      clearTimeout(durationTimer);
      log("observation_stop", { reason });
      if (socket.readyState === WebSocket.OPEN) {
        result.closeSentUs = Date.now() * 1000;
        log("ws_close_sent", { code: 1000 });
        socket.close(1000, "Phase 0 complete");
      } else if (socket.readyState === WebSocket.CONNECTING) socket.close();
      // Diagnostic bound, not a retry policy. Timeout is a failed handshake.
      closeTimer = setTimeout(() => {
        result.closeHandshakeTimeout = true;
        log("ws_close_timeout", { timeoutSeconds: 15 });
        settle();
      }, 15_000);
    };
    openTimer = setTimeout(() => finish("connect_timeout"), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(openTimer);
      result.openUs = Date.now() * 1000;
      socket.send(JSON.stringify({ op: "subscribe", channel: "book", symbols: ["NQ"] }));
      log("ws_open");
      noTradeTimer = setTimeout(() => {
        if (!observedTicks) finish("market_closed_no_tick_in_30s");
      }, 30_000);
      durationTimer = setTimeout(() => finish("observation_complete"), minutes * 60_000);
    });
    socket.addEventListener("message", (event) => {
      const recvUs = Date.now() * 1000;
      const binary = typeof event.data !== "string";
      const raw = binary ? Buffer.from(event.data).toString("base64") : event.data;
      const encoded = { recvUs, raw, ...(binary ? { encoding: "base64" } : {}) };
      let payload;
      try {
        assertSafeRaw(binary ? Buffer.from(event.data).toString("utf8") : raw);
        if (!binary) payload = JSON.parse(raw);
      } catch (error) {
        if (error.message === "credential_in_raw_response") {
          queueFailure = "credential_in_raw_response";
          finish(queueFailure);
          return;
        }
      }
      // Heartbeat processing is not delayed by filesystem backpressure.
      const messages = Array.isArray(payload) ? payload : payload ? [payload] : [];
      for (const row of messages) {
        if (row?.type === "ping" && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: "pong" }));
          result.jsonPongsSent++;
        }
        if (!observationEndedUs && ["tick", "ticks"].includes(row?.type)) observedTicks++;
      }
      const duringObservation = !observationEndedUs;
      queue = queue.then(async () => {
        const line = JSON.stringify(encoded) + "\n";
        await recorder.write(line);
        result.recordingBytes += Buffer.byteLength(line);
        lastFrame = encoded;
        if (!duringObservation) return; // Still record close-wait frames, not observation stats.
        result.frames++;
        result.bytes += binary ? Buffer.from(event.data).length : Buffer.byteLength(raw);
        payloadCompressor.write(binary ? Buffer.from(event.data) : raw);
        if (!payload) { result.invalidJson++; return; }
        for (const row of messages) {
          const type = typeof row?.type === "string" ? row.type : "missing_type";
          result.types[type] = (result.types[type] ?? 0) + 1;
          if (!perTypeSeconds.has(type)) perTypeSeconds.set(type, new Map());
          const bucket = Math.floor((recvUs - result.openUs) / 1_000_000);
          const counts = perTypeSeconds.get(type);
          counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
          if (["welcome", "warning", "feed", "error"].includes(type)) {
            const control = { type, code: row.code ?? row.error?.code,
              message: row.message ?? row.error?.message, keys: Object.keys(row) };
            result.controls.push(control);
            log("ws_control", control);
          }
          if (type === "tick" || type === "ticks") {
            result.firstTickRecvUs ??= recvUs;
            const candidate = timestampCandidates(row.ts, recvUs);
            if (!candidate) { result.invalidTickTs = (result.invalidTickTs ?? 0) + 1; continue; }
            result.digits.push(candidate.digits);
            for (const unit of Object.keys(result.differencesUs)) result.differencesUs[unit].push(candidate[unit]);
            result.tickExample ??= { ts: row.ts, recvUs };
          }
          if (type !== "book") continue;
          result.bookTs.set(row.ts, (result.bookTs.get(row.ts) ?? 0) + 1);
          for (const side of ["bids", "asks"]) {
            if (Array.isArray(row[side])) result.depth[side].push(row[side].length);
          }
          const inspection = inspectBook(row);
          for (const [kind, count] of Object.entries(inspection.counts)) {
            result.anomalies[kind] = (result.anomalies[kind] ?? 0) + count;
            result.examples[kind] ??= { recvUs, ts: row.ts, levels: inspection.examples[kind] };
          }
          if (Number.isFinite(row.imbalance)) {
            result.imbalance.push(row.imbalance);
            for (const [name, value] of Object.entries(inspection.candidates)) {
              if (value !== null) result.imbalanceErrors[name].push(row.imbalance - value);
            }
            if (result.imbalanceExamples.length < 3) result.imbalanceExamples.push({
              ts: row.ts, imbalance: row.imbalance, sums: inspection.sums,
              candidates: inspection.candidates });
          }
        }
      }).catch(() => {
        queueFailure = "recording_or_analysis_failed";
        finish(queueFailure);
      });
    });
    socket.addEventListener("error", () => {
      result.errorUs = Date.now() * 1000;
      log("ws_network_error");
      finish("network_error");
    });
    socket.addEventListener("close", (event) => {
      result.closeReceivedUs = Date.now() * 1000;
      result.closeCode = event.code;
      result.wasClean = event.wasClean;
      const unexpected = !result.finishReason;
      log("ws_close_received", { code: event.code, wasClean: event.wasClean,
        unexpected, initiator: result.closeSentUs ? "client_close_requested" : "remote_or_transport_unknown" });
      if (unexpected) {
        result.finishReason = "unexpected_disconnect";
        observationEndedUs = result.closeReceivedUs;
        result.unexpectedDisconnect = { recvUs: result.closeReceivedUs,
          precedingFrame: "Last received frame is stored in the WS recording." };
      }
      settle();
    });
  });
  await queue;
  if (result.unexpectedDisconnect) result.unexpectedDisconnect.precedingFrame = lastFrame;
  result.recordingGzipBytes = await recorder.end();
  payloadCompressor.end();
  await payloadDone;
  result.payloadGzipBytes = payloadGzipBytes;
  result.observedUs = result.openUs ? observationEndedUs - result.openUs : 0;
  result.perTypePerSecond = Object.fromEntries([...perTypeSeconds].map(([type, counts]) =>
    [type, perSecondStats(counts, result.types[type], result.observedUs)]));
  result.hourlyExtrapolatedBytes = result.observedUs > 0 ? {
    payload: result.bytes * 3_600_000_000 / result.observedUs,
    payloadGzip: payloadGzipBytes * 3_600_000_000 / result.observedUs,
    recording: result.recordingBytes * 3_600_000_000 / result.observedUs,
    recordingGzip: result.recordingGzipBytes * 3_600_000_000 / result.observedUs,
  } : null;
  result.bookTsRepetitions = histogram([...result.bookTs.values()]);
  delete result.bookTs;
  result.depth = Object.fromEntries(Object.entries(result.depth).map(([k, v]) => [k, distribution(v)]));
  result.digits = histogram(result.digits);
  result.differencesUs = Object.fromEntries(Object.entries(result.differencesUs).map(([k, v]) => [k, distribution(v)]));
  result.imbalance = distribution(result.imbalance);
  result.imbalanceErrors = Object.fromEntries(Object.entries(result.imbalanceErrors).map(([k, v]) => [k, distribution(v)]));
  result.queueFailure = queueFailure ?? null;
  return result;
}

async function request(start, end, limit, requests) {
  const url = new URL("https://api.tick-stream.xyz/v1/history/book");
  for (const [name, value] of Object.entries({ symbol: "NQ", start, end, limit }))
    url.searchParams.set(name, String(value));
  const begin = performance.now();
  const record = { start, end, limit, requestedUs: Date.now() * 1000 };
  requests.push(record);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000) });
  record.elapsedFetchMs = performance.now() - begin;
  record.status = response.status;
  record.headers = Object.fromEntries([...response.headers].filter(([name]) =>
    /^(retry-after|ratelimit.*|x-ratelimit.*|date|content-type)$/.test(name)));
  const raw = Buffer.from(await response.arrayBuffer());
  assertSafeRaw(raw.toString("utf8"));
  record.path = `${directory}/rest-book-${record.requestedUs}.json.gz`;
  const compressed = gzipSync(raw);
  await writeFile(record.path, compressed, { flag: "wx", mode: 0o600 });
  record.responseBytes = raw.length;
  record.gzipBytes = compressed.length;
  record.elapsedMs = performance.now() - begin;
  log("rest_complete", record);
  if (response.status === 429 || record.headers["retry-after"] ||
      (response.status >= 400 && (record.headers["x-ratelimit-remaining"] === "0" ||
        record.headers["ratelimit-remaining"] === "0"))) throw new Error("rate_limited_stop");
  if (!response.ok && limit !== 500001) throw new Error("rest_http_failure");
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch {
    record.invalidJson = true;
    if (limit === 500001) return { record, rows: [] };
    throw new Error("rest_invalid_json");
  }
  record.truncated = body.truncated;
  record.historyClamped = body.history_clamped;
  record.errorCode = body.error?.code;
  const rows = Array.isArray(body.book) ? body.book : null;
  record.rows = rows?.length ?? 0;
  if (limit !== 500001 && !rows) throw new Error("rest_missing_book");
  return { record, rows: rows ?? [] };
}

async function history(liveResult) {
  // Last fully elapsed 10-minute interval before the live measurement began.
  // A live tick is required before selecting this interval; no fixed old window.
  const end = Math.floor(liveResult.openUs / 60_000_000) * 60;
  const start = end - 600;
  const result = { start, end, requests: [], windows: [], boundaries: [] };
  const begin = performance.now();
  let previousBoundaryRows;
  async function window(a, b) {
    const { record, rows } = await request(a, b, 500000, result.requests);
    if (record.truncated === true) {
      const parts = [];
      for (const [left, right] of splitWindow(a, b)) parts.push(...await window(left, right));
      return parts;
    }
    if (record.truncated !== false) throw new Error("truncated_flag_unknown");
    if (record.historyClamped) throw new Error("history_clamped");
    const kept = halfOpen(rows, a, b);
    return [{ start: a, end: b, rows: kept,
      headSecond: rows.filter((r) => r.ts >= a * 1_000_000 && r.ts < (a + 1) * 1_000_000),
      endSecond: rows.filter((r) => r.ts >= b * 1_000_000 && r.ts < (b + 1) * 1_000_000),
      record, excludedRows: rows.length - kept.length }];
  }
  try {
    for (let a = start; a < end; a += 60) {
      const windowBegin = performance.now();
      const leaves = await window(a, a + 60);
      const combined = [];
      const boundaries = [];
      for (const leaf of leaves) {
        if (previousBoundaryRows) {
          const prev = result.windows.at(-1);
          boundaries.push({ at: leaf.start,
            ...compareOccurrences(previousBoundaryRows, leaf.headSecond),
            note: "Compares overlapping response second with multiplicity; does not prove feed completeness." });
          if (prev && !combined.length) {
            result.boundaries.push({ at: leaf.start, lastTs: prev.analysis.lastTs,
              firstTs: leaf.rows[0]?.ts ?? null,
              gapUs: leaf.rows.length && prev.analysis.lastTs !== null ?
                leaf.rows[0].ts - prev.analysis.lastTs : null });
          }
        }
        previousBoundaryRows = leaf.endSecond;
        for (const row of leaf.rows) combined.push(row);
      }
      const analysis = analyzeHistory(combined);
      result.windows.push({ start: a, end: a + 60, elapsedMs: performance.now() - windowBegin,
        leaves: leaves.map(({ start, end, excludedRows, record }) =>
          ({ start, end, excludedRows, path: record.path })), boundaries, analysis });
      log("history_window_analyzed", { start: a, rows: analysis.rows,
        groups: analysis.groups, doubles: analysis.doubles.length });
    }
    // Exactly one above-limit probe, only after successful normal requests.
    await request(start, start + 60, 500001, result.requests);
  } catch (error) {
    result.failure = ["rate_limited_stop", "rest_http_failure", "rest_invalid_json",
      "rest_missing_book", "truncated_flag_unknown", "history_clamped",
      "credential_in_raw_response"].includes(error.message) ? error.message : "history_failed_or_timeout";
    log("history_stop", { reason: result.failure });
  }
  result.totalElapsedMs = performance.now() - begin;
  return result;
}

async function main() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const eventsPath = `${directory}/events-${startedUs}.jsonl`;
  eventWriter = createWriteStream(eventsPath, { flags: "wx", mode: 0o600 });
  let eventFailure = false;
  eventWriter.on("error", () => { eventFailure = true; });
  const result = { startedUs, eventsPath, node: process.version };
  try {
    result.live = await live();
    if (result.live.finishReason === "observation_complete" && !result.live.queueFailure &&
        result.live.firstTickRecvUs) {
      result.history = await history(result.live);
    } else {
      result.history = { skipped: "Live measurement aborted or recording/analysis failed." };
    }
    result.finishedUs = Date.now() * 1000;
    const path = `${directory}/summary-${startedUs}.json`;
    result.summaryPath = path;
    result.eventFailure = eventFailure;
    await writeFile(path, safeJson(result, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(safeJson(result, 2) + "\n");
    if (result.live.finishReason !== "observation_complete" || result.live.queueFailure ||
        result.history.failure || result.history.skipped || eventFailure) process.exitCode = 1;
  } finally {
    const ended = once(eventWriter, "close");
    eventWriter.end();
    await ended;
  }
}

main().catch(() => {
  log("probe_failed", { reason: "Failure: raw exception intentionally withheld." });
  process.exitCode = 1;
});
