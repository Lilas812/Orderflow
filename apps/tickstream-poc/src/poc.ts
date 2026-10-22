import { registerHooks } from "node:module";
import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Node 24's native TS transformer plus extension resolution for the unchanged
 * workspace TS exports. No tsx, compilation output, network client or env reader.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { syntheticSession, watchdog, unavailableReport } = await import("./session.ts");
const { Diagnostics, readReport } = await import("./diagnostics.ts");
const { LIMITS } = await import("./transport.ts");

function output(report: unknown): void {
  process.stdout.write(`${JSON.stringify(readReport(report) ?? unavailableReport("SESSION_FAILURE"))}\n`);
}

if (process.argv[2] === "--synthetic-child" && process.send) {
  // Synthetic source: no key access, no socket constructor, no network imports.
  // Stay alive until the parent samples RSS and acknowledges the one report.
  const ackDeadline = setTimeout(() => { process.disconnect?.(); process.exitCode = 1; }, LIMITS.cleanupMs);
  process.once("message", message => {
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "REPORT_ACK") {
      clearTimeout(ackDeadline); process.disconnect?.();
    }
  });
  try {
    const report = syntheticSession();
    process.send(report);
  } catch {
    process.send(unavailableReport("SESSION_FAILURE"));
    process.exitCode = 1;
  }
} else if (process.argv.length !== 2) {
  output(unavailableReport("SESSION_FAILURE"));
  process.exitCode = 1;
} else {
  const started = performance.now();
  const diagnostics = new Diagnostics();
  let childReport: ReturnType<typeof syntheticSession> | undefined;
  let stopAt: number | null = null;
  let stopReason: Parameters<typeof unavailableReport>[0] | null = null;
  let reportAt: number | null = null;
  // Environment allowlist is empty: no Secrets inherited, inspected or forwarded.
  const child = fork(fileURLToPath(import.meta.url), ["--synthetic-child"], {
    env: {}, execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--max-old-space-size=192"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const requestStop = (reason: Parameters<typeof unavailableReport>[0]): void => {
    if (stopAt !== null) return;
    stopAt = performance.now(); stopReason = reason;
    // No raw input is ever sent over IPC. Synthetic child is finite/synchronous;
    // terminate it rather than relying on its event loop to acknowledge.
    child.kill("SIGTERM");
  };
  const interrupt = (): void => requestStop("CTRL_C");
  process.once("SIGINT", interrupt);
  let done = false;
  const sample = (): void => {
    if (done) return;
    if (childReport) {
      if (performance.now() - started >= LIMITS.wallMs ||
        (reportAt !== null && performance.now() - reportAt >= LIMITS.cleanupMs)) {
        stopReason = "FORCED_TERMINATION"; child.kill("SIGKILL");
      }
      return;
    }
    let rss: number | null = null;
    try {
      if (child.pid) {
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${child.pid}/status`, "utf8"));
        if (match) rss = Number(match[1]) * 1024;
      }
    } catch { /* Missing/unreadable metrics are never fabricated as zero. */ }
    const total = rss === null ? null : rss + process.memoryUsage().rss;
    diagnostics.memory(rss, total);
    const action = watchdog({
      elapsedMs: performance.now() - started,
      stopElapsedMs: stopAt === null ? null : performance.now() - stopAt,
      sessionRss: rss, totalRss: total,
    });
    if (action.kind === "REQUEST_STOP") requestStop(action.reason);
    if (action.kind === "FORCE_TERMINATE") {
      stopReason = "FORCED_TERMINATION"; child.kill("SIGKILL");
    }
  };
  // Trusted child sends exactly one fixed-schema report, never messages/raw data.
  child.on("message", message => {
    if (childReport || stopReason !== null) return;
    const report = readReport(message);
    if (report && JSON.stringify(report).length < 16_384) {
      sample();
      if (stopReason !== null) return;
      childReport = report; reportAt = performance.now();
      child.send({ type: "REPORT_ACK" }, error => { if (error) requestStop("SESSION_FAILURE"); });
    } else requestStop("SESSION_FAILURE");
  });
  const interval = setInterval(sample, 100);
  const complete = (successful: boolean): void => {
    if (done) return;
    done = true; clearInterval(interval); process.removeListener("SIGINT", interrupt);
    const memory = diagnostics.report("STOPPED", "COMPLETED", 0).memory;
    const report = stopReason ? unavailableReport(stopReason) :
      successful && childReport ? childReport : unavailableReport("SESSION_FAILURE");
    output({ ...report, memory });
    if (report.state !== "STOPPED") process.exitCode = 1;
  };
  child.once("error", () => { requestStop("SESSION_FAILURE"); complete(false); });
  child.once("exit", code => complete(code === 0));
  sample();
}
