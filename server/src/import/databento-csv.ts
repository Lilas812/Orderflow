import { spawn } from "node:child_process";
import { createZstdDecompress } from "node:zlib";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { createInterface } from "node:readline";

/** Decimal CSV prices are NOT DBN fixed-point integers. No binary float rounding. */
export function priceTicks(text: string, tick: "0.25" | "0.10"): number {
  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) throw Error("invalid_decimal_price");
  const [whole, frac = ""] = text.split(".");
  const nano = BigInt(whole!) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
  const step = tick === "0.25" ? 250_000_000n : 100_000_000n;
  if (nano % step) throw Error("off_tick_price");
  const result = Number(nano / step);
  if (!Number.isSafeInteger(result) || result <= 0) throw Error("unsafe_price");
  return result;
}
export function timestamp(text: string): { us: number; ns: string } {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(text);
  if (!m) throw Error("invalid_utc_timestamp");
  const sec = Date.parse(m[1] + "Z") / 1000;
  if (!Number.isInteger(sec) || new Date(sec * 1000).toISOString().slice(0, 19) !== m[1]) throw Error("invalid_utc_timestamp");
  const ns = BigInt(sec) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
  const us = Number(ns / 1000n);
  if (!Number.isSafeInteger(us)) throw Error("unsafe_timestamp");
  // Floor to the app's microsecond unit; original ns remains in every source record.
  return { us, ns: ns.toString() };
}
export function fields(line: string): string[] {
  const out: string[] = []; let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { out.push(value); value = ""; }
    else value += c;
  }
  if (quoted) throw Error("unterminated_csv_quote");
  out.push(value); return out;
}
export const header = "ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence,symbol";
export function convert(line: string, row: number) {
  const c = fields(line);
  if (c.length !== 14 || c[2] !== "0" || c[5] !== "T") throw Error("not_a_trade_record");
  const m = /^(NQ|GC)([FGHJKMNQUVXZ])(\d{1,2})$/.exec(c[13]!);
  if (!m) throw Error(c[13]?.includes("-") ? "calendar_spread" : "unsupported_or_unknown_contract");
  const symbol = m[1] as "NQ" | "GC";
  // A single digit year is ambiguous without a dated query; the caller resolves it.
  const event = timestamp(c[1]!), recv = timestamp(c[0]!);
  if (!/^\d+$/.test(c[9]!) || !Number.isSafeInteger(Number(c[9])) || Number(c[9]) <= 0) throw Error("invalid_size");
  if (!["A", "B", "N"].includes(c[6]!)) throw Error("invalid_side");
  return { symbol, rawContract: c[13]!, yearDigits: m[3]!, month: m[2]!,
    trade: { tsUs: event.us, recvUs: recv.us, seq: row, price: priceTicks(c[8]!, symbol === "NQ" ? "0.25" : "0.10"),
      size: Number(c[9]), side: c[6] === "B" ? "buy" as const : c[6] === "A" ? "sell" as const : "unknown" as const,
      source: { tsEventNs: event.ns, tsRecvNs: recv.ns, instrumentId: c[4]!, exchangeSequence: c[12]!, rawSymbol: c[13]! } } };
}

/** Streams compressed bytes directly from ZIP; no expanded day/month in RAM. */
export async function scanCsv(zip: string, member: string, expectedHash: string,
  visit: (line: string, row: number) => Promise<void>, signal?: AbortSignal) {
  if (!/^[a-z0-9.-]+\.csv\.zst$/.test(member)) throw Error("unsafe_archive_member");
  const child = spawn("unzip", ["-p", zip, member], { stdio: ["ignore", "pipe", "pipe"] });
  let errorText = ""; child.stderr.on("data", b => { if (errorText.length < 2000) errorText += b; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const hash = createHash("sha256");
  const meter = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } });
  const decompressor = createZstdDecompress();
  child.stdout.on("error", e => decompressor.destroy(e));
  meter.on("error", e => decompressor.destroy(e));
  child.stdout.pipe(meter).pipe(decompressor);
  const lines = createInterface({ input: decompressor, crlfDelay: Infinity });
  let failure: Error | undefined; decompressor.on("error", e => { failure = e; lines.close(); });
  const abort = () => { child.kill("SIGTERM"); decompressor.destroy(); lines.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  let row = 0;
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      if (row === 0) { if (line !== header) throw Error("unexpected_csv_header"); }
      else if (line) await visit(line, row);
      row++;
    }
    if (failure) throw failure;
    signal?.throwIfAborted();
    if (await exited !== 0) throw Error("zip_read_failed:" + errorText.slice(0, 160));
    const actual = hash.digest("hex");
    if (actual !== expectedHash.replace(/^sha256:/, "")) throw Error("compressed_hash_mismatch");
    return { rows: row - 1, sha256: actual };
  } finally {
    signal?.removeEventListener("abort", abort); lines.close(); decompressor.destroy();
    child.stdout.destroy(); meter.destroy(); if (child.exitCode === null) child.kill("SIGTERM");
    await exited.catch(() => {});
  }
}
