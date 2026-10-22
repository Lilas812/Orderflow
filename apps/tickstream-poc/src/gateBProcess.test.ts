import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gateBWatchdog, superviseGateB } from "./gateBProcess";
import { LIMITS, emptyGateBReport, type GateBReport } from "./gateBConfig";
import { GateBTicks, type BTicksSocket } from "./gateBTransport";
import { FakeClock } from "./transport";

class Worker extends EventEmitter {
  pid = 1234;
  sends: unknown[] = [];
  signals: string[] = [];
  send(value: unknown, callback?: () => void) { this.sends.push(value); callback?.(); return true; }
  kill(signal: string) { this.signals.push(signal); return true; }
}
async function harness() {
  const worker = new Worker(); let now = 0, sample: () => void = () => {}, cancel = 0;
  const promise = superviseGateB({
    spawnWorker: () => worker as unknown as ChildProcess, rss: () => 2_000_000, parentRss: () => 1_000_000,
    now: () => now, every: cb => { sample = cb; return () => { cancel++; }; },
  });
  await vi.waitFor(() => expect(worker.listenerCount("message")).toBe(1));
  return { worker, promise, sample: () => sample(), advance: (ms: number) => { now += ms; }, cancelled: () => cancel };
}
function report(): GateBReport {
  const socket: BTicksSocket = { listen() {}, connect() {}, subscribe() {}, jsonPong() {}, close() {}, terminate() {} };
  const p = new GateBTicks(new FakeClock(), () => socket, "PRODUCTION"); p.start(); p.finish();
  return p.report();
}
describe("isolated Gate B process policy; no credentials or production sockets used", () => {
  it.each([
    [{ elapsedMs: 0, stoppingMs: null, rss: null, totalRss: null }, "STOP", "MEMORY_NOT_MEASURED"],
    [{ elapsedMs: 0, stoppingMs: null, rss: -1, totalRss: 1 }, "STOP", "MEMORY_NOT_MEASURED"],
    [{ elapsedMs: 0, stoppingMs: null, rss: 1, totalRss: NaN }, "STOP", "MEMORY_NOT_MEASURED"],
    [{ elapsedMs: 0, stoppingMs: null, rss: LIMITS.sessionRss + 1, totalRss: LIMITS.sessionRss + 2 }, "STOP", "MEMORY_THRESHOLD"],
    [{ elapsedMs: 0, stoppingMs: null, rss: 1, totalRss: LIMITS.totalRss + 1 }, "STOP", "MEMORY_THRESHOLD"],
    [{ elapsedMs: 118000, stoppingMs: null, rss: 1, totalRss: 2 }, "STOP", "WALL_TIME_LIMIT"],
    [{ elapsedMs: 120000, stoppingMs: null, rss: 1, totalRss: 2 }, "KILL", "WALL_TIME_LIMIT"],
    [{ elapsedMs: 2000, stoppingMs: 2000, rss: 1, totalRss: 2 }, "KILL", "FORCED_TERMINATION"],
  ])("enforces independent time/RSS/cleanup decisions", (input, kind, reason) => {
    expect(gateBWatchdog(input, LIMITS)).toEqual({ kind, reason });
  });
  it("acknowledges exactly one sanitized report and measures combined sampled RSS", async () => {
    const h = await harness();
    h.worker.emit("message", { ...report(), key: "KEY_URL_SENTINEL", raw: "RAW_SENTINEL" });
    expect(h.worker.sends).toEqual([{ type: "REPORT_ACK" }]);
    h.worker.emit("exit", 0, null); const result = await h.promise;
    expect(result).toMatchObject({ phase: "STOPPED", memory: { measurement: "MEASURED", totalRssPeak: 3_000_000 } });
    expect(JSON.stringify(result)).not.toContain("SENTINEL"); expect(h.cancelled()).toBe(1);
  });
  it("stops a stalled worker independently, then kills within cleanup budget", async () => {
    const h = await harness(); h.advance(118000); h.sample();
    expect(h.worker.sends).toContainEqual({ type: "STOP", reason: "WALL_TIME_LIMIT" });
    h.advance(2000); h.sample(); expect(h.worker.signals).toContain("SIGKILL");
    h.worker.emit("exit", null, "SIGKILL");
    expect(await h.promise).toMatchObject({ phase: "FAILED", stopReason: "WALL_TIME_LIMIT",
      supervisorForcedTermination: true, counters: null });
  });
  it("kills a worker that reports but refuses to exit/acknowledge cleanup", async () => {
    const h = await harness(); h.worker.emit("message", report()); h.advance(2000); h.sample();
    expect(h.worker.signals).toContain("SIGKILL"); h.worker.emit("exit", null, "SIGKILL");
    expect(await h.promise).toMatchObject({ phase: "FAILED", stopReason: "FORCED_TERMINATION", supervisorForcedTermination: true });
  });
  it.each(["invalid", "duplicate"] as const)("rejects %s IPC without echoing its contents", async kind => {
    const h = await harness();
    h.worker.emit("message", kind === "invalid" ? { key: "RAW_SENTINEL" } : report());
    if (kind === "duplicate") h.worker.emit("message", report());
    expect(h.worker.sends).toContainEqual({ type: "STOP", reason: "IPC_INVALID" });
    h.worker.emit("exit", 1, null);
    const r = await h.promise; expect(r.stopReason).toBe("IPC_INVALID"); expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });
  it("handles spawn rejection and error/close without waiting for an exit event", async () => {
    const a = await superviseGateB({ spawnWorker: () => { throw Error("KEY_URL_SENTINEL"); }, rss: () => null, parentRss: () => 0 });
    expect(a.stopReason).toBe("CHILD_FAILURE");
    const h = await harness(); h.worker.emit("error", Error("KEY_URL_SENTINEL")); h.worker.emit("close", -1, null);
    const b = await h.promise; expect(b.stopReason).toBe("CHILD_FAILURE"); expect(JSON.stringify([a, b])).not.toContain("SENTINEL");
  });
  it("safely stops if RSS measurement becomes unavailable", async () => {
    const worker = new Worker();
    const promise = superviseGateB({ spawnWorker: () => worker as unknown as ChildProcess,
      rss: () => null, parentRss: () => 1, every: () => () => {} });
    await vi.waitFor(() => expect(worker.sends).toContainEqual({ type: "STOP", reason: "MEMORY_NOT_MEASURED" }));
    worker.emit("exit", 1, null);
    expect(await promise).toMatchObject({ stopReason: "MEMORY_NOT_MEASURED", memory: { measurement: "NOT_MEASURED" } });
  });
  it("actually kills an empty-environment event-loop-stalled child under independent supervision", async () => {
    let worker: ChildProcess | undefined, spawned = false;
    const started = performance.now();
    try {
      const result = await superviseGateB({
        spawnWorker: () => {
          worker = spawn(process.execPath, ["-e", "for (;;) {}"], { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
          worker.once("spawn", () => { spawned = true; }); return worker;
        },
        now: () => performance.now() - started + (spawned ? 118000 : 0),
        rss: pid => {
          try {
            const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
            return match ? Number(match[1]) * 1024 : null;
          } catch { return null; }
        },
        parentRss: () => process.memoryUsage().rss,
      });
      expect(result).toMatchObject({ phase: "FAILED", stopReason: "WALL_TIME_LIMIT",
        supervisorForcedTermination: true, counters: null });
      expect(worker!.signalCode).toBe("SIGKILL");
    } finally { worker?.kill("SIGKILL"); }
  });
  it("normal CLI and an explicit operation both remain HOLD without reading inherited credentials", () => {
    const path = fileURLToPath(new URL("./gateBProcess.ts", import.meta.url));
    for (const args of [[], ["--execute-gate-b1"], ["--endpoint=wss://external.invalid/"]]) {
      const result = spawnSync(process.execPath,
        ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", path, ...args],
        { env: {}, encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(0); expect(result.stderr).toBe("");
      const r = JSON.parse(result.stdout) as GateBReport;
      expect(r).toMatchObject({ execution: "NOT_RUN", phase: "NOT_RUNNING", stopReason: "HOLD",
        counters: null, authentication: "NOT_CHECKED", persistence: "DISABLED" });
      expect(r.holdReasons).toContain("ENDPOINT_UNCONFIRMED");
    }
  });
  it("limits the runtime dependency graph and worker environment; no normal-start hook or storage writer", () => {
    const processSource = readFileSync(new URL("./gateBProcess.ts", import.meta.url), "utf8");
    const sessionSource = readFileSync(new URL("./gateBSession.ts", import.meta.url), "utf8");
    const transportSource = readFileSync(new URL("./gateBTransport.ts", import.meta.url), "utf8");
    expect(processSource).toContain("env: { TICKSTREAM_API_KEY: key }");
    expect(processSource).toContain('stdio: ["ignore", "ignore", "ignore", "ipc"]');
    expect(processSource).not.toMatch(/\.\.\.process\.env|console\.|writeFile|appendFile|createWriteStream/);
    expect(sessionSource + transportSource).not.toMatch(/tickstream-storage|@workspace\/storage|writeFile|appendFile|createWriteStream|process\.env|console\./);
    const poc = readFileSync(new URL("./poc.ts", import.meta.url), "utf8");
    expect(poc).not.toContain("gateB");
    expect(emptyGateBReport().counters).toBeNull();
  });
});
