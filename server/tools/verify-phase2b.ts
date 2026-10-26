import * as fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { decodeFrame } from "../src/hub/frame.ts";
import { runClient } from "./ws-client.ts";

const root = "data/phase2b-checks";
await fs.mkdir(root, { recursive: true });
const save = (name: string, value: unknown) => fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2));
const status = async () => {
  const response = await fetch("http://localhost/api/status");
  assert.equal(response.status, 200); return response.json();
};
async function receiverPid() {
  const matches: number[] = [];
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = (await fs.readFile(`/proc/${name}/cmdline`, "utf8")).split("\0");
      if (cmd[1] === "src/index.ts" && (await fs.readlink(`/proc/${name}/cwd`)).endsWith("/server")) matches.push(Number(name));
    } catch {}
  }
  assert.equal(matches.length, 1, "one receiver process required"); return matches[0];
}
async function queryRange(fromSec: number, toSec: number) {
  const ws = new WebSocket("ws://localhost/api/ws"); ws.binaryType = "arraybuffer";
  const columns: number[] = []; let trades = 0;
  return new Promise<{ columns: number[]; trades: number }>((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(Error("audit_timeout")); }, 60000);
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(Error("audit_ws_error")); });
    ws.addEventListener("message", event => {
      try {
        if (typeof event.data === "string") {
          const msg = JSON.parse(event.data);
          if (msg.type === "rangeTrades" && msg.reqId === 0) ws.send(JSON.stringify({ op: "range", reqId: 8, fromSec, toSec }));
          else if (msg.type === "rangeTrades" && msg.reqId === 8) {
            trades = msg.trades.length; clearTimeout(timeout); ws.close(1000, "audit_complete"); resolve({ columns, trades });
          } else if (msg.type === "error") throw Error("audit_server_error");
        } else {
          const frame = decodeFrame(Buffer.from(event.data as ArrayBuffer));
          if (frame.kind === 2 && frame.reqId === 8) columns.push(...frame.columns.map(c => c.tsSec));
        }
      } catch (error) { clearTimeout(timeout); ws.close(); reject(error); }
    });
  });
}
const pid = await receiverPid();
let stoppedAtUs: number | null = null;
try {
  const start = await status(); await save("status-start.json", start);
  process.stdout.write(JSON.stringify({ event: "verification_waiting", pid, startedAtUs: Date.now() * 1000 }) + "\n");
  const deadline = Date.now() + 15 * 60000;
  let ready;
  for (;;) {
    const snapshot = await status();
    await save(`status-${Date.now()}.json`, snapshot);
    const s = snapshot.phase2a;
    process.stdout.write(JSON.stringify({ event: "progress", atUs: Date.now() * 1000,
      state: s.backfill.state, windows: s.backfill.completedWindows, maturity: s.backfill.pendingMaturity.length,
      empty: s.backfill.pendingEmpty.length, books: snapshot.counts.acceptedBook }) + "\n");
    if (s.backfill.state === "failed") throw Error("backfill_failed");
    if (s.backfill.state === "complete") { ready = snapshot; break; }
    if (Date.now() > deadline) throw Error("backfill_deadline");
    await wait(10000);
  }
  await save("status-ready.json", ready);
  assert.ok(ready.counts.acceptedBook > 0 && ready.counts.acceptedTrade > 0, "market data received");
  const L = ready.phase2a.seamL, before = await status();
  const clients = [
    runClient({ seconds: 120, range: { fromSec: L - 1200, toSec: L - 600 } }).then(async r => { await save("live-a.json", r); return r; }),
    runClient({ seconds: 120 }).then(async r => { await save("live-b.json", r); return r; }),
  ];
  await wait(500);
  const replayEnd = ready.phase2a.storage.latestColumnSec + 1;
  const replay = await runClient({ mode: "replay", from: replayEnd - 300, speed: 10, seconds: 70, untilEnd: true });
  await save("replay.json", replay);
  const afterReplay = await status(); await save("status-after-replay.json", afterReplay);
  assert.ok(afterReplay.counts.acceptedBook > before.counts.acceptedBook);
  const [a, b] = await Promise.all(clients);
  for (const result of [a, b, replay]) {
    assert.deepEqual(result.errors, []); assert.deepEqual(result.violations, []);
  }
  assert.equal(replay.replayEnded, true);
  assert.ok(a.elapsedMs as number >= 120000 && b.elapsedMs as number >= 120000);
  const ac = a.columns as { sec: number; digest: string }[], bc = b.columns as typeof ac;
  const map = new Map(bc.map(c => [c.sec, c.digest]));
  const common = ac.filter(c => map.has(c.sec));
  assert.ok(common.length >= 110, "at least 110 common seconds");
  assert.ok(common.every(c => map.get(c.sec) === c.digest));
  assert.ok(Number((a.range as any)?.columns) > 0 && Number((a.range as any)?.trades) > 0);
  const seam = await queryRange(L - 300, L + 300), existing = new Set(seam.columns);
  const missingBefore = Array.from({ length: 300 }, (_, i) => L - 300 + i).filter(s => !existing.has(s));
  const missingAfter = Array.from({ length: 300 }, (_, i) => L + i).filter(s => !existing.has(s));
  const final = await status(); await save("status-final.json", final);
  const report = {
    L, seam: { fromSec: L - 300, toSec: L + 300, columns: seam.columns.length, trades: seam.trades,
      missingBefore, missingAfter }, twoClients: {
      a: ac.length, b: bc.length, common: common.length, identical: true,
      onlyA: ac.filter(c => !map.has(c.sec)).map(c => c.sec),
      onlyB: bc.filter(c => !ac.some(x => x.sec === c.sec)).map(c => c.sec),
    }, replay: { requestedFromSec: replayEnd - 300, requestedSavedEndSec: replayEnd,
      actualHello: replay.hello, liveBooksDuring: afterReplay.counts.acceptedBook - before.counts.acceptedBook,
      liveTradesDuring: afterReplay.counts.acceptedTrade - before.counts.acceptedTrade },
  };
  await save("verification.json", report);
  process.stdout.write(JSON.stringify({ event: "verification_complete", ...report }) + "\n");
} finally {
  stoppedAtUs = Date.now() * 1000;
  await save("shutdown.json", { pid, stoppedAtUs, signal: "SIGTERM" });
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    try { await fs.access(`/proc/${pid}`); } catch {
      await save("shutdown.json", { pid, stoppedAtUs, signal: "SIGTERM", exitedAtUs: Date.now() * 1000 });
      process.stdout.write(JSON.stringify({ event: "receiver_exit_confirmed", pid }) + "\n"); break;
    }
    await wait(100);
  }
}
