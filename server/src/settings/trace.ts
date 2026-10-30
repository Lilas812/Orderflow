import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { RequestHandler } from "express";
import type { Log } from "../logger.ts";

type Stage = "cloud_fetch" | "local_read" | "local_save" | "source_hash" | "upload" | "verification"
  | "cloud_exists" | "cloud_download" | "cloud_list"
  | "backup_source_hash" | "backup_upload" | "backup_verification";
type Timing = { calls: number; ms: number; failed: number };
interface Context {
  trace: SettingsTrace;
  id: string;
  method: "GET" | "PUT";
  endpoint: "settings" | "longvp";
  startUs: number;
  start: number;
  disconnected: boolean;
  queues: Partial<Record<"app" | "local", Timing>>;
  stages: Partial<Record<Stage, Timing>>;
}
const current = new AsyncLocalStorage<Context>();
const round = (n: number) => Math.round(n * 1000) / 1000;
const stamp = () => Date.now() * 1000;
function add(target: Partial<Record<string, Timing>>, key: string, ms: number, failed = false) {
  const t = target[key] ??= { calls: 0, ms: 0, failed: 0 };
  t.calls++; t.ms = round(t.ms + ms); if (failed) t.failed++;
}

/** Capture enqueue time in the caller's context, not the previous queue owner's. */
export function settingsQueue(queue: "app" | "local"): () => void {
  const c = current.getStore();
  if (!c) return () => {};
  const start = performance.now();
  return () => add(c.queues, queue, performance.now() - start);
}

/** No extra promise/await when disabled. Never inspect input, output or exceptions. */
export function settingsStage<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
  const c = current.getStore();
  if (!c) return work();
  const start = performance.now();
  return work().then(value => {
    add(c.stages, stage, performance.now() - start); return value;
  }, error => {
    add(c.stages, stage, performance.now() - start, true); throw error;
  });
}

/** A separate completion event survives HTTP disconnect; success means store returned,
 * including cloud re-download verification for AppSettings, not just local rename.
 */
export function settingsOperation<T>(work: () => Promise<T>, readFallback: () => boolean): Promise<T> {
  const c = current.getStore();
  if (!c) return work();
  const finish = (result: "ok" | "read_fallback" | "failed") => c.trace.write("settings_trace_operation", {
    ...identity(c), endedAtUs: stamp(), elapsedMs: round(performance.now() - c.start), result,
    clientDisconnected: c.disconnected, queues: c.queues, stages: c.stages,
  });
  return work().then(value => {
    finish(readFallback() ? "read_fallback" : "ok"); return value;
  }, error => { finish("failed"); throw error; });
}

function identity(c: Context) {
  return { requestId: c.id, method: c.method, endpoint: c.endpoint, startedAtUs: c.startUs };
}

export interface TraceHistory {
  backfill: string;
  vpHistory: string;
  requests: number;
  errors: number;
  retries: number;
  waiting: boolean;
}
const states = new Set(["initializing", "idle", "waiting", "running", "complete", "failed", "stopped", "disabled"]);
const count = (n: number) => Number.isSafeInteger(n) && n >= 0 ? n : 0;

/** Opt-in, 15 minute maximum session; numeric, bounded-shape logs only.
 * No settings, bodies, URL, user headers, exception messages, or cloud names.
 */
export class SettingsTrace {
  private readonly log: Log;
  private readonly history: () => TraceHistory;
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private timer: ReturnType<typeof setInterval> | null = null;
  private expires: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private lastAt = performance.now();
  private lastCpu = process.cpuUsage();
  private lastLoop: { windowStartUs: number; windowEndUs: number; p99Ms: number; maxMs: number } | null = null;
  private readonly environment: "published" | "development";
  private readonly persistence: "app-storage" | "local" | "unspecified";

  constructor(log: Log, history: () => TraceHistory, environment: "published" | "development" = "development",
    persistence: "app-storage" | "local" | "unspecified" = "unspecified") {
    this.log = log; this.history = history; this.environment = environment; this.persistence = persistence;
  }
  start(): void {
    if (this.active) return;
    this.active = true; this.lastAt = performance.now(); this.lastCpu = process.cpuUsage();
    this.loop.enable();
    this.write("settings_trace_enabled", { atUs: stamp(), durationSec: 900, sampleSec: 5 });
    this.timer = setInterval(() => this.sample(), 5000); this.timer.unref();
    this.expires = setTimeout(() => this.stop(), 900000); this.expires.unref();
  }
  stop(): void {
    if (!this.active) return;
    this.sample(); this.active = false;
    if (this.timer) clearInterval(this.timer);
    if (this.expires) clearTimeout(this.expires);
    this.timer = this.expires = null; this.loop.disable();
    this.write("settings_trace_disabled", { atUs: stamp() });
  }
  private runtime() {
    // Whitelist each scalar: a future history snapshot cannot leak raw error/URLs.
    let h: TraceHistory | undefined;
    try { h = this.history(); } catch { /* observation unavailable, never change API outcome */ }
    return { sampledAtUs: stamp(), history: h ? {
      backfill: states.has(h.backfill) ? h.backfill : "unknown",
      vpHistory: states.has(h.vpHistory) ? h.vpHistory : "unknown",
      requests: count(h.requests), errors: count(h.errors), retries: count(h.retries),
      waiting: h.waiting === true,
    } : null, loopWindow: this.lastLoop };
  }
  private sample(): void {
    const now = performance.now(), cpu = process.cpuUsage();
    const elapsedMs = now - this.lastAt;
    const windowEndUs = stamp(), windowStartUs = windowEndUs - Math.round(elapsedMs * 1000);
    this.lastLoop = this.loop.count ? {
      windowStartUs, windowEndUs,
      p99Ms: round(this.loop.percentile(99) / 1e6), maxMs: round(this.loop.max / 1e6),
    } : null;
    this.write("settings_trace_runtime", {
      windowStartUs, windowEndUs,
      elapsedMs: round(elapsedMs),
      cpuCores: elapsedMs > 0 ? round((cpu.user + cpu.system - this.lastCpu.user - this.lastCpu.system) / (elapsedMs * 1000)) : null,
      ...this.runtime(),
    });
    this.loop.reset(); this.lastAt = now; this.lastCpu = cpu;
  }
  /** Logging failures must not turn an otherwise successful save into a failure. */
  write(event: string, details: object): void {
    try { this.log(event, { pid: process.pid, environment: this.environment, persistence: this.persistence, ...details }); } catch {}
  }
  readonly middleware: RequestHandler = (req, res, next) => {
    if (!this.active || (req.method !== "GET" && req.method !== "PUT")) { next(); return; }
    const c: Context = { trace: this, id: randomUUID(), method: req.method,
      endpoint: req.baseUrl.endsWith("/longvp") ? "longvp" : "settings", startUs: stamp(),
      start: performance.now(), disconnected: false, queues: {}, stages: {} };
    this.write("settings_trace_start", { ...identity(c), ...this.runtime() });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true; c.disconnected = !res.writableFinished;
      this.write("settings_trace_http", { ...identity(c), endedAtUs: stamp(),
        elapsedMs: round(performance.now() - c.start),
        result: c.disconnected ? "client_disconnected" : res.statusCode < 400 ? "ok" : "http_error",
        status: c.disconnected ? null : res.statusCode, ...this.runtime() });
    };
    res.once("finish", end); res.once("close", end);
    current.run(c, next);
  };
}
