import { registerHooks } from "node:module";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrialPaths } from "@workspace/tickstream-storage/live-trial-directory";
import type { CaptureMode } from "@workspace/tickstream-storage/live-authorization";
import type { BReason } from "./gateBConfig";
import type { B2CaptureReport, B2Reason } from "./gateB2Config";
import type { B2ManagedSocket } from "./gateB2Session";
import type { BEvent } from "./gateBTransport";

// Native Node must install the TS resolver BEFORE loading workspace modules
// containing extensionless imports. No other entry/import installs this hook.
const isEntry = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) resolution();
const { canonicalObservation } = await import("@workspace/tickstream-adapter/live-observation");
const { createTrial, DEFAULT_LIVE_ROOT, inspectTrial, prepareTrialRoot, purgeTrial,
  scanExpiredTrials, trialAuthorization, claimTrialLease, releaseTrialLease } =
  await import("@workspace/tickstream-storage/live-trial-directory");
const { recoverLive } = await import("@workspace/tickstream-storage/live-recovery");
const { TRIAL_ID } = await import("@workspace/tickstream-storage/live-authorization");
const { gateBWatchdog } = await import("./gateBProcess.ts");
const { GATE_B_SELECTED_TRIAL, LIMITS } = await import("./gateBConfig.ts");
const { b2FailureReason, B2_REASONS, parseB2Mode, readB2Capture } = await import("./gateB2Config.ts");

const confirmation = Object.freeze({ explicitMode: "GATE_B2B" as const, dataPermission: true,
  replitStoragePermission: true, manualCleanupConfirmed: true });
export interface B2Verification {
  status: "VERIFIED" | "TRUNCATED_TAIL" | "UNPUBLISHED_TAIL" | "PUBLISH_INTERRUPTED";
  manifestCount: number; logCount: number; finalCommitPosition: number; bytes: number;
  head: string; manifestChecksum: string; recordHash: string;
}
function readVerification(input: unknown): B2Verification | null {
  try {
    const r = input as B2Verification;
    if (!r || !["VERIFIED", "TRUNCATED_TAIL", "UNPUBLISHED_TAIL", "PUBLISH_INTERRUPTED"].includes(r.status) ||
      ![r.manifestCount, r.logCount, r.finalCommitPosition, r.bytes].every(n => Number.isSafeInteger(n) && n >= 0) ||
      r.manifestCount > 1000 || r.logCount > 1000 || r.bytes > LIMITS.payloadBytes ||
      ![r.head, r.manifestChecksum, r.recordHash].every(h => typeof h === "string" && /^[a-f0-9]{64}$/.test(h)) ||
      r.finalCommitPosition !== r.manifestCount) return null;
    return { status: r.status, manifestCount: r.manifestCount, logCount: r.logCount,
      finalCommitPosition: r.finalCommitPosition, bytes: r.bytes, head: r.head,
      manifestChecksum: r.manifestChecksum, recordHash: r.recordHash };
  } catch { return null; }
}
export interface IsolatedResult<T> {
  result: T | null; reason: B2Reason | null; forced: boolean;
  childRssPeak: number | null; totalRssPeak: number | null;
}
/** No market records over IPC. At most ACTIVE + RESULT, one START + REPORT_ACK,
 * and one STOP. Independent sampled watchdog survives a blocked writer loop. */
