/** Read only purchased DBN; write NEW private diagnostics, never existing reconstructed boards. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanDbn, mbo, OrderBook } from "./mbo_dbn.mjs";
import { ColumnAggregator } from "../server/src/aggregate/columns.ts";
const root = path.resolve("data/research-v2/mbo-01"), day = "2026-11-03";
const dir = path.join(root, "board-diagnostics"); fs.mkdirSync(dir, { recursive: true });
if (os.getPriority() < 19) throw Error("run_with_nice_-n_19");
const verified = JSON.parse(fs.readFileSync(path.join(root, "download-verification.json")));
const input = verified.files.find(x => x.filename.includes("20261103.mbo.dbn.zst"));
if (verified.status !== "verified" || !input) throw Error("verified_input_missing");
const from = Date.parse(day + "T13:00:00Z") / 1000, to = Date.parse("2026-11-04") / 1000;
const book = new OrderBook(), rows = { eventLast: [], eventFirst: [], receiveLast: [] };
function clock(name, firstName) {
  let second = null, lastUs = null, completed = false, firstDone = false;
  const agg = new ColumnAggregator(c => {
    if (c.tsSec >= from && c.tsSec < to)
      rows[name].push([c.tsSec, c.bids[0].price, c.asks[0].price]);
  });
  function snapshot(sec) {
    const c = book.column(sec);
    return c && !c.crossed && c.bids.length && c.asks.length ? c : null;
  }
  function flush() {
    if (second === null || !completed) return;
    const c = snapshot(second);
    if (c) agg.accept({ tsUs: lastUs, recvUs: lastUs, source: "history",
      bids: [c.bids[0]], asks: [c.asks[0]] });
  }
  return {
    before(us) {
      const sec = Math.floor(us / 1e6);
      if (second === null || sec > second) {
        flush(); second = sec; lastUs = null; completed = false; firstDone = false;
      }
    },
    after(us, last) {
      if (!last || Math.floor(us / 1e6) !== second) return;
      completed = true; lastUs = Math.max(lastUs ?? us, us);
      if (firstName && !firstDone) {
        const c = snapshot(second);
        if (c && second >= from && second < to) rows[firstName].push([second, c.bids[0].price, c.asks[0].price]);
        firstDone = true;
      }
    },
    finish() { flush(); agg.finish(); },
  };
}
const eventClock = clock("eventLast", "eventFirst"), recvClock = clock("receiveLast");
let id, selected = 0;
const started = performance.now();
const decoded = await scanDbn(path.join(root, "raw", input.filename), meta => {
  const ids = meta.mappings.filter(m => m.raw === "GCZ6")
    .flatMap(m => m.intervals.filter(i => i.from <= 20261103 && i.to > 20261103).map(i => +i.symbol));
  if (ids.length !== 1) throw Error("ambiguous_instrument"); id = ids[0];
}, record => {
  if (record.readUInt32LE(4) !== id) return;
  selected++;
  const e = mbo(record), snapshot = !!(e.flags & 32);
  const eventUs = Number((snapshot ? e.tsRecv : e.tsEvent) / 1000n);
  const recvUs = Number(e.tsRecv / 1000n);
  eventClock.before(eventUs); recvClock.before(recvUs);
  book.apply(e);
  eventClock.after(eventUs, !!(e.flags & 128)); recvClock.after(recvUs, !!(e.flags & 128));
});
eventClock.finish(); recvClock.finish();
if (decoded.compressedSha256 !== input.sha256) throw Error("raw_input_hash_mismatch");
const report = { day, contract: "GCZ26", rawContract: "GCZ6", inputSha256: input.sha256, instrumentId: id,
  selected, elapsedMs: performance.now() - started, rows,
  note: "BBO only. Actual ColumnAggregator, observed F_LAST seconds only; downstream must intersect original quality-masked MBO seconds. No reconstruction output overwritten." };
fs.writeFileSync(path.join(dir, "sampling.json"), JSON.stringify(report));
console.log(JSON.stringify({ selected, elapsedMs: report.elapsedMs, counts: Object.fromEntries(Object.entries(rows).map(([k,v]) => [k,v.length])) }));
