import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { decodeFrame } from "../src/hub/frame.ts";
import { encodeColumns } from "../src/store/binary.ts";

export interface ClientOptions {
  url?: string; seconds?: number; mode?: "live" | "replay"; from?: number; speed?: number;
  range?: { fromSec: number; toSec: number }; untilEnd?: boolean;
}
function intervals(values: number[]) {
  const samples = values.slice(1).map((v, i) => v - values[i]).sort((a, b) => a - b);
  return { count: samples.length, minMs: samples[0] ?? null, maxMs: samples.at(-1) ?? null,
    meanMs: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null,
    medianMs: samples[Math.floor(samples.length / 2)] ?? null };
}
/** Only downstream WS; never loads an upstream API key or opens TICK STREAM. */
export async function runClient(options: ClientOptions = {}) {
  const url = new URL(options.url ?? "ws://localhost/api/ws");
  if (options.mode === "replay") {
    url.searchParams.set("mode", "replay"); url.searchParams.set("from", String(options.from));
    url.searchParams.set("speed", String(options.speed ?? 10));
  }
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const started = performance.now(), startedAtUs = Date.now() * 1000;
  const counts: Record<string, number> = {}, bytesByType: Record<string, number> = {};
  const bytesPerMinute: Record<string, Record<string, number>> = {};
  const boardAt: number[] = [], tradesAt: number[] = [];
  const columns: { sec: number; digest: string }[] = [];
  const errors: unknown[] = [], violations: unknown[] = [], gaps: { fromSec: number; toSec: number }[] = [];
  let previousColumn: number | null = null, initialLast: number | null = null, initialSeam: unknown = null;
  let initialColumns = 0, initialTrades = 0, liveTrades = 0, replayEnded = false;
  let hello: unknown = null, latestStatus: unknown = null, finished = false, openedAtUs: number | null = null;
  let rangeSentAt: number | null = null, rangeResult: Record<string, unknown> | null = null;
  const REQ = 77;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let timer = setTimeout(() => finish("connection_timeout"), (options.seconds ?? 120) * 1000);
    socket.addEventListener("open", () => {
      openedAtUs = Date.now() * 1000; clearTimeout(timer);
      timer = setTimeout(() => finish("duration"), (options.seconds ?? 120) * 1000);
    });
    const finish = (reason: string) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const elapsedMs = performance.now() - started;
      socket.close(1000, "verification_complete");
      resolve({ startedAtUs, openedAtUs, finishedAtUs: Date.now() * 1000, elapsedMs, reason, mode: options.mode ?? "live",
        hello, counts, bytesByType, totalBytes: Object.values(bytesByType).reduce((a, b) => a + b, 0),
        bytesPerMinute, meanBytesPerMinuteByType: Object.fromEntries(Object.entries(bytesByType)
          .map(([type, bytes]) => [type, bytes * 60000 / elapsedMs])),
        initialColumns, initialTrades, liveColumns: columns.length, liveTrades,
        initialSeam, gaps, violations, boardInterval: intervals(boardAt), tradesInterval: intervals(tradesAt),
        range: rangeResult, replayEnded, errors, columns, latestStatus });
    };
    socket.addEventListener("error", () => { errors.push({ code: "downstream_socket_error" }); finish("error"); });
    socket.addEventListener("close", event => {
      if (!finished) { errors.push({ code: "unexpected_close", closeCode: event.code }); finish("close"); }
    });
    socket.addEventListener("message", event => {
      if (finished) return;
      try {
        const at = performance.now(), elapsed = at - started;
        const binary = typeof event.data !== "string";
        const bytes = binary ? Buffer.from(event.data as ArrayBuffer) : Buffer.from(event.data as string);
        let type: string;
        if (binary) {
          const frame = decodeFrame(bytes); type = `kind${frame.kind}`;
          if (frame.kind === 2) {
            for (let i = 1; i < frame.columns.length; i++) if (frame.columns[i].tsSec <= frame.columns[i - 1].tsSec)
              violations.push({ code: "range_not_ascending", reqId: frame.reqId });
            if (frame.reqId === 0) {
              initialColumns = frame.columns.length; initialLast = frame.columns.at(-1)?.tsSec ?? null;
              previousColumn = initialLast;
            } else if (frame.reqId === REQ) rangeResult = { reqId: REQ, columns: frame.columns.length,
              fromSec: options.range?.fromSec, toSec: options.range?.toSec,
              firstSec: frame.columns[0]?.tsSec ?? null, lastSec: frame.columns.at(-1)?.tsSec ?? null,
              bytes: bytes.length };
          } else if (frame.kind === 1) {
            const c = frame.columns[0], sec = c.tsSec;
            if (initialSeam === null) initialSeam = { lastInitialSec: initialLast, firstLiveSec: sec,
              missingSeconds: initialLast === null ? null : Math.max(0, sec - initialLast - 1),
              overlap: initialLast !== null && sec <= initialLast };
            if (previousColumn !== null) {
              if (sec <= previousColumn) violations.push({ code: "column_not_ascending_or_duplicate", previousColumn, sec });
              else if (sec > previousColumn + 1) gaps.push({ fromSec: previousColumn + 1, toSec: sec });
            }
            previousColumn = sec;
            columns.push({ sec, digest: createHash("sha256").update(encodeColumns([c])).digest("hex") });
          } else boardAt.push(at);
        } else {
          const message = JSON.parse(bytes.toString()); type = message.type;
          if (type === "hello") hello = message;
          else if (type === "trades") { liveTrades += message.trades.length; tradesAt.push(at); }
          else if (type === "rangeTrades") {
            if (message.reqId === 0) {
              initialTrades = message.trades.length;
              if (options.range && rangeSentAt === null) {
                rangeSentAt = performance.now();
                socket.send(JSON.stringify({ op: "range", reqId: REQ, ...options.range }));
              }
            } else if (message.reqId === REQ) {
              if (!rangeResult) violations.push({ code: "rangeTrades_without_columns" });
              rangeResult = { ...rangeResult, trades: message.trades.length, elapsedMs: at - rangeSentAt! };
            }
          } else if (type === "status") {
            latestStatus = message;
            if (message.replay?.state === "ended") replayEnded = true;
          } else if (type === "error") errors.push(message);
        }
        counts[type] = (counts[type] ?? 0) + 1;
        bytesByType[type] = (bytesByType[type] ?? 0) + bytes.length;
        const minute = String(Math.floor(elapsed / 60000)), bucket = bytesPerMinute[minute] ??= {};
        bucket[type] = (bucket[type] ?? 0) + bytes.length;
        if (replayEnded && options.untilEnd) finish("replay_ended");
      } catch {
        errors.push({ code: "decode_or_protocol_error" });
        finish("decode_error");
      }
    });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i];
    if (name === "--until-end") flags.set(name, "true");
    else flags.set(name, process.argv[++i]);
  }
  const number = (name: string, fallback?: number) => {
    if (!flags.has(name)) return fallback;
    const n = Number(flags.get(name)); if (!Number.isFinite(n)) throw Error(`invalid ${name}`); return n;
  };
  const result = await runClient({ url: flags.get("--url"), seconds: number("--seconds", 120),
    mode: flags.get("--mode") as "live" | "replay" | undefined, from: number("--from"), speed: number("--speed", 10),
    untilEnd: flags.has("--until-end"),
    range: flags.has("--range-from") ? { fromSec: number("--range-from")!, toSec: number("--range-to")! } : undefined });
  if (flags.has("--out")) await fs.writeFile(flags.get("--out")!, JSON.stringify(result, null, 2));
  const { columns, latestStatus, ...summary } = result;
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if ((result.errors as unknown[]).length || (result.violations as unknown[]).length
    || (flags.has("--until-end") && !result.replayEnded)) process.exitCode = 1;
}
