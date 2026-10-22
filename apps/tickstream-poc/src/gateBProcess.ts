import { registerHooks } from "node:module";
import { fork, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BReason, GateBReport, GateBReview } from "./gateBConfig";

export function gateBWatchdog(input: {
  elapsedMs: number; stoppingMs: number | null; rss: number | null; totalRss: number | null;
}, limits: { wallMs: number; cleanupMs: number; sessionRss: number; totalRss: number }) {
  if (input.stoppingMs !== null) return input.stoppingMs >= limits.cleanupMs ?
    { kind: "KILL" as const, reason: "FORCED_TERMINATION" as const } : { kind: "CONTINUE" as const };
  if (input.elapsedMs >= limits.wallMs) return { kind: "KILL" as const, reason: "WALL_TIME_LIMIT" as const };
  if (input.elapsedMs >= limits.wallMs - limits.cleanupMs) return { kind: "STOP" as const, reason: "WALL_TIME_LIMIT" as const };
  if (input.rss === null || input.totalRss === null || !Number.isSafeInteger(input.rss) ||
    !Number.isSafeInteger(input.totalRss) || input.rss < 0 || input.totalRss < input.rss) {
    return { kind: "STOP" as const, reason: "MEMORY_NOT_MEASURED" as const };
  }
  if (input.rss > limits.sessionRss || input.totalRss > limits.totalRss) {
    return { kind: "STOP" as const, reason: "MEMORY_THRESHOLD" as const };
  }
  return { kind: "CONTINUE" as const };
}
/** Only this dedicated, approved launcher and its isolated worker handle a key.
 * A HOLD never calls readKey/startWorker. No key is returned or put into reports. */
