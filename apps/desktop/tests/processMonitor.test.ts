import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
const monitorPath = "../diagnostics/processMonitor.mjs", runnerPath = "../diagnostics/run.mjs";
const contractsPath = "../diagnostics/contracts.mjs";
const { observeProcess, readGroup, parseIdentity, checkOwnership, resourceSample, captureChild,
  profileReceipt, reclaimProfile, createShutdown, fault, faultRecord } = await import(monitorPath);
const { stageRun, runStages } = await import(runnerPath);
const { writer, LIMITS, exitCode } = await import(contractsPath);
const leader = () => ({ pid: 7001, ppid: process.pid, pgid: 7001, sid: 7001,
  uid: process.getuid!(), startTicks: "42", state: "S", userTicks: 1, systemTicks: 2 });
function stat(overrides: any = {}) {
  const p = { ...leader(), ...overrides }, f = Array(50).fill("0");
  f[0] = p.state; f[1] = String(p.ppid); f[2] = String(p.pgid); f[3] = String(p.sid);
  f[11] = String(p.userTicks); f[12] = String(p.systemTicks); f[19] = p.startTicks;
  return `${p.pid} (artificial (comm) not collected) ${f.join(" ")}`;
}
const status = (rss: string | null = "123") =>
  `Pid:\t7001\nUid:\t${process.getuid!()}\t1000\t1000\t1000\n${rss === null ? "" : `VmRSS:\t${rss} kB\n`}`;
