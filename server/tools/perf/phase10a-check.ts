import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import path from "node:path";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { browser, delay } from "./cdp.ts";
import { processStart } from "../../src/diagnostics/isolation.ts";
import { ReplitObjects, digest } from "../../src/store/objects.ts";
import { tradeFileRows } from "../../src/store/records.ts";
import { defaults } from "../../src/settings/schema.ts";

const out = path.resolve("data/phase10a"), work = path.join(out, "working");
const marker = path.resolve("data/perf-memory/isolation.json"), objects = new ReplitObjects();
const result: any = { startedAt: new Date().toISOString(), browserClosures: [], cacheDeleted: [], partialDeleted: [] };
const browsers: Awaited<ReturnType<typeof browser>>[] = [];
let serverPid = 0, spawned: ReturnType<typeof spawn> | undefined;
const save = () => fs.writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2));
const status = async () => {
  const response = await fetch("http://127.0.0.1:8080/api/status", { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); return response.json();
};
async function sample(label: string) {
  const s = await status(); serverPid = s.memory.pid;
  const stat = (await fs.readFile(`/proc/${serverPid}/stat`, "utf8")).split(") ").at(-1)!.split(" ");
  await fs.appendFile(path.join(out, "samples.jsonl"), JSON.stringify({
    label, at: Date.now(), cpuTotalSeconds: (Number(stat[11]) + Number(stat[12])) / 100, ...s }) + "\n");
  return s;
}
async function until(test: () => Promise<boolean>, label: string, maxMs = 45 * 60000) {
  const until = Date.now() + maxMs;
  for (;;) { if (await test()) return; assert.ok(Date.now() < until, `timeout:${label}`); await delay(5000); }
}
async function complete(label: string) {
  await until(async () => {
    const s = await sample(label);
    assert.notEqual(s.phase2a.vp.state, "failed");
    return s.phase2a.backfill.state === "complete" && s.phase2a.vp.state === "complete"
      && !s.phase2a.storage.appStorage.uploading && !s.phase2a.storage.appStorage.pending.length;
  }, label);
}
async function stop() {
  if (!serverPid) return;
  try { process.kill(serverPid, "SIGTERM"); } catch {}
  await until(async () => { try { await fs.access(`/proc/${serverPid}`); return false; } catch { return true; } }, "server_stop", 120000);
  result.stops ??= []; result.stops.push({ pid: serverPid, exited: true, at: new Date().toISOString() });
  serverPid = 0;
}
async function externalProbe() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:8080/api/ws?mode=live", {
      headers: { origin: "https://phase10a-release-check.invalid", "user-agent": "NQ-phase10a-admission-proof" } });
    const timer = setTimeout(() => { ws.terminate(); reject(Error("external_probe_timeout")); }, 10000);
    let hello = false;
    ws.on("message", (b, binary) => { if (!binary && JSON.parse(b.toString()).type === "hello") { hello = true; ws.close(1000); } });
    ws.once("error", reject); ws.once("close", code => { clearTimeout(timer); resolve({ hello, closeCode: code }); });
  });
}

