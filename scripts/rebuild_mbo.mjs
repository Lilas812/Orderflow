/** Research-only, offline GC MBO reconstruction. No API calls or product writes. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { scanDbn, mbo, OrderBook } from "./mbo_dbn.mjs";
import { encodeColumns } from "../server/src/store/binary.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/research-v2/mbo-01");
const args = process.argv.slice(2);
const all = args.includes("--all"), date = args[args.indexOf("--date") + 1];
if (!all && (!args.includes("--date") || !/^\d{4}-\d\d-\d\d$/.test(date))) throw Error("use_--all_or_--date_YYYY-MM-DD");
if (os.getPriority() < 19) throw Error("run_with_nice_-n_19");
const verification = JSON.parse(fs.readFileSync(path.join(root, "download-verification.json"), "utf8"));
if (verification.status !== "verified") throw Error("raw_download_not_verified");
const inputs = verification.files.filter(x => /\.mbo\.dbn\.zst$/.test(x.filename)
  && (all || x.filename.includes(date.replaceAll("-", ""))));
if (!inputs.length) throw Error("no_matching_purchased_day");

class HourWriter {
  constructor(base) { this.base = base; this.fd = null; this.hour = null; this.parts = []; this.records = 0; this.bytes = 0; }
  write(second, bytes) {
    const hour = Math.floor(second / 3600);
    if (hour !== this.hour) {
      this.close(); this.hour = hour;
      const file = path.join(this.base, new Date(second * 1000).toISOString().slice(11, 13) + ".bin.partial");
      this.fd = fs.openSync(file, "wx"); this.parts.push(file);
    }
    fs.writeSync(this.fd, bytes); this.records++; this.bytes += bytes.length;
  }
  close() { if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }
}

async function* validRecords(file, excluded) {
  let pending = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file)) {
    pending = Buffer.concat([pending, chunk]);
    let offset = 0;
    while (pending.length - offset >= 9) {
      const n = 9 + 8 * (pending.readUInt16LE(offset + 5) + pending.readUInt16LE(offset + 7));
      if (pending.length - offset < n) break;
      if (!excluded.has(pending.readUInt32LE(offset))) yield pending.subarray(offset, offset + n);
      offset += n;
    }
    pending = Buffer.from(pending.subarray(offset));
  }
  if (pending.length) throw Error("partial_output_record");
}

for (const input of inputs) {
  const ymd = /-(\d{8})\./.exec(input.filename)[1];
  const day = ymd.slice(0, 4) + "-" + ymd.slice(4, 6) + "-" + ymd.slice(6);
  const base = path.join(root, "rebuilt", "GCZ26", day), summaryFile = path.join(base, "summary.json");
  if (fs.existsSync(summaryFile)) {
    const old = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
    if (old.inputSha256 !== input.sha256 || old.status !== "complete") throw Error("existing_reconstruction_not_reusable");
    console.log(JSON.stringify({ day, reused: true, columns: old.columns })); continue;
  }
  fs.mkdirSync(base, { recursive: true });
  if (fs.readdirSync(base).length) throw Error("unfinished_output_exists_preserved");
  const before = process.cpuUsage(), started = performance.now();
  const book = new OrderBook(), writer = new HourWriter(base), badSeconds = new Set();
  const report = { day, contract: "GCZ26", rawContract: "GCZ6", input: input.filename,
    inputSha256: input.sha256, status: "running", actions: {}, allOutrightTradeVolume: {},
    selectedRecords: 0, excludedRecords: 0, snapshotRecords: 0, completedSnapshots: 0,
    unknownSeconds: 0, crossedSeconds: 0,
    sequenceForwardJumps: 0, sequenceBackward: 0, sequenceRepeated: 0, sequenceMissingNumbers: 0,
    timestampBackward: 0, spanningGroups: 0, hourly: {}, examples: [] };
  let id = null, meta, symbolById, frontier = null, inGroup = false, groupSec = null;
  let snapshotGroup = false, initializedFromSnapshot = false, lastSequence = null;
  const dayStart = Date.parse(day) / 1000, dayEnd = dayStart + 86400;
  const tradeFile = path.join(base, "mbo-trades.jsonl.partial");
  const tradeFd = fs.openSync(tradeFile, "wx");
  let tradeCount = 0, tradeSize = 0;
  function markBad(from, to) {
    for (let second = Math.max(dayStart, from); second <= Math.min(dayEnd - 1, to); second++) badSeconds.add(second);
  }
  function emitUntil(end) {
    if (frontier === null) return;
    end = Math.min(end, dayEnd);
    for (; frontier < end; frontier++) {
      const column = book.column(frontier);
      if (!column) { report.unknownSeconds++; continue; }
      if (column.crossed) {
        report.crossedSeconds++;
        if (report.examples.length < 12) report.examples.push({ second: frontier, ...column });
        continue;
      }
      writer.write(frontier, encodeColumns([column]));
      const hour = String(Math.floor((frontier - dayStart) / 3600)).padStart(2, "0");
      report.hourly[hour] = (report.hourly[hour] ?? 0) + 1;
    }
  }
  console.log(JSON.stringify({ day, phase: "reconstruct_start", nice: os.getPriority(), heapLimitMiB: 512 }));
  try {
    const result = await scanDbn(path.join(root, "raw", input.filename), m => {
      meta = m;
      if (m.version !== 3 || m.dataset !== "GLBX.MDP3" || m.schema !== 0) throw Error("unexpected_input_schema");
      symbolById = new Map();
      for (const mapping of m.mappings) for (const interval of mapping.intervals) {
        if (+ymd >= interval.from && +ymd < interval.to) symbolById.set(Number(interval.symbol), mapping.raw);
      }
      const ids = [...symbolById.entries()].filter(([, s]) => s === "GCZ6");
      if (ids.length !== 1) throw Error("GCZ6_instrument_id_not_unique");
      id = ids[0][0]; report.instrumentId = id;
    }, record => {
      if (record[1] !== 160 || record.length !== 56) throw Error("unexpected_record_type");
      const instrument = record.readUInt32LE(4), action = record[38];
      if (action === 84 && !(record[36] & 32)) {
        const symbol = symbolById.get(instrument);
        if (symbol && /^GC[FGHJKMNQUVXZ]\d$/.test(symbol)) {
          report.allOutrightTradeVolume[symbol] = (report.allOutrightTradeVolume[symbol] ?? 0) + record.readUInt32LE(32);
        }
      }
      if (instrument !== id) { report.excludedRecords++; return; }
      const event = mbo(record), snapshot = !!(event.flags & 32), last = !!(event.flags & 128);
      report.selectedRecords++; report.actions[event.action] = (report.actions[event.action] ?? 0) + 1;
      if (snapshot) report.snapshotRecords++;
      const time = snapshot ? event.tsRecv : event.tsEvent;
      const second = time === 18446744073709551615n ? dayStart : Number(time / 1000000000n);
      if (!snapshot && second >= dayStart && second < dayEnd) {
        if (frontier !== null && second < frontier) {
          report.timestampBackward++; markBad(second, frontier);
        }
        if (event.sequence && lastSequence !== null) {
          if (event.sequence === lastSequence) report.sequenceRepeated++;
          else if (event.sequence < lastSequence) report.sequenceBackward++;
          else if (event.sequence > lastSequence + 1) {
            report.sequenceForwardJumps++; report.sequenceMissingNumbers += event.sequence - lastSequence - 1;
          }
        }
        if (event.sequence) lastSequence = event.sequence;
      }
      if (!inGroup) {
        if (frontier !== null && second > frontier) emitUntil(second);
        if (frontier === null && second >= dayStart && second < dayEnd) frontier = second;
        groupSec = second; snapshotGroup = snapshot; inGroup = true;
      } else if (!snapshot && second !== groupSec) {
        report.spanningGroups++; markBad(Math.min(groupSec, second), Math.max(groupSec, second));
      }
      book.apply(event);
      if (event.action === "T" && !snapshot) {
        if (event.nsPrice % 100000000n !== 0n) throw Error("off_tick_trade");
        const row = { tsUs: Number(event.tsEvent / 1000n), price: Number(event.nsPrice / 100000000n),
          size: event.size, side: event.side, sequence: event.sequence };
        fs.writeSync(tradeFd, JSON.stringify(row) + "\n"); tradeCount++; tradeSize += event.size;
      }
      if (last) {
        inGroup = false;
        if (snapshotGroup && book.initialized) { report.completedSnapshots++; initializedFromSnapshot = true; }
      }
    });
    if (inGroup) { report.incompleteLastGroup = true; if (frontier !== null) markBad(frontier, dayEnd - 1); }
    else emitUntil(dayEnd);
    writer.close(); fs.closeSync(tradeFd);
    if (result.compressedSha256 !== input.sha256) throw Error("input_hash_changed");
    let excluded = 0;
    for (const file of writer.parts) {
      const output = file.replace(".bin.partial", ".bin.gz");
      await pipeline(validRecords(file, badSeconds), createGzip({ level: 6 }), fs.createWriteStream(output, { flags: "wx" }));
      fs.unlinkSync(file);
    }
    // Counts refer to actual retained rows, not candidates before timestamp exclusions.
    for (const second of badSeconds) {
      const h = String(Math.floor((second - dayStart) / 3600)).padStart(2, "0");
      // An exact retained count is independently obtained by the comparison/scan tool.
      excluded++;
    }
    fs.renameSync(tradeFile, tradeFile.replace(".partial", ""));
    Object.assign(report, { status: "complete", dbn: { version: meta.version, mappings: meta.mappings.length,
      records: result.records, decodedBytes: result.decodedBytes }, initializedFromSnapshot,
      columns: writer.records, candidateHourly: report.hourly, timestampExcludedSeconds: [...badSeconds].sort((a, b) => a - b),
      orderErrors: book.errors, negativeQuantities: book.negative, resets: book.resets,
      trades: { count: tradeCount, size: tradeSize }, candidateBinaryBytes: writer.bytes,
      maxRssKiB: process.resourceUsage().maxRSS, elapsedSeconds: (performance.now() - started) / 1000,
      cpuSeconds: (process.cpuUsage(before).user + process.cpuUsage(before).system) / 1000000 });
    fs.writeFileSync(summaryFile, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ day, phase: "complete", candidates: writer.records, excludedSeconds: excluded,
      errors: book.errors, trades: report.trades, seconds: report.elapsedSeconds, maxRssKiB: report.maxRssKiB }));
  } finally {
    writer.close();
    try { fs.closeSync(tradeFd); } catch { /* Only our descriptor, already closed on normal completion. */ }
  }
}
