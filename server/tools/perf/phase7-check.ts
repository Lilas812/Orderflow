import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { browser, delay } from "./cdp.ts";
import { staticProxy } from "./static-proxy.ts";

const out = path.resolve(process.env.PHASE7_CHECK_OUT ?? "data/phase7");
await fs.mkdir(out, { recursive: true });
const status = async () => (await fetch("http://127.0.0.1:8080/api/status")).json();
const resume = process.argv.includes("--resume");
const evidence: any = resume ? JSON.parse(await fs.readFile(path.join(out, "browser-checks.json"), "utf8"))
  : { started: new Date().toISOString(), browsers: [], stages: [], statuses: [] };
const proxy = await staticProxy(path.resolve("artifacts/heatmap/dist/public"));
let active: Awaited<ReturnType<typeof browser>> | null = null;
const dump = () => fs.writeFile(path.join(out, "browser-checks.json"), JSON.stringify(evidence, null, 2));
async function wait(check: () => Promise<boolean>, label: string, milliseconds = 120000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await check()) return; await delay(250); }
  throw Error(`timeout:${label}`);
}
async function closeBrowser() {
  if (!active) return;
  evidence.browsers.push(await active.close()); active = null;
  await delay(300);
  const s = await status();
  evidence.statuses.push({ at: new Date().toISOString(), connections: s.phase2b.connections });
  assert.equal(s.phase2b.connections.filter((p: any) => p.userAgent?.includes(`NQPerf/${process.pid}`)).length, 0);
  await dump();
}
async function openPage(query: string) {
  active = await browser(9222);
  const page = await active.page("http://127.0.0.1:19090/?" + query + "&debug=1");
  const debug = () => page.cdp.evaluate("window.__heatmapDebug");
  await wait(async () => { const d = await debug(); return d?.traffic.initialComplete && !d.loadingRanges && d.vp.prices > 0; }, "initial_data");
  await delay(1300);
  return { page, debug };
}
async function shot(page: any, name: string) {
  const { data } = await page.cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
}
// Independent recount of unchanged gzip JSONL files, not the production VP code.
async function recount(start: number, end: number) {
  let buy = 0, sell = 0, count = 0;
  const levels = new Map<number, [number, number]>();
  for (let h = Math.floor(start / 3600) * 3600; h < end; h += 3600) {
    const date = new Date(h * 1000).toISOString();
    const file = path.resolve("data/trades/NQ", date.slice(0, 10), date.slice(11, 13) + ".jsonl.gz");
    try { await fs.access(file); } catch { continue; }
    const raw = createReadStream(file), input = raw.pipe(createGunzip());
    raw.on("error", e => input.destroy(e));
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) if (line) {
        const t = JSON.parse(line);
        if (t.tsUs < start * 1e6 || t.tsUs >= end * 1e6) continue;
        count++;
        if (t.side === "buy") buy += t.size; else sell += t.size;
        const pair = levels.get(t.price) ?? [0, 0];
        pair[t.side === "buy" ? 0 : 1] += t.size; levels.set(t.price, pair);
      }
    } finally { lines.close(); input.destroy(); raw.destroy(); }
  }
  return { start, end, count, buy, sell, total: buy + sell, prices: levels.size,
    levels: [...levels].sort(([a], [b]) => a - b).map(([p, [b, s]]) => [p, b, s]) };
}
async function probeLive() {
  const socket = new WebSocket("ws://127.0.0.1:8080/api/ws", { headers: { "User-Agent": `NQVpProbe/${process.pid}` } });
  const events: any[] = [], levels = new Map<number, number[]>();
  let summary: any = null;
  socket.on("message", (bytes, binary) => {
    if (binary) return;
    const m = JSON.parse(bytes.toString());
    if (m.type !== "vp" && m.type !== "vpUpdate") return;
    if (m.type === "vp") levels.clear();
    for (const row of m.levels) levels.set(row[0], row);
    const all = [...levels.values()];
    summary = { ...m, levels: all };
    events.push({ at: Date.now(), type: m.type, rows: m.levels.length, upToSec: m.upToSec,
      total: all.reduce((n, row) => n + row[1] + row[2], 0) });
  });
  try {
    await delay(6500);
    assert.ok(summary && summary.loading !== true);
    const updates = events.filter(e => e.type === "vpUpdate");
    assert.ok(updates.length >= 2, "live_vp_updates");
    for (let i = 1; i < updates.length; i++) assert.ok(updates[i].at - updates[i - 1].at >= 950);
    return { events, summary };
  } finally {
    socket.close();
    await new Promise<void>(resolve => { if (socket.readyState === 3) resolve(); else socket.once("close", () => resolve()); });
  }
}
try {
  const first = resume ? evidence.initial : await status();
  evidence.pid = first.memory.pid; evidence.initial = first;
  // Observe loading before leaving the browser closed during the long history job.
  if (!resume) {
    const initial = await openPage("mode=live");
    evidence.stages.push({ name: "loading", debug: await initial.debug() });
    await shot(initial.page, "loading-live");
    await closeBrowser();
    console.log("VP_CHECK loading screenshot captured; browser closed");
  }
  const deadline = Date.now() + Number(process.env.PHASE7_CHECK_TIMEOUT_MS ?? 60 * 60 * 1000);
  for (;;) {
    const s = await status();
    await fs.appendFile(path.join(out, "status-samples.jsonl"), JSON.stringify({ at: Date.now(), ...s }) + "\n");
    const vp = s.phase2a.vp;
    if (vp.state === "complete") { evidence.complete = s; break; }
    if (vp.state === "failed" || vp.state === "stopped") throw Error(`vp_${vp.state}:${vp.lastError}`);
    if (Date.now() > deadline) throw Error("vp_history_deadline");
    await delay(5000);
  }
  await fs.writeFile(path.join(out, "complete-status.json"), JSON.stringify(evidence.complete, null, 2));
  console.log("VP_CHECK history complete", evidence.complete.phase2a.vp);
  const live = await openPage("mode=live");
  await wait(async () => !(await live.debug()).vp.loading, "live_complete");
  await shot(live.page, "complete-live");
  evidence.stages.push({ name: "live", debug: await live.debug(), frames: await live.page.cdp.evaluate("window.__heatmapFrameStats") });
  await closeBrowser();
  evidence.probe = await probeLive();
  const from = first.phase2a.seamL - 600;
  const replay = await openPage(`mode=replay&from=${from}&speed=1`);
  await wait(async () => !(await replay.debug()).vp.loading, "replay_vp");
  await delay(1300);
  await shot(replay.page, "replay-one-times");
  const d = await replay.debug();
  evidence.stages.push({ name: "replay", debug: d, frames: await replay.page.cdp.evaluate("window.__heatmapFrameStats") });
  await closeBrowser();
  evidence.replayRecount = await recount(d.vp.sessionStartSec, d.vp.upToSec);
  assert.equal(evidence.replayRecount.total, d.vp.total, "replay_total_vs_files");
  assert.equal(evidence.replayRecount.prices, d.vp.prices, "replay_prices_vs_files");
  // Live exchange timestamps can be coarser than the publish cadence, and late
  // rows can have timestamps preceding an already published wall-clock head.
  // The definitive live/file comparison is made from storage_stopped after
  // SIGTERM, with ingestion frozen. A moving live timestamp prefix is not proof.
  evidence.liveComparisonPending = "Compare frozen storage_stopped profile to files after SIGTERM";
  evidence.success = true;
  console.log("VP_CHECK success", { replay: evidence.replayRecount.total });
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error("VP_CHECK error", evidence.error); process.exitCode = 1;
} finally {
  await closeBrowser();
  evidence.proxyClosed = await proxy.close();
  evidence.finished = new Date().toISOString(); await dump();
}
