import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIVE_ROOT, createTrial, purgeTrial, scanExpiredTrials } from "@workspace/tickstream-storage/live-trial-directory";
import { isolatedB2, privateProbe, runB2Trial } from "./gateB2Process";

const ids: string[] = [];
afterEach(() => { for (const id of ids.splice(0)) {
  try { purgeTrial(DEFAULT_LIVE_ROOT, id); } catch { /* assertion below owns any unexpected residual */ }
} });
function child(code: string) {
  return spawn(process.execPath, ["-e", code], { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
}
describe("B-2B independent supervisor, restart verification and immediate purge", () => {
  it("wrong/default flags HOLD without looking at Secrets or creating a trial", async () => {
    const before = existsSync(DEFAULT_LIVE_ROOT) ? readdirSync(DEFAULT_LIVE_ROOT) : [];
    const script = fileURLToPath(new URL("./gateB2Process.ts", import.meta.url));
    const p = spawn(process.execPath, ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", script],
      { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let text = ""; p.stdout.on("data", b => { text += b; });
    await new Promise<void>(resolve => p.once("close", () => resolve()));
    expect(JSON.parse(text)).toMatchObject({ phase: "HOLD", reason: "LIVE_MODE_REQUIRED" });
    expect(existsSync(DEFAULT_LIVE_ROOT) ? readdirSync(DEFAULT_LIVE_ROOT) : []).toEqual(before);
  });
  it("makes artificial canary-only probes, purges on success and refuses a 200 response", async () => {
    const before = existsSync(DEFAULT_LIVE_ROOT) ? readdirSync(DEFAULT_LIVE_ROOT) : [], urls: string[] = [];
    const result = await privateProbe(DEFAULT_LIVE_ROOT, async url => { urls.push(url); return 403; });
    expect(result).toEqual({ passed: true, probes: 6, remainingFiles: 0 });
    expect(urls.every(url => url.startsWith("http://127.0.0.1:80/") && url.includes("privacy-canary"))).toBe(true);
    await expect(privateProbe(DEFAULT_LIVE_ROOT, async () => 200)).rejects.toThrow("B2_PRIVATE_PROBE_FAILED");
    expect(readdirSync(DEFAULT_LIVE_ROOT)).toEqual(before);
  });
  it("requires an in-process privacy proof before even considering a production run", async () => {
    await expect(runB2Trial("PRODUCTION", "ARTIFICIAL_KEY_NEVER_USED", {})).rejects.toMatchObject({ code: "B2_PRIVATE_PROBE_FAILED" });
  });
  it("reports malformed IPC as a fixed code, never a raw secret/URL", async () => {
    const r = await isolatedB2({ spawn: () => child(`process.on("message",m=>{
      if(m.type==="START")process.send({type:"RESULT",value:{raw:"ARTIFICIAL_KEY_SENTINEL"}});
      if(m.type==="STOP")process.exit(1);
    });`), decode: () => null, budgetMs: 3000, cleanupMs: 100 });
    expect(r.reason).toBe("B2_IPC_INVALID"); expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });
  it("terminates an unresponsive event loop independently and waits for exit", async () => {
    const r = await isolatedB2({ spawn: () => child(`process.on("SIGTERM",()=>{});
      process.on("message",m=>{if(m.type==="START")Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`),
    decode: () => null, budgetMs: 300, cleanupMs: 100 });
    expect(r.forced).toBe(true); expect(r.result).toBeNull(); expect(r.reason).toMatch(/WALL_TIME_LIMIT|FORCED_TERMINATION/);
    expect(r.childRssPeak).toBeGreaterThan(0); expect(r.totalRssPeak).toBeGreaterThan(r.childRssPeak!);
  });
  it("never permits watchdog/cleanup limits larger than approved budgets", async () => {
    let called = false;
    await expect(isolatedB2({ spawn: () => { called = true; return child(""); }, decode: () => null,
      budgetMs: 120001 })).rejects.toThrow("B2_UNSAFE_BUDGET");
    expect(called).toBe(false);
  });
  it.each([1, 2, 3])("does not fabricate MEMORY_NOT_MEASURED when a validated child exits immediately (%s)", async () => {
    const r = await isolatedB2({ spawn: () => child(`process.on("message",m=>{
      if(m.type==="START")process.send({type:"RESULT",value:{done:true}},()=>process.exit(0));});`),
    decode: v => (v as { done?: unknown })?.done === true ? { done: true } : null, budgetMs: 3000, cleanupMs: 100 });
    expect(r.reason).toBeNull(); expect(r.result).toEqual({ done: true });
    expect(r.childRssPeak).toBeGreaterThan(0); expect(r.totalRssPeak).toBeGreaterThan(0);
  });
  it("writes in one empty-env Node, fully verifies in a different Node, immediately purges only that trial", async () => {
    const other = createTrial(DEFAULT_LIVE_ROOT, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST"); ids.push(other.trialId);
    const otherMarker = readFileSync(`${other.directory}/trial.json`, "utf8");
    let start: { trialId: string; captureMode: string; deleteByMs: number } | undefined;
    const r = await runB2Trial("ARTIFICIAL_PROTOCOL_TEST", undefined, undefined, info => {
      start = info;
      expect(existsSync(`${DEFAULT_LIVE_ROOT}/${info.trialId}/trial.json`)).toBe(true);
      expect(readdirSync(`${DEFAULT_LIVE_ROOT}/${info.trialId}/data`)).toEqual([]);
    });
    expect(r.phase, JSON.stringify(r)).toBe("COMPLETED");
    expect(start?.trialId).toBe(r.trialId); expect(start?.captureMode).toBe("ARTIFICIAL_PROTOCOL_TEST");
    expect(start?.deleteByMs).toBeGreaterThan(Date.now());
    expect(r.capture?.storage).toMatchObject({ persisted: 2, pending: 0, unknown: 0, accountingMatches: true });
    expect(r.recovery).toMatchObject({ status: "VERIFIED", manifestCount: 2, logCount: 2, finalCommitPosition: 2 });
    expect(r.recovery?.head).toBe(r.capture?.commit.head);
    expect(r.recovery?.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.cleanup).toMatchObject({ deleted: true, remainingFiles: 0, trialId: r.trialId });
    expect(existsSync(`${DEFAULT_LIVE_ROOT}/${r.trialId}`)).toBe(false);
    expect(readFileSync(`${other.directory}/trial.json`, "utf8")).toBe(otherMarker);
    expect(r.deletionWhileStopped).toBe("NOT_GUARANTEED_MANUAL_CONFIRMATION_REQUIRED");
  });
  it("detects an expired trial without parsing it and prevents new capture until explicit purge", async () => {
    const p = createTrial(DEFAULT_LIVE_ROOT, randomUUID(), "ARTIFICIAL_PROTOCOL_TEST", Date.now() - 100, 1); ids.push(p.trialId);
    expect(scanExpiredTrials()).toContain(p.trialId);
    await expect(runB2Trial("ARTIFICIAL_PROTOCOL_TEST")).rejects.toMatchObject({ code: "TRIAL_EXPIRED_CLEANUP_REQUIRED" });
    expect(existsSync(p.directory)).toBe(true);
  });
});
