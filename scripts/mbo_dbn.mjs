import { createReadStream } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { createHash } from "node:crypto";

/** DBN v2/v3 metadata, per the published little-endian specification. */
export function metadata(bytes) {
  if (bytes.toString("ascii", 0, 3) !== "DBN" || ![2, 3].includes(bytes[3])) throw Error("unsupported_dbn_version");
  const end = 8 + bytes.readUInt32LE(4);
  if (bytes.length < end || end > 16 * 1024 * 1024) throw Error("invalid_dbn_metadata_length");
  const cstr = (offset, size) => bytes.subarray(offset, offset + size).toString("utf8").split("\0")[0];
  const symbolLength = bytes.readUInt16LE(53);
  if (symbolLength < 2 || symbolLength > 1024 || bytes[52]) throw Error("unsupported_dbn_symbol_length_or_ts_out");
  let pos = 108;
  const u32 = () => { if (pos + 4 > end) throw Error("short_dbn_metadata"); const n = bytes.readUInt32LE(pos); pos += 4; return n; };
  const text = () => { if (pos + symbolLength > end) throw Error("short_dbn_symbol"); const s = cstr(pos, symbolLength); pos += symbolLength; return s; };
  const definitionLength = u32(); pos += definitionLength;
  const strings = () => Array.from({ length: u32() }, text);
  const symbols = strings(), partial = strings(), notFound = strings();
  const mappings = [];
  const count = u32();
  if (count > 100000) throw Error("excessive_dbn_mappings");
  for (let i = 0; i < count; i++) {
    const raw = text(), intervals = [];
    const n = u32();
    for (let j = 0; j < n; j++) intervals.push({ from: u32(), to: u32(), symbol: text() });
    mappings.push({ raw, intervals });
  }
  if (pos > end || end - pos > 7 || bytes.subarray(pos, end).some(x => x !== 0)) throw Error("invalid_dbn_metadata_padding");
  return { version: bytes[3], end, dataset: cstr(8, 16), schema: bytes.readUInt16LE(24),
    startNs: bytes.readBigUInt64LE(26).toString(), endNs: bytes.readBigUInt64LE(34).toString(),
    symbols, partial, notFound, mappings };
}

/** Bounded streaming parser. Records are visited synchronously, in file order. */
export async function scanDbn(path, onMetadata, onRecord) {
  const raw = createReadStream(path), decoder = createZstdDecompress();
  const hash = createHash("sha256");
  raw.on("data", chunk => hash.update(chunk));
  raw.on("error", e => decoder.destroy(e));
  raw.pipe(decoder);
  let pending = Buffer.alloc(0), parsed = false, records = 0, decodedBytes = 0;
  try {
    for await (const chunk of decoder) {
      decodedBytes += chunk.length;
      pending = Buffer.concat([pending, chunk]);
      if (!parsed) {
        if (pending.length < 8) continue;
        const size = 8 + pending.readUInt32LE(4);
        if (size > 16 * 1024 * 1024) throw Error("metadata_memory_limit");
        if (pending.length < size) continue;
        onMetadata(metadata(pending.subarray(0, size)));
        pending = pending.subarray(size); parsed = true;
      }
      let offset = 0;
      while (offset < pending.length) {
        const length = pending[offset] * 4;
        if (length < 16) throw Error("invalid_dbn_record_length");
        if (offset + length > pending.length) break;
        onRecord(pending.subarray(offset, offset + length));
        records++; offset += length;
      }
      pending = Buffer.from(pending.subarray(offset));
      if (process.memoryUsage().rss > 768 * 1024 * 1024) throw Error("research_rss_limit_768MiB");
    }
    if (!parsed || pending.length) throw Error("incomplete_dbn_file");
    return { records, decodedBytes, compressedSha256: hash.digest("hex") };
  } finally { raw.destroy(); decoder.destroy(); }
}

export function mbo(record) {
  if (record[1] !== 160 || record.length !== 56) throw Error("not_dbn_mbo_56");
  const nsPrice = record.readBigInt64LE(24);
  return { instrumentId: record.readUInt32LE(4), tsEvent: record.readBigUInt64LE(8),
    orderId: record.readBigUInt64LE(16), nsPrice, size: record.readUInt32LE(32),
    flags: record[36], channel: record[37], action: String.fromCharCode(record[38]),
    side: String.fromCharCode(record[39]), tsRecv: record.readBigUInt64LE(40),
    sequence: record.readUInt32LE(52) };
}

/** T/F never subtract resting orders on GLBX.MDP3: explicit C/M does that. */
export class OrderBook {
  orders = new Map();
  bids = new Map();
  asks = new Map();
  initialized = false;
  valid = false;
  errors = {};
  resets = 0;
  negative = 0;
  bump(reason) { this.errors[reason] = (this.errors[reason] ?? 0) + 1; this.valid = false; }
  level(side, price, change) {
    const levels = side === "B" ? this.bids : this.asks;
    const quantity = (levels.get(price) ?? 0) + change;
    if (quantity < 0 || !Number.isSafeInteger(quantity)) { this.negative++; this.bump("negative_or_unsafe_quantity"); }
    if (quantity === 0) levels.delete(price); else levels.set(price, quantity);
  }
  apply(event, tickNs = 100000000n) {
    const { action, side, size, orderId } = event;
    if (event.flags & 4) this.bump("provider_maybe_bad_book");
    if (event.flags & (16 | 64)) { this.bump("not_individual_order_record"); return; }
    if (action === "R") {
      this.orders.clear(); this.bids.clear(); this.asks.clear(); this.resets++;
      this.initialized = true; this.valid = !(event.flags & 4); return;
    }
    if (["T", "F", "N"].includes(action)) return;
    if (!["A", "C", "M"].includes(action)) { this.bump("unknown_action"); return; }
    if (!this.initialized) return;
    const old = this.orders.get(orderId);
    if (action === "C") {
      if (!old) { this.bump("cancel_unknown_order"); return; }
      if (size > old.size) { this.bump("cancel_exceeds_size"); return; }
      this.level(old.side, old.price, -size);
      old.size -= size;
      if (!old.size) this.orders.delete(orderId);
      return;
    }
    if (!["A", "B"].includes(side) || event.nsPrice % tickNs !== 0n) { this.bump("side_or_off_tick"); return; }
    const price = Number(event.nsPrice / tickNs);
    if (!Number.isSafeInteger(price) || size === 0) { this.bump("invalid_price_or_size"); return; }
    if (action === "A" && old) this.bump("duplicate_add");
    if (action === "M" && !old) this.bump("modify_unknown_order");
    if (old) this.level(old.side, old.price, -old.size);
    this.orders.set(orderId, { side, price, size });
    this.level(side, price, size);
  }
  column(tsSec) {
    if (!this.initialized || !this.valid || !this.bids.size || !this.asks.size) return null;
    const bid = Math.max(...this.bids.keys()), ask = Math.min(...this.asks.keys());
    if (bid >= ask) return { crossed: true, bid, ask };
    const mid = Math.floor((bid + ask) / 2), bids = [], asks = [];
    for (let p = mid; p >= mid - 399; p--) {
      const size = this.bids.get(p); if (size) bids.push({ price: p, size });
    }
    for (let p = mid + 1; p <= mid + 400; p++) {
      const size = this.asks.get(p); if (size) asks.push({ price: p, size });
    }
    return { tsSec, source: "history", bids, asks };
  }
}
