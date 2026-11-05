/** Independent bounded binary readback of every reconstructed column. */
import fs from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/research-v2/mbo-01");
const base = path.join(root, "rebuilt/GCZ26"), rows = [];
let invalid = 0;
for (const day of fs.readdirSync(base).filter(x => /^\d{4}-\d\d-\d\d$/.test(x)).sort()) {
  if (!fs.existsSync(path.join(base, day, "summary.json"))) throw Error("day_not_finished_" + day);
  for (const filename of fs.readdirSync(path.join(base, day)).filter(x => x.endsWith(".bin.gz")).sort()) {
    const file = path.join(base, day, filename), source = fs.createReadStream(file), unzip = createGunzip();
    const hash = createHash("sha256"); source.on("data", b => hash.update(b));
    source.on("error", e => unzip.destroy(e)); source.pipe(unzip);
    let previous = -1, count = 0, pending = Buffer.alloc(0), errors = 0;
    let firstSecond = null, lastSecond = null;
    try {
      for await (const chunk of unzip) {
        pending = Buffer.concat([pending, chunk]);
        let offset = 0;
        while (pending.length - offset >= 9) {
          const second = pending.readUInt32LE(offset), nb = pending.readUInt16LE(offset + 5);
          const na = pending.readUInt16LE(offset + 7), size = 9 + 8 * (nb + na);
          if (pending.length - offset < size) break;
          if (second <= previous || pending[offset + 4] !== 1 || nb > 400 || na > 400 || !nb || !na) errors++;
          const iso = new Date(second * 1000).toISOString();
          if (iso.slice(0, 10) !== day || iso.slice(11, 13) !== filename.slice(0, 2)) errors++;
          let bid = null, ask = null;
          for (let i = 0; i < nb + na; i++) {
            const price = pending.readInt32LE(offset + 9 + i * 8), quantity = pending.readUInt32LE(offset + 13 + i * 8);
            if (!quantity) errors++;
            if (i < nb) { if (bid !== null && price >= bid) errors++; bid = price; }
            else { if (ask !== null && price <= ask) errors++; ask = price; }
          }
          const bestBid = pending.readInt32LE(offset + 9), bestAsk = pending.readInt32LE(offset + 9 + 8 * nb);
          if (bestBid >= bestAsk) errors++;
          previous = second; firstSecond ??= second; lastSecond = second;
          count++; offset += size;
        }
        pending = Buffer.from(pending.subarray(offset));
      }
      if (pending.length) errors++;
    } finally { source.destroy(); unzip.destroy(); }
    invalid += errors;
    rows.push({ day, file: `${day}/${filename}`, seconds: count, firstSecond, lastSecond,
      invalid: errors, bytes: fs.statSync(file).size, sha256: hash.digest("hex") });
  }
  // Remove unverified optional diagnostics from early research output.
  // Binary columns, trades and immutable originals are never changed here.
  const summaryFile = path.join(base, day, "summary.json");
  const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
  delete summary.eventSeconds;
  delete summary.carriedStateSeconds;
  delete summary.eventCounterEvidence;
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
}
const version = createHash("sha256");
for (const row of rows) version.update(row.file + ":" + row.sha256 + "\n");
const report = { rows, invalid, seconds: rows.reduce((n, r) => n + r.seconds, 0),
  files: rows.length, compressedBytes: rows.reduce((n, r) => n + r.bytes, 0),
  outputContentHash: version.digest("hex"), maxRssKiB: process.resourceUsage().maxRSS };
fs.writeFileSync(path.join(root, "reconstruction-readback.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, rows: undefined }));
if (invalid) process.exitCode = 1;
