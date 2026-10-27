import * as fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import net from "node:net";
import { ReplitObjects } from "../../src/store/objects.ts";
import { delay } from "./cdp.ts";

const dir = path.resolve("data/phase10a"), root = path.join(dir, "working");
const objects = new ReplitObjects();
const proof: any = { startedAt: new Date().toISOString(), runs: [] };
const status = async () => {
  const r = await fetch("http://127.0.0.1:8080/api/status", { signal: AbortSignal.timeout(1000) });
  assert.equal(r.status, 200); return r.json();
};
const exists = (file: string) => fs.access(file).then(() => true, () => false);
async function localFiles(base = root): Promise<string[]> {
  const result: string[] = [];
  for (const item of await fs.readdir(base, { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.name.startsWith("settings") || item.name === "coverage.json") continue;
    const file = path.join(base, item.name);
    if (item.isDirectory()) result.push(...await localFiles(file));
    else if (/\.(bin|gz)$/.test(item.name)) result.push(path.relative(root, file));
  }
  return result.sort();
}
let present = false; try { await status(); present = true; } catch {}
assert.equal(present, false, "Another receiver is already running");
proof.objectsBefore = await objects.list("dev/");
for (let i = 1; i <= 2; i++) {
  const run: any = { number: i, beforeFiles: await localFiles() };
  proof.runs.push(run);
  const logFile = path.join(dir, `shutdown-real-${i}.log`);
  const fd = await fs.open(logFile, "w");
  const child = spawn("pnpm", ["--filter", "@workspace/receiver", "run", "start"], {
    detached: true, env: { ...process.env, PORT: "8080", HEATMAP_STORAGE: "app-storage",
      HEATMAP_STORAGE_DIR: root }, stdio: ["ignore", fd.fd, fd.fd] });
  await fd.close();
  let pid = 0;
  try {
    const deadline = Date.now() + 180000;
    for (;;) {
      try {
        const s = await status(); pid = s.memory.pid;
        if (s.upstream.state === "open") { run.beforeStatus = s; break; }
      } catch {}
      if (child.exitCode !== null) throw Error("production_startup_failed");
      assert.ok(Date.now() < deadline, "startup_timeout"); await delay(100);
    }
    run.pid = pid; run.signalAt = new Date().toISOString();
    const start = performance.now(); process.kill(pid, "SIGTERM");
    while (await exists(`/proc/${pid}`)) {
      assert.ok(performance.now() - start < 11000, "shutdown_exceeded_10_seconds"); await delay(10);
    }
    run.exitMs = performance.now() - start; run.processGone = true;
    assert.ok(run.exitMs < 10000, "shutdown_over_budget");
    const events = (await fs.readFile(logFile, "utf8")).split("\n")
      .filter(l => l.startsWith('{"recvUs"')).map(l => JSON.parse(l));
    run.close = events.filter(e => ["upstream_close", "upstream_stopped", "server_stopped", "shutdown_deadline"].includes(e.event));
    run.uploaded = events.filter(e => e.event === "app_storage_uploaded");
    run.cacheVerified = events.filter(e => e.event === "app_storage_cache_verified").map(e => e.details.object);
    run.summary = events.findLast(e => e.event === "app_storage_shutdown_summary")?.details;
    run.failures = events.filter(e => /app_storage.*(?:failed|retry|error)/.test(e.event));
    assert.ok(run.close.some(e => e.event === "upstream_stopped" && e.details.socketClosed));
    assert.ok(run.close.some(e => e.event === "server_stopped"));
    assert.equal(run.failures.some(e => e.event === "app_storage_retry"), false);
    run.afterFiles = await localFiles();
    run.cloudIndex = JSON.parse(await fs.readFile(path.join(root, "coverage.json"), "utf8"));
    await objects.download("dev/coverage.json", path.join(dir, `shutdown-cloud-index-${i}.json`));
    run.cloudIndex = JSON.parse(await fs.readFile(path.join(dir, `shutdown-cloud-index-${i}.json`), "utf8"));
  } finally {
    if (pid && await exists(`/proc/${pid}`)) {
      process.kill(pid, "SIGTERM"); await delay(10000);
      if (await exists(`/proc/${pid}`)) { process.kill(pid, "SIGKILL"); run.forcedCleanup = true; }
    } else if (!pid && child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch {}
    await fs.writeFile(path.join(dir, "shutdown-real-proof.json"), JSON.stringify(proof, null, 2));
  }
}
proof.objectsAfter = await objects.list("dev/");
proof.portClosed = await new Promise(resolve => {
  const socket = net.createConnection({ host: "127.0.0.1", port: 8080 });
  socket.on("connect", () => { socket.destroy(); resolve(false); });
  socket.on("error", () => resolve(true));
});
assert.equal(proof.portClosed, true);
proof.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(dir, "shutdown-real-proof.json"), JSON.stringify(proof, null, 2));
console.log("SHUTDOWN_REAL_COMPLETE", proof.runs.map((r: any) => ({
  pid: r.pid, exitMs: r.exitMs, uploaded: r.uploaded.map((e: any) => e.details.object),
  remaining: r.summary?.remaining, cacheVerified: r.cacheVerified.length,
})));
