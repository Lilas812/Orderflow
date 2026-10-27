import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { browser, delay } from "./cdp.ts";
import { WebSocket as DiagnosticSocket } from "ws";
import { processStart } from "../../src/diagnostics/isolation.ts";
import { staticProxy } from "./static-proxy.ts";

const exec = promisify(execFile);
const phase = process.argv[2] ?? "before";
const scenario = process.argv[3] ?? "live";
const root = path.resolve("data/perf-memory", phase, `${scenario}-${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const marker = path.resolve("data/perf-memory/isolation.json");
await fs.writeFile(marker, JSON.stringify({ ownerPid: process.pid, ownerStart: processStart(process.pid) }));
const statusUrl = "http://127.0.0.1:8080/api/status";
// Same path-routing proxy as the screenshot tool; avoid transient public
// network failures while Chromium imports the app's ES modules.
// Test-only static page on the API origin: native Chromium WebSocket connects
// directly to the real service, without the shared preview upgrade proxy.
const appUrl = "http://127.0.0.1:19090/";
const startedAtUs = Date.now() * 1000;
let stopped = false, guard = false, pid: number | null = null;
let sampleBusy = false, previousCpu: { ticks: number; at: number } | null = null;
let finalStatus: any = null, interrupted = false;
let allowedClients: number | null = null, isolationFailure = false;
const events: unknown[] = [];
const note = (event: string, details: object = {}) => {
  const value = { atUs: Date.now() * 1000, event, ...details };
  events.push(value); process.stdout.write(JSON.stringify(value) + "\n");
};
async function findPid(): Promise<number | null> {
  const { stdout } = await exec("ps", ["-eo", "pid,args"]);
  const match = stdout.split("\n").map(line => line.trim().match(/^(\d+)\s+(?:\S*\/)?node src\/index\.ts$/)).find(Boolean);
  return match ? Number(match[1]) : null;
}
async function sample() {
  if (sampleBusy || stopped) return;
  sampleBusy = true;
  try {
    pid ??= await findPid();
    let resource: any = null;
    if (pid) {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(fields[11]) + Number(fields[12]);
        const at = Date.now();
        const text = await fs.readFile(`/proc/${pid}/status`, "utf8");
        resource = { pid, rssKiB: Number(text.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0),
          rssHighWaterKiB: Number(text.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0),
          cpuPercent: previousCpu ? (ticks - previousCpu.ticks) / ((at - previousCpu.at) / 1000) : null };
        previousCpu = { ticks, at }; // Linux CLK_TCK=100; percentage cancels the 100.
        if (resource.rssKiB > 1536 * 1024 && !guard) {
          guard = true; note("rss_guard", resource); process.kill(pid, "SIGTERM");
        }
      } catch { resource = { pid, exited: true }; interrupted = true; }
    }
    let status: any = null, error: string | null = null;
    try {
      const response = await fetch(statusUrl, { signal: AbortSignal.timeout(3500) });
      if (!response.ok) throw Error(`http_${response.status}`);
      status = await response.json(); finalStatus = status;
      if (allowedClients !== null && status.phase2b.connected > allowedClients && !isolationFailure) {
        isolationFailure = true; note("unexpected_concurrent_clients", { expectedMaximum: allowedClients, actual: status.phase2b.connected });
        if (pid) process.kill(pid, "SIGTERM");
      }
      await fs.writeFile(path.join(root, `status-${Date.now()}.json`), JSON.stringify(status, null, 2));
    } catch { error = "status_unavailable"; }
    await fs.appendFile(path.join(root, "samples.jsonl"), JSON.stringify({ atUs: Date.now() * 1000, resource, status, error }) + "\n");
  } finally { sampleBusy = false; }
}
const interval = setInterval(() => { void sample(); }, 5000);
await sample();
async function waitFor(check: () => Promise<boolean>, timeout: number, reason: string) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (guard || interrupted || isolationFailure) throw Error(isolationFailure ? "unexpected_concurrent_clients" : guard ? "rss_guard" : "server_exited");
    if (await check()) return;
    await delay(250);
  }
  throw Error(reason);
}
async function hold(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (guard || interrupted || isolationFailure) throw Error(isolationFailure ? "unexpected_concurrent_clients" : guard ? "rss_guard" : "server_exited");
    await delay(250);
  }
}
let chromium: Awaited<ReturnType<typeof browser>> | undefined;
let proxy: Awaited<ReturnType<typeof staticProxy>> | undefined;
let mainPage: Awaited<ReturnType<Awaited<ReturnType<typeof browser>>["page"]>> | undefined;
const details: Record<string, unknown> = {};
try {
  note("scenario_waiting_for_server", { phase, scenario, directory: root });
  await waitFor(async () => finalStatus !== null, 180000, "server_not_ready");
  details.initialStatus = finalStatus;
  note("scenario_begin", { phase, scenario, pid, preexistingClients: finalStatus.phase2b.connected });
  if (scenario === "backfill") {
    allowedClients = 0;
    await waitFor(async () => {
      const state = finalStatus.phase2a.backfill.state;
      if (state === "failed") throw Error("backfill_failed");
      return state === "complete";
    }, 20 * 60000, "backfill_incomplete_after_20min");
    details.backfill = finalStatus.phase2a.backfill;
  } else {
    const staticRoot = path.resolve(phase.includes("before") ? "data/perf-memory/original-dist" : "artifacts/heatmap/dist/public");
    proxy = await staticProxy(staticRoot);
    chromium = await browser();
    const replay = scenario === "replay";
    const from = 1793021400;
    allowedClients = 1;
    const page = await chromium.page(appUrl + (replay ? `?debug=1&mode=replay&from=${from}&speed=10` : "?debug=1"));
    mainPage = page;
    await waitFor(async () => {
      const debug = await page.cdp.evaluate("window.__heatmapDebug");
      details.lastLoadingDebug = debug ?? null;
      // A live page may keep filling visible gaps while the background backfill
      // is running. The validated initial rangeDone, not zero future requests,
      // defines the beginning of its actual receiving interval.
      return debug?.connection === "connected" && debug.traffic?.initialComplete === true;
    }, 180000, "page_initial_load_timeout");
    details.readyDebug = await page.cdp.evaluate("window.__heatmapDebug");
    details.readyAtUs = Date.now() * 1000;
    note("page_initial_range_complete", { atUs: details.readyAtUs, loadingRanges: details.readyDebug.loadingRanges });
    finalStatus = await (await fetch(statusUrl)).json();
    if (finalStatus.phase2b.connected !== 1) throw Error("unexpected_concurrent_clients");
    if (scenario === "live" || scenario === "live30") await hold((scenario === "live30" ? 30 : 10) * 60000);
    else if (replay) {
      await waitFor(async () => {
        const debug = await page.cdp.evaluate("window.__heatmapDebug");
        return (debug?.replayHeadUs ?? 0) >= (from + 1800) * 1e6;
      }, 240000, "replay_30min_timeout");
    } else if (scenario === "ranges") {
      // A real screen stays connected while a separate diagnostic receiver makes
      // exact 60-minute requests, sequentially after each rangeDone.
      details.rangeReceiverIsAdditionalClient = true;
      allowedClients = 2;
      const ws = new DiagnosticSocket(`ws://127.0.0.1:8080/api/ws`, {
        headers: { Origin: "http://127.0.0.1:19090", "User-Agent": `NQPerfRange/${process.pid}` },
      });
      const results: unknown[] = [];
      let next = 1, ready = false, failure: string | null = null;
      ws.on("error", () => { failure = "range_socket_error"; });
      ws.on("close", () => { if (results.length < 5) failure = "range_socket_closed"; });
      ws.on("message", (data, binary) => {
        if (binary) return;
        const value = JSON.parse(data.toString());
        if (value.type === "error") failure = value.code;
        if (value.type === "rangeDone") {
          if (value.reqId > 0) results.push(value);
          ready = true;
        }
      });
      try {
        await waitFor(async () => ready || failure !== null, 180000, "range_receiver_initial_timeout");
        if (failure) throw Error(failure);
        while (next <= 5) {
          ready = false;
          ws.send(JSON.stringify({ op: "range", reqId: next, fromSec: from - 1800, toSec: from + 1800 }));
          await waitFor(async () => ready || failure !== null, 180000, "range_timeout");
          if (failure) throw Error(failure);
          next++;
        }
      } finally { ws.close(1000, "measurement_complete"); details.ranges = results; }
    } else if (scenario === "dual") {
      allowedClients = 2;
      const past = await chromium.page(appUrl + "?debug=1");
      await waitFor(async () => {
        const debug = await past.cdp.evaluate("window.__heatmapDebug");
        return debug?.connection === "connected" && debug.traffic?.initialComplete === true;
      }, 180000, "second_page_initial_timeout");
      for (let n = 0; n < 6; n++) {
        await past.cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: 120, y: 320, button: "left", clickCount: 1 });
        for (let i = 1; i <= 12; i++) {
          await past.cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 120 + i * 40, y: 320, button: "left", buttons: 1 });
          await delay(16);
        }
        await past.cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 600, y: 320, button: "left", clickCount: 1 });
        await delay(400);
      }
      details.pastDebug = await past.cdp.evaluate("window.__heatmapDebug");
      finalStatus = await (await fetch(statusUrl)).json();
      if (finalStatus.phase2b.connected !== 2) throw Error("unexpected_concurrent_clients");
      await hold(10 * 60000);
      details.pastEndDebug = await past.cdp.evaluate("window.__heatmapDebug");
    } else throw Error("unknown_scenario");
    details.endDebug = await page.cdp.evaluate("window.__heatmapDebug");
    await fs.writeFile(path.join(root, "frames.json"), JSON.stringify(await page.cdp.evaluate("window.__heatmapFrameStats")));
    note("active_measurement_complete");
  }
} catch (error) {
  if (mainPage) {
    details.interruptedDebug = await mainPage.cdp.evaluate("({debug:window.__heatmapDebug, body:document.body.innerText.slice(0,300)})").catch(() => null);
  }
  details.failure = error instanceof Error ? error.message : "scenario_failed";
  note("scenario_interrupted", { reason: details.failure });
} finally {
  if (chromium) {
    try {
      details.browserClosed = await chromium.close();
      note("browser_exit_confirmed", details.browserClosed as object);
    } catch (error) {
      details.failure = error instanceof Error ? error.message : "browser_cleanup_failed";
      note("browser_cleanup_failed", { reason: details.failure });
    }
  }
  if (proxy) details.staticProxyClosed = await proxy.close();
  // Browser close handshakes can overlap one sample, especially under the old
  // server's blocking full-hour reads. Observe them, but allow a short grace.
  allowedClients = null;
  if (!guard && !interrupted && !isolationFailure) { await delay(5000); allowedClients = 0; }
  note("recovery_begin", { seconds: 60 });
  if (!guard && !interrupted && !isolationFailure) await delay(60000);
  await sample();
  if (scenario === "live30" && !details.failure && !guard && !interrupted && !isolationFailure) {
    try {
    allowedClients = null;
    const beforeRelease = await (await fetch(statusUrl)).json();
    details.zeroBeforeRelease = beforeRelease.phase2b.connected === 0;
    note("measurement_isolation_release_begin");
    await fs.unlink(marker);
    const released = await (await fetch(statusUrl)).json();
    details.isolationReleased = released.measurementIsolation.enabled === false;
    const domain = process.env.REPLIT_DEV_DOMAIN;
    if (!domain) throw Error("release_check_development_domain_missing");
    const verification = new DiagnosticSocket(`wss://${domain}/api/ws`, {
      headers: { Origin: `https://${domain}`, "User-Agent": `NQPerfReleaseCheck/${process.pid}` },
    });
    let hello = false, failed = false, closed = false;
    verification.on("message", (data, binary) => {
      if (!binary && JSON.parse(data.toString()).type === "hello") hello = true;
    });
    verification.on("error", () => { failed = true; });
    verification.on("close", () => { closed = true; });
    try {
      await waitFor(async () => hello || failed, 20000, "release_public_ws_timeout");
      details.publicPreviewWsAccepted = hello;
    } finally {
      verification.close(1000, "release_check_complete");
      await waitFor(async () => closed, 5000, "release_check_close_timeout");
      details.releaseCheckSocketClosed = closed;
    }
    note("measurement_isolation_release_verified", {
      disabled: details.isolationReleased, publicPreviewAccepted: hello, checkSocketClosed: closed,
    });
    await sample();
    } catch (error) {
      details.releaseVerificationFailure = error instanceof Error ? error.message : "release_check_failed";
      note("release_verification_failed", { reason: details.releaseVerificationFailure });
    }
    if (details.isolationReleased) {
      // Timed measurement and recovery are over. Keep the normal, unrestricted
      // server briefly available for the required final app screenshot.
      note("final_visual_check_ready", { directory: root });
      try {
        await waitFor(async () => {
          try { await fs.access(path.join(root, "finish-visual-check")); return true; }
          catch { return false; }
        }, 120000, "final_visual_check_timeout");
        details.finalVisualCheckCompleted = true;
      } catch {
        details.finalVisualCheckCompleted = false;
        note("final_visual_check_timeout");
      }
      await sample();
    }
  }
  stopped = true; clearInterval(interval);
  details.finalStatus = finalStatus;
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({
    phase, scenario, pid, startedAtUs, endedAtUs: Date.now() * 1000, guard, interrupted, isolationFailure, details, events,
  }, null, 2));
  if (pid) {
    details.serverExitConfirmed = false;
    try { process.kill(pid, "SIGTERM"); note("sigterm_sent", { pid }); } catch { note("server_already_exited", { pid }); }
    for (let i = 0; i < 240; i++) {
      try { await fs.access(`/proc/${pid}`); await delay(250); }
      catch { details.serverExitConfirmed = true; note("server_exit_confirmed", { pid }); break; }
    }
    if (!details.serverExitConfirmed) note("server_exit_not_confirmed", { pid });
  }
  note("scenario_finished", { directory: root });
  await fs.rm(marker, { force: true });
  note("isolation_marker_removed");
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({
    phase, scenario, pid, startedAtUs, endedAtUs: Date.now() * 1000, guard, interrupted, isolationFailure, details, events,
  }, null, 2));
}