// Real HTTP reverse proxy, not a synthetic CDP document; all production bytes
// come from the receiver's one HTTP port. Only the labelled load fixture is local.
const sockets = new Set<Socket>();
const proxy = createServer((req, res) => {
  if (req.url === "/__phase10a-load") {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><meta charset=utf-8><title>Phase10a 実データ範囲負荷</title><p>実データ／測定専用。ダミーの板・約定は使用しない。</p>"); return;
  }
  const upstream = httpRequest({ hostname: "127.0.0.1", port: 8080, method: req.method, path: req.url,
    headers: req.headers }, reply => { res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res); });
  upstream.on("error", () => { res.statusCode = 502; res.end(); }); req.pipe(upstream);
});
proxy.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
proxy.on("upgrade", (req, socket, head) => {
  const target = connect(8080, "127.0.0.1"); sockets.add(target);
  target.on("close", () => { sockets.delete(target); socket.destroy(); });
  target.on("error", () => socket.destroy()); socket.on("error", () => target.destroy()); socket.on("close", () => target.destroy());
  target.on("connect", () => {
    let headers = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    target.write(headers + "\r\n"); if (head.length) target.write(head); socket.pipe(target).pipe(socket);
  });
});
try {
  await fs.mkdir(out, { recursive: true });
  result.first = await sample("first-startup"); await save();
  await complete("first-startup");
  result.firstComplete = await status();
  await objects.download("dev/coverage.json", path.join(out, "cloud-coverage-before-restart.json"));
  result.objectsBeforeRestart = await objects.list("dev/");
  assert.ok(result.objectsBeforeRestart.some((n: string) => n.includes("/19.bin.gz")));
  console.log("PHASE10A_HOUR_BOUNDARY_VERIFIED");
  await stop();
  // Only this task's disposable working cache is removed. Cloud objects stay.
  const current = new Date().toISOString(), day = current.slice(0, 10), hour = current.slice(11, 13);
  for (const name of result.objectsBeforeRestart.filter((n: string) => /\/(?:columns|trades)\//.test(n))) {
    const file = path.join(work, name.slice(4));
    try {
      await fs.access(file); const sha = await digest(file);
      await fs.rm(file); result.cacheDeleted.push({ file, cloudObject: name, sha256: sha });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  for (const relative of [`columns/NQ/1s/${day}/${hour}.bin`, `trades/NQ/${day}/${hour}.jsonl.gz`]) {
    const file = path.join(work, relative);
    await fs.mkdir(path.join(out, "removed-working-proof"), { recursive: true });
    await fs.copyFile(file, path.join(out, "removed-working-proof", path.basename(file)));
    result.partialDeleted.push({ file, sha256: await digest(file) }); await fs.rm(file);
  }
  await save();
  const log = createWriteStream(path.join(out, "server-second.log"));
  spawned = spawn("pnpm", ["--filter", "@workspace/receiver", "run", "start"], {
    env: { ...process.env, PORT: "8080", HEATMAP_STORAGE: "app-storage", HEATMAP_STORAGE_DIR: work },
    stdio: ["ignore", "pipe", "pipe"] });
  spawned.stdout!.pipe(log); spawned.stderr!.pipe(log);
  await until(async () => { try { await status(); return true; } catch { return false; } }, "restart", 180000);
  result.restart = await sample("restart-startup");
  await complete("restart-startup");
  result.restartComplete = await status();
  assert.ok(result.restartComplete.phase2a.storage.appStorage.downloads > 0);
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject); proxy.listen(19090, "127.0.0.1", resolve);
  });
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, JSON.stringify({ ownerPid: process.pid, ownerStart: processStart(process.pid) }));
  result.isolationOn = (await status()).measurementIsolation;
  assert.equal(result.isolationOn.enabled, true);
  const chrome = await browser(9222); browsers.push(chrome);
  const replay = await chrome.page("http://127.0.0.1:19090/?mode=replay&from=1793127610&speed=1&debug=1");
  await until(async () => replay.cdp.evaluate("window.__heatmapDebug?.traffic.initialComplete===true"), "replay_ready", 180000);
  result.replay = await replay.cdp.evaluate("window.__heatmapDebug");
  const snap = await replay.cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(out, "production-replay.png"), Buffer.from(snap.data, "base64"));
  // Actual settings dialog, save and GET through this same production port.
  await replay.cdp.evaluate("document.querySelector('[data-testid=\"button-settings\"]').click()");
  await until(async () => replay.cdp.evaluate("document.querySelector('dialog').open && !document.querySelector('#su-bubbleMin').disabled"), "settings_ready", 30000);
  await replay.cdp.evaluate(`(()=>{const e=document.querySelector('#su-bubbleScale');e.value='2';e.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-testid="button-settings-save"]').click();})()`);
  await until(async () => replay.cdp.evaluate("!document.querySelector('dialog').open"), "settings_saved", 30000);
  result.settingsSaved = await (await fetch("http://127.0.0.1:8080/api/settings")).json();
  assert.equal(result.settingsSaved.values.bubbleScale, 2);
  await fetch("http://127.0.0.1:8080/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: defaults }) });
  await chrome.closePage(replay);
  const live = await chrome.page("http://127.0.0.1:19090/?debug=1");
  await until(async () => live.cdp.evaluate("window.__heatmapDebug?.traffic.initialComplete===true"), "live_ready", 180000);
  result.liveStart = await sample("live30");
  assert.equal(result.liveStart.phase2b.connected, 1);
  const seen = new Map<number, any>();
  async function collect() {
    const snapshot = await live.cdp.evaluate("window.__heatmapRecentTrades");
    for (const t of snapshot.trades) seen.set(t.seq, t);
  }
  await collect(); const deadline = Date.now() + 30 * 60000;
  console.log("PHASE10A_LIVE30_STARTED", new Date().toISOString()); await save();
  while (Date.now() < deadline) {
    await delay(Math.min(5000, deadline - Date.now())); await collect();
    const s = await sample("live30"); assert.equal(s.phase2b.connected, 1);
  }
  result.liveEnd = await sample("live30");
  await delay(1000); await collect();
  const startSeq = Math.max(...result.liveStart.recentTrades.map((t: any) => t.seq));
  const endSeq = Math.max(...result.liveEnd.recentTrades.map((t: any) => t.seq));
  const startRecvUs = result.liveStart.recentTrades.find((t: any) => t.seq === startSeq).recvUs;
  const endRecvUs = result.liveEnd.recentTrades.find((t: any) => t.seq === endSeq).recvUs;
  const rows = [...seen.values()].filter(t => t.seq > startSeq && t.seq <= endSeq);
  result.comparison = { startSeq, endSeq, startRecvUs, endRecvUs, browserCount: rows.length,
    browserVolume: rows.reduce((n, t) => n + t.size, 0),
    acceptedUpstream: result.liveEnd.counts.acceptedTrade - result.liveStart.counts.acceptedTrade,
    rawUpstream: result.liveEnd.byType.tick - result.liveStart.byType.tick,
    vpAdded: result.liveEnd.phase2a.vp.profile.total - result.liveStart.phase2a.vp.profile.total };
  const liveShot = await live.cdp.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(out, "production-live30.png"), Buffer.from(liveShot.data, "base64"));
  await chrome.closePage(live);
  console.log("PHASE10A_LIVE30_FINISHED", result.comparison); await save();
  // Three distinct Chromium processes; each owns exactly one real-data WS.
  for (const port of [9223, 9224]) browsers.push(await browser(port));
  const loadPages = await Promise.all(browsers.map(b => b.page("http://127.0.0.1:19090/__phase10a-load")));
  const to = Math.floor(Date.now() / 1000) - 600, from = to - 3600;
  for (const p of loadPages) await p.cdp.evaluate(`(()=>{
    window.__load={initial:false,done:false,columns:0,trades:0,frames:0,errors:[],from:${from},to:${to}};
    const s=new WebSocket('ws://127.0.0.1:19090/api/ws?mode=live');s.binaryType='arraybuffer';window.__loadSocket=s;
    s.onmessage=e=>{const r=window.__load;if(typeof e.data==='string'){const m=JSON.parse(e.data);
      if(m.type==='rangeDone'&&m.reqId===0)r.initial=true;
      if(m.type==='rangeTrades'&&m.reqId===7701)r.trades+=m.trades.length;
      if(m.type==='rangeDone'&&m.reqId===7701){r.done=true;r.summary=m;}
      if(m.type==='error')r.errors.push(m);
    }else{const v=new DataView(e.data);if(v.getUint8(0)===2&&v.getUint32(1,true)===7701){r.frames++;r.columns+=v.getUint32(5,true);}}};
    return true;})()`);
  await until(async () => (await Promise.all(loadPages.map(p => p.cdp.evaluate("window.__load.initial")))).every(Boolean), "three_initial", 180000);
  result.threeStart = await sample("three60");
  for (const p of loadPages) await p.cdp.evaluate(`window.__loadSocket.send(JSON.stringify({op:'range',reqId:7701,fromSec:${from},toSec:${to}}))`);
  await until(async () => {
    const s = await sample("three60"); assert.equal(s.phase2b.connected, 3);
    return (await Promise.all(loadPages.map(p => p.cdp.evaluate("window.__load.done")))).every(Boolean);
  }, "three_ranges", 300000);
  result.three = await Promise.all(loadPages.map(p => p.cdp.evaluate("window.__load")));
  result.threeEnd = await sample("three60");
  for (const r of result.three) { assert.ok(r.trades > 0); assert.equal(r.errors.length, 0); }
  await save();
} catch (e) { result.failure = e instanceof Error ? e.message : String(e); console.error("PHASE10A_FAILURE", result.failure); process.exitCode = 1; }
finally {
  for (const b of browsers) {
    try { result.browserClosures.push(await b.close()); } catch (e) { result.browserClosures.push({ error: String(e) }); }
  }
  try {
    await fs.rm(marker, { force: true }); result.isolationAfter = (await status()).measurementIsolation;
    assert.equal(result.isolationAfter.enabled, false);
    result.externalAdmission = await externalProbe();
    assert.deepEqual(result.externalAdmission, { hello: true, closeCode: 1000 });
    await delay(500); result.final = await status(); assert.equal(result.final.phase2b.connected, 0);
  } catch (e) { result.cleanupError = String(e); }
  await stop();
  for (const s of sockets) s.destroy();
  if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
  result.proxyClosed = !proxy.listening;
  if (result.comparison) {
    let count = 0, volume = 0;
    const visit = async (dir: string) => {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await visit(file);
        else if (item.name.endsWith(".jsonl.gz")) for await (const row of tradeFileRows(file)) {
          const c = result.comparison;
          if ((row.recvUs > c.startRecvUs || row.recvUs === c.startRecvUs && row.seq > c.startSeq)
            && (row.recvUs < c.endRecvUs || row.recvUs === c.endRecvUs && row.seq <= c.endSeq)) { count++; volume += row.size; }
        }
      }
    };
    await visit(path.join(work, "trades"));
    result.comparison.savedCount = count; result.comparison.savedVolume = volume;
    result.comparison.countsMatch = count === result.comparison.browserCount && count === result.comparison.acceptedUpstream;
    result.comparison.volumeMatches = volume === result.comparison.browserVolume && volume === result.comparison.vpAdded;
  }
  result.devObjects = await objects.list("dev/");
  result.finishedAt = new Date().toISOString(); await save();
  console.log("PHASE10A_COMPLETE", { failure: result.failure, comparison: result.comparison, cleanup: result.cleanupError });
}