export async function executeGateB(input: {
  review: GateBReview; explicitExecution: boolean; readKey: () => unknown;
  startWorker: (key: string) => Promise<GateBReport>;
}): Promise<GateBReport> {
  const { reviewGateB, emptyGateBReport, readGateBReport } = await import("./gateBConfig.ts");
  const holds = reviewGateB(input.review, input.explicitExecution);
  if (holds.length) return emptyGateBReport("HOLD", holds);
  let key: unknown;
  try { key = input.readKey(); } catch { return emptyGateBReport("HOLD", ["KEY_NOT_CONFIGURED"]); }
  if (typeof key !== "string" || !key.length || key.length > 4096) return emptyGateBReport("HOLD", ["KEY_NOT_CONFIGURED"]);
  try { return readGateBReport(await input.startWorker(key)) ?? emptyGateBReport("IPC_INVALID"); }
  catch { return emptyGateBReport("CHILD_FAILURE"); }
  finally { key = undefined; }
}
export async function superviseGateB(input: {
  spawnWorker: () => ChildProcess; rss: (pid: number) => number | null;
  parentRss: () => number; now?: () => number;
  every?: (callback: () => void) => () => void;
}): Promise<GateBReport> {
  const { LIMITS, emptyGateBReport, readGateBReport } = await import("./gateBConfig.ts");
  const now = input.now ?? (() => performance.now()), started = now();
  let child: ChildProcess;
  try { child = input.spawnWorker(); } catch { return emptyGateBReport("CHILD_FAILURE"); }
  return await new Promise<GateBReport>(resolveDone => {
    let report: GateBReport | null = null, stopAt: number | null = null, stopReason: BReason | null = null;
    let reportAt: number | null = null, done = false, messages = 0, childPeak = 0, parentPeak = 0, totalPeak = 0, forced = false;
    let memoryFailed = false;
    let cancel = () => {};
    const stop = (reason: BReason) => {
      if (stopAt !== null) return;
      stopAt = now(); stopReason = reason;
      try { child.send?.({ type: "STOP", reason }, () => {}); } catch { child.kill("SIGTERM"); }
    };
    const sample = () => {
      if (done) return;
      let rss: number | null = null, parent: number | null = null;
      try { rss = child.pid ? input.rss(child.pid) : null; parent = input.parentRss(); } catch {}
      const total = rss !== null && parent !== null ? rss + parent : null;
      if (rss !== null && total !== null && Number.isSafeInteger(rss) && Number.isSafeInteger(total) && rss >= 0 && parent! >= 0) {
        childPeak = Math.max(childPeak, rss); totalPeak = Math.max(totalPeak, total);
        parentPeak = Math.max(parentPeak, parent!);
      }
      if (reportAt !== null && now() - reportAt >= LIMITS.cleanupMs) {
        stopReason = "FORCED_TERMINATION"; forced = true; child.kill("SIGKILL"); return;
      }
      const decision = gateBWatchdog({ elapsedMs: now() - started,
        stoppingMs: stopAt === null ? null : now() - stopAt, rss, totalRss: total }, LIMITS);
      if (decision.kind !== "CONTINUE" && decision.reason === "MEMORY_NOT_MEASURED") memoryFailed = true;
      if (decision.kind === "STOP") stop(decision.reason);
      if (decision.kind === "KILL") {
        stopReason ??= decision.reason; forced = true; child.kill("SIGKILL");
      }
    };
    const interrupt = () => stop("CTRL_C");
    process.once("SIGINT", interrupt);
    child.on("message", message => {
      if (++messages !== 1) { stop("IPC_INVALID"); return; }
      report = readGateBReport(message);
      if (!report || report.execution !== "PRODUCTION") { report = null; stop("IPC_INVALID"); return; }
      reportAt = now();
      sample();
      if ((report.memory.childRssPeak ?? 0) > LIMITS.sessionRss) stop("MEMORY_THRESHOLD");
      try { child.send({ type: "REPORT_ACK" }, () => {}); } catch { stop("IPC_INVALID"); }
    });
    child.on("error", () => stop("CHILD_FAILURE"));
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true; cancel(); process.removeListener("SIGINT", interrupt);
      const result = report ?? emptyGateBReport(stopReason ?? "CHILD_FAILURE");
      if (stopReason || code !== 0 || signal) {
        result.phase = "FAILED"; result.stopReason = stopReason ?? "CHILD_FAILURE";
      }
      if (!report) result.execution = "PRODUCTION"; // attempted, no fabricated received counters
      result.elapsedWallMs = Math.max(0, Math.floor(now() - started));
      result.supervisorForcedTermination = forced;
      const maximumChild = Math.max(childPeak, result.memory.childRssPeak ?? 0);
      // Conservative sum of separately sampled process peaks, not a claim of
      // exact simultaneous/OS-enforced RAM consumption.
      const conservativeTotal = Math.max(totalPeak, maximumChild + parentPeak);
      result.memory = {
        measurement: !memoryFailed && childPeak > 0 && totalPeak > 0 ? "MEASURED" : "NOT_MEASURED",
        childRssPeak: maximumChild || null, totalRssPeak: conservativeTotal || null,
      };
      if (conservativeTotal > LIMITS.totalRss) { result.phase = "FAILED"; result.stopReason = "MEMORY_THRESHOLD"; }
      resolveDone(readGateBReport(result) ?? emptyGateBReport("IPC_INVALID"));
    };
    child.once("exit", finish);
    child.once("close", finish); // spawn failures need not produce an exit event
    cancel = input.every ? input.every(sample) : (() => {
      const timer = setInterval(sample, 50); return () => clearInterval(timer);
    })();
    sample();
  });
}
function installResolution(): void {
  registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
      throw error;
    }
  } });
}
async function main(): Promise<void> {
  const { GATE_B_REVIEW, GATE_B_SELECTED_TRIAL, reviewGateB, emptyGateBReport, readGateBReport, B_REASONS, LIMITS } = await import("./gateBConfig.ts");
  const selected = process.argv.length === 4 && process.argv[2] === "--execute-gate-b1" &&
    process.argv[3] === "--user-selected-streaming";
  const selectedChild = process.argv.length === 3 && process.argv[2] === "--gate-b1-child-selected-streaming" && !!process.send;
  const childMode = process.argv.length === 3 && process.argv[2] === "--gate-b1-child" && !!process.send || selectedChild;
  const approved = selected || process.argv.length === 3 && process.argv[2] === "--execute-gate-b1";
  const review = selected || selectedChild ? GATE_B_SELECTED_TRIAL : GATE_B_REVIEW;
  const output = (r: GateBReport) => process.stdout.write(`${JSON.stringify(readGateBReport(r) ?? emptyGateBReport("IPC_INVALID"))}\n`);
  if (childMode) {
    let sent = false, stopReady: ((reason: BReason) => void) | undefined, pendingStop: BReason | undefined;
    const send = (r: GateBReport) => {
      if (sent) return; sent = true;
      const timer = setTimeout(() => { process.disconnect?.(); process.exitCode = 1; }, LIMITS.cleanupMs);
      process.on("message", message => {
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "REPORT_ACK") {
          clearTimeout(timer); process.disconnect?.();
        }
      });
      process.send?.(readGateBReport(r) ?? emptyGateBReport("IPC_INVALID"));
    };
    const holds = reviewGateB(review, true);
    if (holds.length) { send(emptyGateBReport("HOLD", holds)); return; } // no key access
    process.on("message", message => {
      if (!message || typeof message !== "object") return;
      const m = message as { type?: unknown; reason?: unknown };
      if (m.type === "STOP" && B_REASONS.includes(m.reason as BReason)) {
        pendingStop = m.reason as BReason; stopReady?.(pendingStop);
      }
    });
    process.once("SIGTERM", () => { pendingStop = "CTRL_C"; stopReady?.("CTRL_C"); });
    try {
      const secret = process.env.TICKSTREAM_API_KEY; // isolated, authorised worker only
      if (!secret) { send(emptyGateBReport("HOLD", ["KEY_NOT_CONFIGURED"])); return; }
      const { runGateBSession } = await import("./gateBSession.ts");
      const report = await runGateBSession({ kind: "PRODUCTION", review, explicitExecution: true, secret },
        { onStopReady: stop => { stopReady = stop; if (pendingStop) stop(pendingStop); } });
      send(report);
    } catch { send(emptyGateBReport("CHILD_FAILURE")); }
    return;
  }
  const report = await executeGateB({
    review, explicitExecution: approved,
    readKey: () => process.env.TICKSTREAM_API_KEY, // never called while current review is HOLD
    startWorker: async key => {
      const result = await superviseGateB({
      spawnWorker: () => fork(fileURLToPath(import.meta.url), [selected ? "--gate-b1-child-selected-streaming" : "--gate-b1-child"], {
        env: { TICKSTREAM_API_KEY: key }, // no other Secrets, proxy, NODE_OPTIONS or DEBUG inherited
        execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--max-old-space-size=192"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
      rss: pid => {
        try {
          const text = readFileSync(`/proc/${pid}/status`, "utf8");
          const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
          return match ? Number(match[1]) * 1024 : null;
        } catch { return null; }
      },
      parentRss: () => process.memoryUsage().rss,
      });
      result.endpointBasis = review.authority === "USER_SELECTED_OFFICIAL_STREAMING" ?
        "USER_SELECTED_OFFICIAL_STREAMING" : "INDEPENDENTLY_CONFIRMED";
      return result;
    },
  });
  if (selected) report.endpointBasis = "USER_SELECTED_OFFICIAL_STREAMING";
  output(report);
  if (report.phase === "FAILED") process.exitCode = 1;
}
// Import/build/test has no startup side effects. Only this explicit CLI is runnable.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installResolution();
  void main().catch(() => {
    process.stdout.write('{"schema":"TICKSTREAM_GATE_B1_V1","stopReason":"CHILD_FAILURE","counters":null}\n');
    process.exitCode = 1;
  });
}