export async function isolatedB2<T>(input: {
  spawn: () => ChildProcess; decode: (value: unknown) => T | null;
  activeBudget?: boolean; budgetMs?: number; cleanupMs?: number;
}): Promise<IsolatedResult<T>> {
  const budget = input.budgetMs ?? LIMITS.wallMs, cleanup = input.cleanupMs ?? LIMITS.cleanupMs;
  if (!Number.isInteger(budget) || budget < 1 || budget > LIMITS.wallMs ||
    !Number.isInteger(cleanup) || cleanup < 1 || cleanup > LIMITS.cleanupMs) throw Error("B2_UNSAFE_BUDGET");
  const started = performance.now(), startNs = process.hrtime.bigint();
  let child: ChildProcess;
  try { child = input.spawn(); } catch { return { result: null, reason: "B2_CHILD_FAILURE", forced: false, childRssPeak: null, totalRssPeak: null }; }
  return await new Promise(resolveDone => {
    let result: T | null = null, reason: B2Reason | null = null, stopping: number | null = null;
    let active: bigint | null = null, reportAt: number | null = null, done = false, forced = false;
    let messages = 0, peak = 0, totalPeak = 0, cancel = () => {};
    const stop = (code: B2Reason) => {
      reason ??= code;
      if (stopping !== null) return;
      stopping = performance.now();
      try { child.send({ type: "STOP", reason: code }, () => {}); } catch { child.kill("SIGTERM"); }
    };
    const sample = () => {
      if (done) return;
      let rss: number | null = null, parent: number | null = null, processGone = false;
      try {
        const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
        const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        processGone = !m && /^State:\s+[ZX]/m.test(status);
        rss = m ? Number(m[1]) * 1024 : null; parent = process.memoryUsage().rss;
      } catch (error) { processGone = (error as NodeJS.ErrnoException).code === "ENOENT"; }
      if (rss !== null && parent !== null) { peak = Math.max(peak, rss); totalPeak = Math.max(totalPeak, rss + parent); }
      const now = performance.now();
      if (input.activeBudget && active !== null &&
        process.hrtime.bigint() - active >= BigInt(LIMITS.activeMs) * 1_000_000n) stop("ACTIVE_TIME_LIMIT");
      // Linux can remove VmRSS/proc before Node delivers the exit event. Only
      // after a validated final message, and with prior REAL RSS samples, wait
      // for that event (still bounded by cleanup). Never invent a zero sample or
      // suppress a missing measurement from an alive/non-finalized process.
      if (processGone && reportAt !== null && peak > 0 && now - reportAt < cleanup) return;
      const decision = gateBWatchdog({ elapsedMs: now - started, stoppingMs: stopping === null ? null : now - stopping,
        rss, totalRss: rss !== null && parent !== null ? rss + parent : null },
      { ...LIMITS, wallMs: budget, cleanupMs: cleanup });
      if (reportAt !== null && now - reportAt >= cleanup || decision.kind === "KILL") {
        reason ??= decision.kind === "KILL" ? decision.reason : "FORCED_TERMINATION";
        forced = true; child.kill("SIGKILL");
      } else if (decision.kind === "STOP") stop(decision.reason);
    };
    const interrupt = () => stop("CTRL_C"); process.once("SIGINT", interrupt);
    child.on("message", value => {
      if (++messages > 2) { stop("B2_IPC_INVALID"); return; }
      try {
        if (Buffer.byteLength(JSON.stringify(value)) > 16384) { stop("B2_IPC_INVALID"); return; }
        const m = value as { type?: unknown; atNs?: unknown; value?: unknown };
        if (m?.type === "ACTIVE" && input.activeBudget && active === null && reportAt === null &&
          typeof m.atNs === "string" && /^[0-9]{1,30}$/.test(m.atNs) && BigInt(m.atNs) >= startNs &&
          BigInt(m.atNs) <= process.hrtime.bigint()) { active = BigInt(m.atNs); return; }
        if (m?.type === "FAILURE" && reportAt === null && typeof m.value === "string" && B2_REASONS.includes(m.value)) {
          reason ??= m.value as B2Reason; reportAt = performance.now();
          child.send({ type: "REPORT_ACK" }, () => {}); return;
        }
        if (m?.type !== "RESULT" || reportAt !== null) { stop("B2_IPC_INVALID"); return; }
        result = input.decode(m.value);
        if (!result) { stop("B2_IPC_INVALID"); return; }
        reportAt = performance.now();
        child.send({ type: "REPORT_ACK" }, () => {});
      } catch { result = null; stop("B2_IPC_INVALID"); }
    });
    child.once("error", () => stop("B2_CHILD_FAILURE"));
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return; done = true; cancel(); process.removeListener("SIGINT", interrupt);
      if (code !== 0 || signal || result === null) reason ??= "B2_CHILD_FAILURE";
      if (peak === 0 || totalPeak === 0) reason ??= "MEMORY_NOT_MEASURED";
      resolveDone({ result, reason, forced, childRssPeak: peak || null, totalRssPeak: totalPeak || null });
    };
    child.once("exit", finish); child.once("close", finish);
    const timer = setInterval(sample, 50); cancel = () => clearInterval(timer);
    sample();
    try { child.send({ type: "START" }, () => {}); } catch { stop("B2_IPC_INVALID"); }
  });
}
/** Probes ONLY artificial canary bytes, never a market-data path. A successful
 * HTTP read (including a SPA fallback) is conservatively rejected. */
