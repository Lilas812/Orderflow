/** Isolated-only measurement. Requires the --labels-test fixture, never a published URL. */
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";

const base = "http://127.0.0.1:18886", directory = "docs/evidence/turning-point-labels";
const get = async url => { const r = await fetch(base + url); if (!r.ok) throw Error(`fixture_http_${r.status}`); return r.json(); };
const delay = ms => new Promise(r => setTimeout(r, ms));
const status = await get("/labels-test-status");
if (!status.isolated || !status.noRealCloud || !status.noUpstream) throw Error("not_isolated_fixture");
await fs.mkdir(directory, { recursive: true });
// This is exclusively the fixture-owned child; refresh it so its module cache matches the final sources.
if (status.worker.childPid) {
  const pid = status.worker.childPid;
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const parent = +stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1];
  const args = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
  if (parent !== status.pid || !args.includes("/history/child.ts")) throw Error("child_not_owned_by_fixture");
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); await delay(10); } catch { break; }
  }
}
const labels = {};
for (const symbol of ["NQ", "GC"]) {
  const doc = await get(`/api/labels?symbol=${symbol}`);
  if (doc.labels.length !== 5) throw Error(`expected_five_${symbol}`);
  labels[symbol] = doc;
  await fs.writeFile(path.join(directory, `${symbol}.labels.json`), JSON.stringify(doc, null, 2));
}
const data = await get("/__replay");
if (data.peers.some(([, n]) => n !== 0)) throw Error("wait_until_browser_is_closed");
const from = Math.floor(data.from / 86400) * 86400, to = from + 86400;
const endpoint = symbol => `/api/labels/export?symbol=${symbol}&fromSec=${from}&toSec=${to}`;
const ownedTmp = async () => (await fs.readdir("/tmp")).filter(n => n.startsWith("turning-export-")).sort();
const beforeTmp = await ownedTmp(), cancel = new AbortController();
const cancelRequest = fetch(base + endpoint("NQ"), { signal: cancel.signal })
  .then(async r => { await r.arrayBuffer(); return "completed"; }, e => e.name);
let observedServerJob = false;
for (let i = 0; i < 100; i++) {
  if ((await ownedTmp()).some(n => !beforeTmp.includes(n))) { observedServerJob = true; break; }
  await delay(10);
}
cancel.abort();
const cancelled = await cancelRequest === "AbortError";
for (let i = 0; i < 80; i++) {
  if ((await ownedTmp()).every(n => beforeTmp.includes(n)) && !(await get("/labels-test-status")).worker.childPid) break;
  await delay(25);
}
if (!observedServerJob || !cancelled || (await ownedTmp()).some(n => !beforeTmp.includes(n))) throw Error("cancel_cleanup_incomplete");

const socket = new WebSocket(base.replace("http:", "ws:") + `/api/ws?symbol=NQ&controls=1&mode=replay&from=${data.from}&speed=60`);
let messages = 0, bytes = 0, closedCode;
socket.on("message", b => { messages++; bytes += b.length; });
socket.on("close", code => { closedCode = code; });
await once(socket, "open");
await delay(500);
if (socket.readyState !== WebSocket.OPEN) throw Error("isolated_replay_not_open");
const results = [];
try {
  for (const symbol of ["NQ", "GC"]) {
    const before = await get("/__replay?reset=1"), at = performance.now(), m0 = messages, b0 = bytes;
    const response = await fetch(base + endpoint(symbol));
    if (!response.ok || !response.headers.get("content-type")?.includes("application/zip")) {
      throw Error(`export_${symbol}_${response.status}_${await response.text()}`);
    }
    const zip = Buffer.from(await response.arrayBuffer()), file = path.join(directory, `${symbol}.zip`);
    await fs.writeFile(file, zip);
    const elapsedMs = performance.now() - at, after = await get("/__replay"), child = await get("/labels-test-status");
    const checked = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    const summary = JSON.parse(execFileSync("unzip", ["-p", file, "summary.json"], { encoding: "utf8" }));
    const csv = execFileSync("unzip", ["-p", file, "events.csv"], { encoding: "utf8" });
    await fs.writeFile(path.join(directory, `${symbol}.summary.json`), JSON.stringify(summary, null, 2));
    await fs.writeFile(path.join(directory, `${symbol}.events-head.csv`), csv.split("\r\n").slice(0, 4).join("\r\n") + "\r\n");
    results.push({ symbol, elapsedMs, zipBytes: zip.length, zipSha256: createHash("sha256").update(zip).digest("hex"),
      cpuUs: after.metrics.cpu, eventLoopMaxMs: after.metrics.eventLoopMaxMs, rssBefore: before.metrics.rss,
      rssAfter: after.metrics.rss, parentCore: (after.metrics.cpu.user + after.metrics.cpu.system) / (elapsedMs * 1000),
      childFinalRss: child.worker.childRss, workerPid: child.worker.childPid, priority: child.worker.priority,
      wsMessages: messages - m0, wsBytes: bytes - b0, peers: after.peers, counts: summary.counts,
      missingControls: summary.controls, zipChecked: checked.trim() });
  }
} finally {
  if (socket.readyState === WebSocket.OPEN) { const close = once(socket, "close"); socket.close(1000); await close; }
  else socket.terminate();
}
const final = await get("/__replay");
if (final.peers.some(([, n]) => n !== 0)) throw Error("own_socket_leaked");
const manifest = JSON.parse(await fs.readFile("data/gpu-heatmap/production-input/manifest.json", "utf8"));
const checkedInputs = [];
for (const entry of manifest.copied) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(entry.local)) h.update(chunk);
  const actual = h.digest("hex");
  if (actual !== entry.sha256) throw Error(`source_hash_changed:${entry.local}`);
  checkedInputs.push({ file: entry.local, sha256: actual, bytes: entry.bytes });
}
await fs.writeFile(path.join(directory, "input-hashes.json"), JSON.stringify(checkedInputs, null, 2));
const proof = { isolated: true, capturedAt: new Date().toISOString(), fixturePid: status.pid, inputFrom: data.from,
  inputEnd: data.end, exportFrom: from, exportTo: to, cancellation: { observedServerJob, cancelled, ownTempRemaining: [] },
  results, cleanup: { wsCloseCode: closedCode, peers: final.peers }, noRealCloud: true, noUpstream: true,
  originalFilesChecked: checkedInputs.length };
await fs.writeFile(path.join(directory, "export-metrics.json"), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
