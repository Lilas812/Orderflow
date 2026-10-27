import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import assert from "node:assert/strict";

const out = "data/phase7/seam-fix";
await fs.mkdir(out, { recursive: true });
const status = async () => (await fetch("http://127.0.0.1:8080/api/status")).json();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const first = await status(), pid = first.memory.pid;
await fs.writeFile(`${out}/initial-status.json`, JSON.stringify(first, null, 2));
console.log("VP_SEAM_CHECK_STARTED", { pid, L: first.phase2a.seamL });
try {
  const deadline = Date.now() + 12 * 3600000;
  for (;;) {
    const s = await status();
    const text = await fs.readFile(`/proc/${pid}/status`, "utf8");
    await fs.appendFile(`${out}/status-samples.jsonl`, JSON.stringify({ at: Date.now(), ...s,
      kernelRss: Number(text.match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024,
      kernelHwm: Number(text.match(/^VmHWM:\s+(\d+)/m)?.[1]) * 1024 }) + "\n");
    const vp = s.phase2a.vp;
    assert.ok(vp.state !== "failed" && vp.state !== "stopped", vp.lastError ?? "history failed");
    if (vp.state === "complete") {
      await fs.writeFile(`${out}/complete-status.json`, JSON.stringify(s, null, 2));
      console.log("VP_SEAM_HISTORY_COMPLETE", { elapsedMs: vp.elapsedMs, apiWindows: vp.apiWindows,
        gaps: vp.gaps.length, total: vp.profile.total });
      break;
    }
    assert.ok(Date.now() < deadline, "history deadline");
    await pause(5000);
  }
  const child = spawn(process.execPath, ["server/tools/perf/phase7-live-compare.ts"], {
    env: { ...process.env, PHASE7_COMPARISON_OUT: `${out}/live-comparison.json` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  let output = "";
  const captured = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("capture timeout")), 25000);
    child.stdout.on("data", bytes => {
      output += bytes.toString(); process.stdout.write(bytes);
      if (output.includes("VP_SEQUENCE_CAPTURE")) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on("data", bytes => { output += bytes.toString(); process.stderr.write(bytes); });
    child.once("exit", () => { clearTimeout(timer); reject(Error("comparison exited before capture")); });
  });
  await captured;
  await fs.writeFile(`${out}/before-stop-status.json`, JSON.stringify(await status(), null, 2));
  process.kill(pid, "SIGTERM");
  const result = await exited;
  await fs.writeFile(`${out}/comparison-tool.log`, output);
  assert.equal(result, 0, "independent live comparison must pass");
  console.log("VP_SEAM_CHECK_PASSED");
} finally {
  try { process.kill(pid, "SIGTERM"); } catch {}
  let exited = false;
  for (let n = 0; n < 60; n++) {
    try { await fs.access(`/proc/${pid}`); } catch { exited = true; break; }
    await pause(500);
  }
  const ports: Record<number, string> = {};
  for (const port of [8080, 19090, 9222, 9223]) ports[port] = await new Promise(resolve => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve("open"); }); s.on("error", () => resolve("closed"));
  });
  await fs.writeFile(`${out}/stop-proof.json`, JSON.stringify({ at: new Date().toISOString(), pid, exited, ports,
    browserUsed: false }, null, 2));
  assert.ok(exited, "receiver exited after SIGTERM");
}