export async function privateProbe(root = DEFAULT_LIVE_ROOT,
  request: (url: string) => Promise<number> = async url => {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    await r.body?.cancel(); return r.status;
  }): Promise<{ passed: true; probes: number; remainingFiles: 0 }> {
  const id = randomUUID(), p = createTrial(root, id, "ARTIFICIAL_PROTOCOL_TEST");
  const canary = join(p.data, "privacy-canary");
  let probes = 0;
  try {
    writeFileSync(canary, "ARTIFICIAL_PRIVACY_CANARY", { flag: "wx", mode: 0o600 });
    // These are the existing artifact preview mounts; not guessed SPA routes.
    for (const prefix of ["", "/__mockup", "/api"]) {
      for (const slash of ["", "/"]) {
        const status = await request(`http://127.0.0.1:80${prefix}/@fs/${slash}${canary.slice(1)}`);
        if (![403, 404].includes(status)) throw Object.assign(Error("B2_PRIVATE_PROBE_FAILED"), { code: "B2_PRIVATE_PROBE_FAILED" });
        probes++;
      }
    }
    const proof = { passed: true as const, probes, remainingFiles: 0 as const };
    if (root === DEFAULT_LIVE_ROOT) privateProofs.add(proof);
    return proof;
  } finally {
    // Constant basename within a newly created owned directory, not rm -rf.
    if (existsSync(canary)) unlinkSync(canary);
    purgeTrial(root, id);
  }
}
const privateProofs = new WeakSet<object>();
function resolution(): void {
  registerHooks({ resolve(s, c, next) {
    try { return next(s, c); } catch (error) {
      if (s.startsWith(".") && !/\.[a-z]+$/i.test(s)) return next(`${s}.ts`, c);
      throw error;
    }
  } });
}
function artificialSocket(): B2ManagedSocket {
  let listener: (e: BEvent) => void = () => {}, resolveClosed = () => {};
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  return { closed, forcedCleanup: false, listen: cb => { listener = cb; },
    connect: () => listener({ type: "open" }),
    subscribe: () => {
      listener({ type: "subscriptionSent" });
      const tick = JSON.stringify({ type: "tick", symbol: "NQ", ts: Math.floor(Date.now() / 1000),
        price: 20000.25, size: 12, side: "buy", exch: "CME" });
      queueMicrotask(() => { for (let n = 0; n < 2; n++) listener({ type: "text", bytes: Buffer.from(tick) }); });
    },
    jsonPong: () => {}, close: resolveClosed, terminate: resolveClosed };
}
type WorkerKind = "capture" | "verify" | "purge";
function launchWorker(phase: WorkerKind, id: string, mode: CaptureMode, key?: string): ChildProcess {
  return fork(fileURLToPath(import.meta.url), ["--b2-worker", phase, id, mode], {
    env: phase === "capture" && mode === "PRODUCTION" ? { TICKSTREAM_API_KEY: key! } : {},
    execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--max-old-space-size=192"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}
type PurgeReport = ReturnType<typeof purgeTrial>;
function readPurge(value: unknown, id: string): PurgeReport | null {
  const r = value as PurgeReport | null;
  return r?.trialId === id && r.deleted === true && r.remainingFiles === 0 ?
    { trialId: id, deleted: true, remainingFiles: 0 } : null;
}
async function worker(kind: WorkerKind, id: string, mode: CaptureMode): Promise<void> {
  let started = false, sent = false, stop: ((r: BReason) => void) | undefined, pendingStop: BReason | undefined;
  const send = (value: unknown, type = "RESULT") => {
    if (sent) return; sent = true;
    const timer = setTimeout(() => { process.disconnect?.(); process.exitCode = 1; }, LIMITS.cleanupMs);
    process.on("message", m => { if ((m as { type?: unknown })?.type === "REPORT_ACK") { clearTimeout(timer); process.disconnect?.(); } });
    process.send?.({ type, value });
  };
  process.on("message", async m => {
    if ((m as { type?: unknown })?.type === "STOP") {
      const reason = (m as { reason?: unknown }).reason;
      pendingStop = B2_REASONS.includes(reason as string) ? reason as BReason : "FORCED_TERMINATION";
      stop?.(pendingStop); return;
    }
    if ((m as { type?: unknown })?.type !== "START" || started) return;
    started = true;
    let leased: TrialPaths | undefined;
    try {
      if (kind === "purge") { send(purgeTrial(DEFAULT_LIVE_ROOT, id)); return; }
      const p = inspectTrial(DEFAULT_LIVE_ROOT, id);
      if (p.marker.captureMode !== mode || scanExpiredTrials().length) throw Object.assign(Error(), { code: "TRIAL_EXPIRED_CLEANUP_REQUIRED" });
      const authorization = trialAuthorization(p, confirmation);
      claimTrialLease(p); leased = p;
      if (kind === "verify") {
        const content = createHash("sha256");
        const r = recoverLive(p.data, record => { content.update(canonicalObservation(record)); content.update("\n"); }, authorization);
        send({ status: r.status, manifestCount: r.persistedCount, logCount: r.verifiedCount,
          finalCommitPosition: r.manifest.count, bytes: r.manifest.bytes, head: r.manifest.head,
          manifestChecksum: r.manifest.checksum, recordHash: content.digest("hex") } satisfies B2Verification);
        return;
      }
      const { runGateB2Session } = await import("./gateB2Session.ts");
      let target: Parameters<typeof runGateB2Session>[0];
      if (mode === "PRODUCTION") {
        const key = process.env.TICKSTREAM_API_KEY;
        if (!key || key.length > 4096) throw Object.assign(Error(), { code: "KEY_NOT_CONFIGURED" });
        target = { kind: "PRODUCTION", review: GATE_B_SELECTED_TRIAL, explicitExecution: true, secret: key };
      } else target = { kind: "LOOPBACK_TEST", endpoint: "ws://127.0.0.1:1/" };
      const result = await runGateB2Session(target, authorization, {
        ...(mode === "ARTIFICIAL_PROTOCOL_TEST" ? { finishAfter: 2, artificial: { socketFactory: artificialSocket } } : {}),
        onActive: atNs => process.send?.({ type: "ACTIVE", atNs }),
        onStopReady: cb => { stop = cb; if (pendingStop) cb(pendingStop); },
      });
      send(result);
    } catch (error) { send(b2FailureReason(error, "B2_CHILD_FAILURE"), "FAILURE"); process.exitCode = 1; }
    finally {
      if (leased) {
        try { releaseTrialLease(leased); } catch { process.exitCode = 1; }
      }
    }
  });
  process.once("SIGTERM", () => { pendingStop = "CTRL_C"; stop?.("CTRL_C"); });
  process.once("disconnect", () => { pendingStop = "CHILD_FAILURE"; stop?.("CHILD_FAILURE"); });
}
export async function runB2Trial(mode: CaptureMode, key?: string, privacyProof?: object,
  onCreated?: (info: Readonly<{ trialId: string; captureMode: CaptureMode; deleteByMs: number }>) => void) {
  if (mode === "PRODUCTION" && (!privacyProof || !privateProofs.has(privacyProof))) {
    throw Object.assign(Error(), { code: "B2_PRIVATE_PROBE_FAILED" });
  }
  if (mode === "PRODUCTION" && (!key || key.length > 4096)) throw Object.assign(Error(), { code: "KEY_NOT_CONFIGURED" });
  if (scanExpiredTrials().length) throw Object.assign(Error(), { code: "TRIAL_EXPIRED_CLEANUP_REQUIRED" });
  const id = randomUUID(), p = createTrial(DEFAULT_LIVE_ROOT, id, mode);
  const started = performance.now();
  let capture: B2CaptureReport | null = null, recovery: B2Verification | null = null;
  let reason: B2Reason | null = null, cleanup: ReturnType<typeof purgeTrial> | null = null;
  try {
    // Publish ONLY deletion metadata before capture. If this parent is killed,
    // the operator still knows the exact one-trial target and hard deadline.
    onCreated?.(Object.freeze({ trialId: id, captureMode: mode, deleteByMs: p.marker.deleteByMs }));
    const c = await isolatedB2({ spawn: () => launchWorker("capture", id, mode, key), decode: readB2Capture,
      activeBudget: true, budgetMs: LIMITS.wallMs - LIMITS.cleanupMs });
    capture = c.result;
    const normalActiveStop = c.reason === "ACTIVE_TIME_LIMIT" && !c.forced &&
      capture?.phase === "STOPPED" && capture.reason === "ACTIVE_TIME_LIMIT";
    reason = (normalActiveStop ? null : c.reason) ?? (capture?.phase === "FAILED" ? capture.reason : null);
    if (capture) {
      capture.transport.memory = { measurement: c.childRssPeak !== null && c.totalRssPeak !== null ? "MEASURED" : "NOT_MEASURED",
        childRssPeak: c.childRssPeak, totalRssPeak: c.totalRssPeak };
      capture.transport.supervisorForcedTermination = c.forced;
    }
    const remaining = LIMITS.wallMs - Math.ceil(performance.now() - started) - LIMITS.cleanupMs;
    if (remaining <= LIMITS.cleanupMs) reason ??= "WALL_TIME_LIMIT";
    else {
      const v = await isolatedB2({ spawn: () => launchWorker("verify", id, mode), decode: readVerification, budgetMs: remaining });
      recovery = v.result; reason ??= v.reason;
      if (!recovery || recovery.status !== "VERIFIED") reason ??= "B2_VERIFY_FAILED";
      else if (capture && (capture.commit.position !== recovery.manifestCount ||
        capture.commit.head !== recovery.head || capture.commit.bytes !== recovery.bytes)) reason ??= "B2_RECOVERY_MISMATCH";
    }
  } catch (error) { reason ??= b2FailureReason(error, "B2_CHILD_FAILURE"); }
  finally {
    key = undefined;
    try {
      const deleted = await isolatedB2({ spawn: () => launchWorker("purge", id, mode), decode: value => readPurge(value, id),
        budgetMs: LIMITS.cleanupMs, cleanupMs: 100 });
      cleanup = deleted.result; reason ??= deleted.reason;
      if (!cleanup) reason ??= "B2_DELETE_FAILED";
    }
    catch (error) { reason ??= b2FailureReason(error, "B2_DELETE_FAILED"); }
  }
  return { schema: "TICKSTREAM_GATE_B2B_TRIAL_V1", captureMode: mode, trialId: id,
    phase: reason ? "FAILED" : "COMPLETED", reason: reason ?? capture?.reason ?? "COMPLETED",
    capture, recovery, cleanup, elapsedWallMs: Math.ceil(performance.now() - started),
    deletionWhileStopped: "NOT_GUARANTEED_MANUAL_CONFIRMATION_REQUIRED" };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 4 && args[0] === "--b2-worker" && ["capture", "verify", "purge"].includes(args[1]) &&
    TRIAL_ID.test(args[2]) && ["PRODUCTION", "ARTIFICIAL_PROTOCOL_TEST"].includes(args[3]) && process.send) {
    await worker(args[1] as WorkerKind, args[2], args[3] as CaptureMode); return;
  }
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const mode = parseB2Mode(args);
  if (mode === "PURGE") {
    const p = inspectTrial(DEFAULT_LIVE_ROOT, args[1]);
    const deleted = await isolatedB2({ spawn: () => launchWorker("purge", p.trialId, p.marker.captureMode),
      decode: value => readPurge(value, p.trialId), budgetMs: LIMITS.cleanupMs, cleanupMs: 100 });
    if (!deleted.result || deleted.reason) throw Object.assign(Error(), { code: deleted.reason ?? "B2_DELETE_FAILED" });
    output({ schema: "TICKSTREAM_TRIAL_DELETE_V1", ...deleted.result }); return;
  }
  const expired = scanExpiredTrials();
  if (expired.length) {
    output({ phase: "HOLD", reason: "TRIAL_EXPIRED_CLEANUP_REQUIRED", expiredTrialIds: expired,
      deletionWhileStopped: "NOT_GUARANTEED_MANUAL_CONFIRMATION_REQUIRED" }); return;
  }
  if (mode === "HOLD") { output({ phase: "HOLD", reason: "LIVE_MODE_REQUIRED" }); return; }
  prepareTrialRoot(DEFAULT_LIVE_ROOT, true);
  const privacy = await privateProbe();
  if (mode === "PREFLIGHT") { output({ schema: "TICKSTREAM_STORAGE_PREFLIGHT_V1", ...privacy }); return; }
  // This is the ONLY parent key access; wrong flags / failed preflight / expiry
  // never inspect Secrets. Offline trials do not even test key existence.
  const key = mode === "LIVE" ? process.env.TICKSTREAM_API_KEY : undefined;
  const result = await runB2Trial(mode === "LIVE" ? "PRODUCTION" : "ARTIFICIAL_PROTOCOL_TEST", key, privacy,
    info => output({ schema: "TICKSTREAM_GATE_B2B_START_V1", ...info }));
  output(result); if (result.phase === "FAILED") process.exitCode = 1;
}
if (isEntry) {
  void main().catch(error => {
    process.stdout.write(JSON.stringify({ phase: "HOLD", reason: b2FailureReason(error, "B2_CHILD_FAILURE"),
      cleanup: null, deletionWhileStopped: "NOT_GUARANTEED_MANUAL_CONFIRMATION_REQUIRED" }) + "\n");
    process.exitCode = 1;
  });
}
