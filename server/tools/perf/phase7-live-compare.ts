import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";
import assert from "node:assert/strict";
import WebSocket from "ws";

const output = process.env.PHASE7_COMPARISON_OUT ?? "data/phase7/live-sequence-comparison.json";
const initial = await (await fetch("http://127.0.0.1:8080/api/status")).json();
assert.equal(initial.phase2a.vp.profile.loading, false, "wait_for_vp_complete");
const L = initial.phase2a.seamL, levels = new Map<number, [number, number]>();
let liveSequence = -1, liveRecvUs = -1, snapshot: any = null, updates = 0, closeCode: number | null = null;
const ws = new WebSocket("ws://127.0.0.1:8080/api/ws?mode=live", { headers: { "user-agent": "NQ-VP-sequence-check" } });
ws.on("message", (bytes, binary) => {
  if (binary) return;
  const m = JSON.parse(bytes.toString());
  if (m.type === "trades" || m.type === "rangeTrades") {
    for (const t of m.trades) if (t.tsUs >= L * 1e6 && t.seq > liveSequence) {
      liveSequence = t.seq; liveRecvUs = t.recvUs;
    }
  }
  if (m.type === "vp" || m.type === "vpUpdate") {
    if (m.type === "vp") levels.clear(); else updates++;
    for (const [p, b, s] of m.levels) levels.set(p, [b, s]);
    // hub.flush emits its live trade batch before VP, in the same event-loop turn.
    snapshot = { ...m, type: "vp", lastLiveSequence: liveSequence, cutoffRecvUs: liveRecvUs,
      levels: [...levels].sort(([a], [b]) => a - b).map(([p, [b, s]]) => [p, b, s]) };
  }
});
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => ws.close(1000, "verification complete"), 8000);
  const timeout = setTimeout(() => ws.terminate(), 12000);
  ws.once("error", reject);
  ws.once("close", code => { clearTimeout(timer); clearTimeout(timeout); closeCode = code; resolve(); });
});
assert.ok(snapshot && snapshot.lastLiveSequence >= 0);
assert.equal(closeCode, 1000);
await fs.writeFile(output, JSON.stringify({ L, snapshot, updates, closeCode, pending: true }, null, 2));
console.log("VP_SEQUENCE_CAPTURE", { L, prices: snapshot.levels.length, updates, closeCode, seq: snapshot.lastLiveSequence });
// Wait for the receiver to be explicitly stopped by the agent; it flushes files.
const pid = initial.memory.pid;
for (;;) {
  try { await fs.access(`/proc/${pid}`); } catch { break; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
const actual = new Map<number, [number, number]>();
const gaps = initial.phase2a.vp.gaps;
let count = 0;
for (let h = Math.floor(snapshot.sessionStartSec / 3600) * 3600; h < snapshot.upToSec; h += 3600) {
  const date = new Date(h * 1000).toISOString();
  const file = path.resolve("data/trades/NQ", date.slice(0, 10), date.slice(11, 13) + ".jsonl.gz");
  try { await fs.access(file); } catch { continue; }
  const raw = createReadStream(file), inflated = raw.pipe(createGunzip());
  raw.on("error", error => inflated.destroy(error));
  const lines = createInterface({ input: inflated, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line) {
      const t = JSON.parse(line);
      if (t.tsUs < snapshot.sessionStartSec * 1e6) continue;
      if (gaps.some((g: any) => t.tsUs >= g.startSec * 1e6 && t.tsUs < g.endSec * 1e6)) continue;
      // Receive-time cutoff, with seq breaking ties within a millisecond. Using
      // exchange-time upToSec alone would incorrectly exclude late/rolled-back rows.
      if (t.tsUs >= L * 1e6 && (t.recvUs > snapshot.cutoffRecvUs
        || (t.recvUs === snapshot.cutoffRecvUs && t.seq > snapshot.lastLiveSequence))) continue;
      const v = actual.get(t.price) ?? [0, 0]; v[t.side === "buy" ? 0 : 1] += t.size;
      actual.set(t.price, v); count++;
    }
  } finally { lines.close(); inflated.destroy(); raw.destroy(); }
}
const recounted = [...actual].sort(([a], [b]) => a - b).map(([p, [b, s]]) => [p, b, s]);
const matches = JSON.stringify(recounted) === JSON.stringify(snapshot.levels);
await fs.writeFile(output, JSON.stringify({ L, snapshot, updates, closeCode, pending: false,
  matches, count, recounted }, null, 2));
assert.deepEqual(recounted, snapshot.levels, "all live price/buy/sell totals at the transmitted sequence boundary");
console.log("VP_SEQUENCE_MATCH", { prices: actual.size, count, total: recounted.reduce((n, [, b, s]) => n + b + s, 0) });