function osIO(stats = [stat()], body = status()) {
  let n = 0;
  return { readFileSync: vi.fn((p: string) => p.endsWith("/stat") ?
    stats[Math.min(n++, stats.length - 1)] : body), readdirSync: () => ["7001"] };
}
const observation = (resource: any = { kind: "MEASURED", bytes: 1024 }) => ({
  identity: leader(), liveness: "RUNNING", resource, reads: [{ file: "status", rssFieldPresent: resource.kind === "MEASURED" }],
});
function inventory(observations = [observation()]) {
  return { observations, departures: [], processes: observations.map(o => ({ ...o.identity,
    rss: o.resource.kind === "MEASURED" ? o.resource.bytes : null })),
  live: observations.map(o => o.identity.pid), zombies: [] };
}
const dirs: string[] = [];
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), "orderflow-a6-test-")); dirs.push(p); return p; };
afterEach(() => { vi.useRealTimers(); for (const p of dirs.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

describe("identity, liveness and resource observations", () => {
  it("measures a running process without storing comm/status text", () => {
    const o = observeProcess(7001, { io: osIO() });
    expect(o.identity).toEqual(leader()); expect(o.liveness).toBe("RUNNING");
    expect(o.resource).toEqual({ kind: "MEASURED", bytes: 123 * 1024 });
    expect(JSON.stringify(o)).not.toContain("not collected");
    expect(o.reads.map((x: any) => x.file)).toEqual(["stat", "status", "stat"]);
  });
  it("identity does not depend on RSS, but RUNNING missing RSS is a failure", () => {
    const o = observeProcess(7001, { io: osIO([stat()], status(null)) });
    expect(o.identity).toEqual(leader()); expect(o.liveness).toBe("RUNNING");
    expect(o.resource).toEqual({ kind: "UNKNOWN", reason: "RSS_FIELD_MISSING" });
    expect(() => resourceSample(inventory([o]), LIMITS, "RUNNING", 0)).toThrow("RUNNING_RSS_UNKNOWN");
  });
  it("exit-transition missing RSS stays UNKNOWN, not zero or confirmed exit", () => {
    const o = observeProcess(7001, { io: osIO([stat()], status(null)), phase: "DRAIN" });
    expect(o.liveness).toBe("EXIT_TRANSITION");
    expect(resourceSample(inventory([o]), LIMITS, "DRAIN", 0).resource.kind).toBe("UNKNOWN");
  });
  for (const state of ["Z", "X", "x"]) it(`classifies ${state} as exited / RSS not applicable`, () => {
    const o = observeProcess(7001, { io: osIO([stat({ state })], status(null)) });
    expect(o.liveness).toBe("EXIT_CONFIRMED");
    expect(o.resource).toEqual({ kind: "NOT_APPLICABLE_EXITED" });
  });
  it("records the stat/status transition to Z without inventing RSS", () => {
    const o = observeProcess(7001, { io: osIO([stat(), stat({ state: "Z" })], status(null)) });
    expect(o.liveness).toBe("EXIT_CONFIRMED");
    expect(o.reads[0].state).toBe("S"); expect(o.reads[2].state).toBe("Z");
  });
  for (const code of ["ENOENT", "ESRCH", "EACCES"]) it(`records ${code}, never successful exit by exception`, () => {
    const io = { readFileSync: () => { throw Object.assign(new Error("artificial read failure"), { code }); } };
    try { observeProcess(7001, { io }); throw Error("expected fault"); }
    catch (e) {
      const r = faultRecord(e, "RUNNING", 10);
      expect(r.readErrorCode).toBe(code); expect(r.targetPid).toBe(7001); expect(r.reads).toHaveLength(1);
      expect(r.phase).toBe("RUNNING"); expect(r.stack).toBeTruthy();
    }
  });
  for (const [s, body] of [["invalid", status()], [stat(), "Uid: invalid"],
    [stat({ startTicks: "bad" }), status()], [stat(), status("invalid")]] as const)
    it(`rejects malformed input ${s.slice(0, 9)}/${body.slice(-12)}`, () => {
      if (body === status("invalid")) {
        const o = observeProcess(7001, { io: osIO([s], body) });
        expect(() => resourceSample(inventory([o]), LIMITS, "RUNNING", 0)).toThrow("RSS_UNKNOWN");
      } else expect(() => observeProcess(7001, { io: osIO([s], body) })).toThrow();
    });
  it("rejects PID reuse between the two stat reads", () => {
    expect(() => observeProcess(7001, { io: osIO([stat(), stat({ startTicks: "43" })]) })).toThrow("IDENTITY_RACE");
  });
  for (const key of ["startTicks", "pgid", "sid", "uid"]) it(`rejects changed ownership ${key}`, () => {
    const g = inventory(); (g.processes[0] as any)[key] = key === "startTicks" ? "43" : 999;
    expect(() => checkOwnership(leader(), g, [leader()])).toThrow();
  });
  it("rejects reappearing PID identities and unknown exiting descendants", () => {
    const old = { ...leader(), pid: 7002, ppid: 7001, startTicks: "43" };
    const current = { ...old, startTicks: "44" };
    const g = inventory([{ ...observation(), identity: current }]);
    expect(() => checkOwnership(leader(), g, [old], true)).toThrow("PID_REUSED");
    expect(() => checkOwnership(leader(), g, [], true)).toThrow("EXITING_PROCESS_UNKNOWN");
  });
  it("does not declare an absent leader exited without the child exit barrier", () => {
    expect(() => checkOwnership(leader(), inventory([]), [], false)).toThrow("LEADER_NOT_VERIFIABLE");
    expect(checkOwnership(leader(), inventory([]), [], true).status).toBe("EMPTY");
  });
  it("enumerates identity-only candidates and records disappearance races", () => {
    const io = osIO();
    expect(readGroup(7001, { io }).processes).toHaveLength(1);
    let reads = 0;
    const race = { ...io, readFileSync: (p: string) => {
      if (++reads > 1) throw Object.assign(Error("gone"), { code: "ENOENT" });
      return stat();
    } };
    const g = readGroup(7001, { io: race });
    expect(g.departures).toHaveLength(1);
    expect(() => resourceSample(g, LIMITS, "RUNNING", 0)).toThrow("PROCESS_READ_RACE");
  });
  it("fails closed on an unreadable group inventory", () => {
    expect(() => readGroup(7001, { io: { readdirSync: () => ["7001"],
      readFileSync: () => { throw Object.assign(Error("denied"), { code: "EACCES" }); } } })).toThrow("GROUP_ENUMERATION");
  });
  it("detects a previously owned PID leaving the original group/session", () => {
    const io = osIO([stat({ pgid: 9000, sid: 9000 })]);
    expect(() => readGroup(7001, { io, known: [leader()] })).toThrow("KNOWN_PROCESS_IDENTITY_CHANGED");
  });
  it("preserves process and RSS caps even during cleanup", () => {
    expect(() => resourceSample(inventory([observation({ kind: "MEASURED", bytes: LIMITS.rss + 1 })]),
      LIMITS, "DRAIN", 0)).toThrow("RSS_CAP");
    expect(() => resourceSample(inventory(), { ...LIMITS, processes: 0 }, "RUNNING", 0)).toThrow("PROCESS_CAP");
  });
  it("parses nanosecond-independent process start ticks exactly", () => {
    expect(parseIdentity(7001, stat({ startTicks: "90071992547409931234" }), status()).startTicks).toBe("90071992547409931234");
  });
});

describe("barriers, idempotent cleanup and artificial profiles", () => {
  it("captures early exit before spawn is awaited and keeps exit distinct from close", async () => {
    const c = new EventEmitter(), b = captureChild(c);
    c.emit("spawn"); c.emit("exit", 0, null);
    await b.spawned; await b.exited; expect(b.state.close).toBeNull();
    c.emit("close", 0, null); await b.closed;
    expect(b.state.events.map((x: any) => x.kind)).toEqual(["spawn", "exit", "close"]);
  });
  it("runs shutdown only once, continues after error, and retains the original fault", async () => {
    const calls: string[] = [], errors: any[] = [];
    const close = createShutdown([["stop", () => { calls.push("stop"); throw fault("ORIGINAL_STOP_ERROR"); }],
      ["dispose", () => calls.push("dispose")], ["save", () => calls.push("save")]], (e: any) => errors.push(e));
    expect(close()).toBe(close()); await close();
    expect(calls).toEqual(["stop", "dispose", "save"]); expect(errors[0].reason).toBe("ORIGINAL_STOP_ERROR");
  });
  it("reclaims only a matching new artificial profile after exit + close + empty group", () => {
    const p = path.join(temp(), "profile"); fs.mkdirSync(p, { mode: 0o700 });
    const receipt = profileReceipt(p, "artificial");
    expect(reclaimProfile(receipt, "artificial", leader(), inventory([]), { exit: {}, close: {} }).removed).toBe(true);
    expect(fs.existsSync(p)).toBe(false);
  });
  for (const kind of ["inode", "runId", "owner", "exit", "close", "group", "symlink"]) it(`refuses profile ${kind} mismatch`, () => {
    const base = temp(), p = path.join(base, "profile"); fs.mkdirSync(p, { mode: 0o700 });
    const receipt = profileReceipt(p, "artificial"), held = leader(), g = inventory([]);
    const barriers: any = { exit: {}, close: {} };
    if (kind === "inode") receipt.inode++;
    if (kind === "runId") receipt.runId = "other";
    if (kind === "owner") held.uid++;
    if (kind === "exit") barriers.exit = null;
    if (kind === "close") barriers.close = null;
    if (kind === "group") g.processes = [{ ...held, rss: null }];
    if (kind === "symlink") {
      fs.renameSync(p, p + "-original"); fs.symlinkSync(p + "-original", p);
    }
    expect(() => reclaimProfile(receipt, "artificial", held, g, barriers)).toThrow();
    expect(fs.lstatSync(p)).toBeTruthy();
  });
});

/** A real stageRun control flow, artificial ChildProcess + clock, no process spawning. */
async function artificialStage(options: any = {}) {
  vi.useFakeTimers();
  const directory = temp(), child: any = new EventEmitter();
  child.pid = 7001; child.exitCode = null; child.signalCode = null; child.connected = true;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.destroy = vi.fn(); child.stderr.destroy = vi.fn(); child.unref = vi.fn();
  child.disconnect = vi.fn(() => { child.connected = false; });
  let alive = true, exitSent = false, groupReads = 0, identityReads = 0, drainReads = 0;
  let registered = false;
  const folder = path.join(directory, "stage0");
  const finish = (code = 0) => {
    if (exitSent) return;
    exitSent = true; alive = false; child.connected = false; child.exitCode = code; child.emit("exit", code, null);
    if (!options.closeMissing) setTimeout(() => child.emit("close", code, null), 1);
  };
  child.send = vi.fn((_m: any, callback: any) => {
    if (options.sendThrows) throw fault("SEND_FAILED");
    callback(null); if (!options.ignoreStop) setTimeout(() => finish(1), 1);
  });
  child.kill = vi.fn(() => { if (!options.neverExit) setTimeout(() => finish(1), 1); return true; });
  const deps = {
    runId: "00000000-0000-4000-8000-000000000001", parentPid: process.pid, clockHz: 100,
    tempRoot: directory, electron: "ARTIFICIAL_ONLY", now: () => Date.now(),
    sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
    spawn: vi.fn(() => {
      queueMicrotask(() => {
        registered = ["spawn", "exit", "close", "error"].every(e => child.listenerCount(e) > 0);
        if (options.spawnError) { child.emit("error", Object.assign(Error("spawn"), { code: "EACCES" }));
          setTimeout(() => child.emit("close", -1, null), 1); return; }
        child.emit("spawn");
        if (options.transitionMissing) setTimeout(() => child.emit("message",
          { type: "DIAGNOSTIC_DISPOSING", runId: deps.runId }), 50);
        if (options.earlyExit) finish(0);
        else if (!options.neverExit) setTimeout(() => {
          fs.writeFileSync(path.join(folder, "native-result.json"), JSON.stringify({
            runId: deps.runId, status: "PASS", blocks: [], recordCount: 0, expected: { width: 647 } }));
          fs.writeFileSync(path.join(folder, "quit.json"), JSON.stringify({ runId: deps.runId, status: "PASS", windows: 0 }));
          finish(0);
        }, options.exitMs ?? 20);
      });
      return child;
    }),
    observeProcess: () => {
      identityReads++;
      if (options.earlyExit) throw Object.assign(Error("gone"), { code: "ENOENT" });
      return { ...observation(), identity: { ...leader(),
        ...(options.foreignStop && identityReads > 1 ? { startTicks: "foreign" } : {}) } };
    },
    readGroup: () => {
      groupReads++;
      if (!alive && options.finalGroupThrows && ++drainReads > 1) throw fault("FINAL_GROUP_READ_FAILED");
      if (!alive && options.drainThrows) throw fault("ARTIFICIAL_DRAIN_ERROR");
      if (!alive) return inventory([]);
      if (options.monitorThrows && groupReads > 1) throw Object.assign(Error("monitor"), { code: "EACCES" });
      if (options.rssMissing) return inventory([observation({ kind: "UNKNOWN", reason: "RSS_FIELD_MISSING" })]);
      if (options.transitionMissing && groupReads > 1)
        return inventory([{ ...observation({ kind: "UNKNOWN", reason: "RSS_FIELD_MISSING" }), liveness: "EXIT_TRANSITION" }]);
      return inventory();
    },
    writer: (folder: string, root: string) => {
      const save = writer(folder, root);
      return (name: string, value: any) => {
        if (options.writeFails === name) throw fault("ARTIFICIAL_WRITER_ERROR");
        return save(name, value);
      };
    },
  };
  const task = stageRun(0, { inputSha256: "artificial" }, {}, directory,
    { renderer: "/artificial", verify: { verifyFrames: () => ({ status: "PASS" }) } },
    Date.now() + 100000, {}, false, deps);
  await vi.runAllTimersAsync();
  return { result: await task, child, deps, directory, folder, registered };
}
describe("actual stageRun orchestration with injected dependencies", () => {
  it("normal exit persists initial/owner/cleanup/result, and registers barriers before first await", async () => {
    const t = await artificialStage();
    expect(t.registered).toBe(true); expect(t.result.status).toBe("PASS");
    expect(t.result.child.exit).toBeTruthy(); expect(t.result.child.close).toBeTruthy();
    expect(t.result.cleanup.profileRemoved).toBe(true);
    for (const file of ["initial.json", "owned.json", "cleanup.json", "result.json"]) expect(fs.existsSync(path.join(t.folder, file))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(t.folder, "initial.json"), "utf8")).status).toBe("INCOMPLETE");
    expect(t.child.kill).not.toHaveBeenCalled();
  });
  for (const [name, options, expected] of [
    ["early exit", { earlyExit: true }, "ENOENT"],
    ["spawn error", { spawnError: true }, "EACCES"],
    ["running RSS failure", { rssMissing: true }, "RUNNING_RSS_UNKNOWN"],
    ["monitor exception", { monitorThrows: true, exitMs: 250 }, "EACCES"],
    ["wall timeout", { neverExit: true }, "WALL_TIMEOUT"],
  ] as const) it(`persists FAIL after ${name}`, async () => {
    const t = await artificialStage(options);
    expect(t.result.status).toBe("FAIL"); expect(t.result.primaryFault.reason).toBe(expected);
    expect(fs.existsSync(path.join(t.folder, "failure.json"))).toBe(true);
    expect(fs.existsSync(path.join(t.folder, "result.json"))).toBe(true);
    expect(t.child.kill.mock.calls.every((a: any[]) => a[0] === "SIGTERM")).toBe(true);
  });
  it("does not replace the monitor primary fault with stop/drain errors", async () => {
    const t = await artificialStage({ rssMissing: true, sendThrows: true, drainThrows: true });
    expect(t.result.primaryFault.reason).toBe("RUNNING_RSS_UNKNOWN");
    expect(t.result.cleanupFaults.map((r: any) => r.reason)).toContain("SEND_FAILED");
    expect(t.result.cleanupFaults.map((r: any) => r.reason)).toContain("ARTIFICIAL_DRAIN_ERROR");
    expect(t.result.cleanup.profileRemoved).toBe(false); expect(t.result.status).toBe("FAIL");
  });
  it("does not signal a replaced / unknown process", async () => {
    const t = await artificialStage({ rssMissing: true, foreignStop: true });
    expect(t.child.kill).not.toHaveBeenCalled(); expect(t.child.send).not.toHaveBeenCalled();
    expect(t.result.cleanupFaults.some((e: any) => e.reason.includes("SIGNAL_OWNER"))).toBe(true);
  });
  it("exit without close fails and never removes a possibly in-use profile", async () => {
    const t = await artificialStage({ closeMissing: true });
    expect(t.result.cleanupFaults.some((e: any) => e.reason === "STDIO_CLOSE_TIMEOUT")).toBe(true);
    expect(t.result.cleanup.profileRemoved).toBe(false); expect(t.result.child.exit).toBeTruthy();
  });
  it("permits a bounded exit-transition observation only after actual exit/close and empty-group confirmation", async () => {
    const t = await artificialStage({ transitionMissing: true, exitMs: 150 });
    expect(t.result.samples.some((s: any) => s.resource.kind === "UNKNOWN")).toBe(true);
    expect(t.result.status).toBe("PASS"); expect(t.result.cleanup.remaining).toBe(0);
    expect(t.result.child.exit).toBeTruthy(); expect(t.result.child.close).toBeTruthy();
  });
  it("a disposal acknowledgement cannot excuse indefinitely missing exit RSS", async () => {
    const t = await artificialStage({ transitionMissing: true, neverExit: true });
    expect(t.result.status).toBe("FAIL");
    expect(t.result.primaryFault.reason).toBe("EXIT_TRANSITION_UNCONFIRMED");
    expect(t.result.primaryFault.targetPid).toBe(7001);
  });
  it("a child ignoring both stop and SIGTERM is FAIL, retains its profile, and cannot hold the parent IPC open", async () => {
    const t = await artificialStage({ neverExit: true, ignoreStop: true });
    expect(t.result.primaryFault.reason).toBe("WALL_TIMEOUT");
    expect(t.result.child.exit).toBeNull(); expect(t.result.child.close).toBeNull();
    expect(t.result.cleanup.profileRemoved).toBe(false);
    expect(t.child.disconnect).toHaveBeenCalledTimes(1);
    expect(t.child.unref).toHaveBeenCalledTimes(1);
    expect(t.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("persists a final-inventory error and refuses profile removal", async () => {
    const t = await artificialStage({ finalGroupThrows: true });
    expect(t.result.status).toBe("FAIL");
    expect(t.result.cleanupFaults.some((e: any) => e.reason === "FINAL_GROUP_READ_FAILED")).toBe(true);
    expect(t.result.cleanup.profileRemoved).toBe(false);
    expect(fs.existsSync(path.join(t.folder, "failure.json"))).toBe(true);
  });
  for (const name of ["initial.json", "failure.json", "cleanup.json", "result.json"]) it(`preserves writer failure ${name}`, async () => {
    const t = await artificialStage({ rssMissing: true, writeFails: name });
    expect(t.result.status).toBe("FAIL");
    expect(t.result.evidenceFaults.some((e: any) => e.phase === `WRITE:${name}`)).toBe(true);
    if (name !== "initial.json") expect(t.result.primaryFault.reason).toBe("RUNNING_RSS_UNKNOWN");
  });
  it("includes failed stage in aggregate, leaves later stages NOT_RUN and returns nonzero", async () => {
    const t = await artificialStage({ rssMissing: true });
    const run = vi.fn(() => t.result), summary = await runStages([0, 1, 2], run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(summary.stages.map((s: any) => s.status)).toEqual(["FAIL", "NOT_RUN", "NOT_RUN"]);
    expect(exitCode(summary)).toBe(1);
  });
  it("also records a setup rejection rather than losing the stage", async () => {
    const s = await runStages([0, 1, 2], async () => { throw fault("SETUP_FAILED"); });
    expect(s.stages[0].primaryFault.reason).toBe("SETUP_FAILED");
    expect(s.stages[1].status).toBe("NOT_RUN"); expect(exitCode(s)).toBe(1);
  });
});
