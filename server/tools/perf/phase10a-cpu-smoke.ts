import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { delay } from "./cdp.ts";
import { defaults } from "../../src/settings/schema.ts";

// Run only after the load pass has stopped. This checks the final CPU
// diagnostic (including the fraction since the timer tick), not another soak.
const dir = path.resolve("data/phase10a");
const status = async () => (await (await fetch("http://127.0.0.1:8080/api/status",
  { signal: AbortSignal.timeout(1000) })).json());
let alreadyRunning = false;
try { await status(); alreadyRunning = true; } catch {}
assert.equal(alreadyRunning, false, "Do not start a second upstream process");
const file = await fs.open(path.join(dir, "server-cpu-smoke.log"), "w");
const child = spawn("pnpm", ["--filter", "@workspace/receiver", "run", "start"], {
  detached: true, env: { ...process.env, PORT: "8080", HEATMAP_STORAGE: "app-storage",
    HEATMAP_STORAGE_DIR: path.join(dir, "working") }, stdio: ["ignore", file.fd, file.fd] });
await file.close();
const proof: any = { startedAt: new Date().toISOString() };
let pid = 0;
try {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const s = await status(); pid = s.memory.pid;
      if (s.counts.acceptedBook > 0) { proof.status = s; break; }
    } catch {}
    assert.ok(Date.now() < deadline, "production_smoke_timeout"); await delay(250);
  }
  assert.equal(proof.status.measurementIsolation.enabled, false);
  for (const key of ["average10s", "average60s"]) assert.ok(Number.isFinite(proof.status.memory.cpu[key]));
  const settings = await (await fetch("http://127.0.0.1:8080/api/settings")).json();
  assert.deepEqual(settings.values, defaults); proof.settings = settings;
} finally {
  if (pid) process.kill(pid, "SIGTERM");
  else if (child.pid) try { process.kill(-child.pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + 120000;
  while (pid) {
    try { await fs.access(`/proc/${pid}`); } catch { break; }
    assert.ok(Date.now() < deadline, "smoke_shutdown_timeout"); await delay(250);
  }
  proof.pid = pid; proof.processGone = !pid || !(await fs.access(`/proc/${pid}`).then(() => true, () => false));
  let open = false; try { await status(); open = true; } catch {}
  proof.portClosed = !open; proof.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, "cpu-smoke.json"), JSON.stringify(proof, null, 2));
}
console.log("PHASE10A_FINAL_CPU_SMOKE", { pid, gone: proof.processGone, portClosed: proof.portClosed });
