import { fork, type ChildProcess } from "node:child_process";
import { setPriority, getPriority } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { WindowSplitRequired, WindowUnavailableError, type HistoryNetworkStats, type HistoryResponse } from "./client.ts";
import type { Kind } from "../store/local.ts";
import type { MarketSymbol } from "../../../lib/market/instruments.ts";
import type { Log } from "../logger.ts";
import type { LabelExport } from "../labels/export.ts";
import type { LabelInputProvider } from "../labels/input.ts";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface HistoryLoad { loopP99Ms: number | null; throttledRatio: number | null; }
export class HistoryProcess {
  private key: string;
  private log: Log;
  private load: () => HistoryLoad;
  private testOrigin?: string;
  private wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private childCpu: (us: number) => void;
  private child: ChildProcess | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private serial = 0;
  private stopped = false;
  private labelsBusy = false;
  private abort = new AbortController();
  private retiring: Promise<void> = Promise.resolve();
  private active: { id: number; reject(error: Error): void; child: ChildProcess } | null = null;
  readonly stats = { childPid: null as number | null, priority: null as number | null, heapLimitMiB: 256,
    restarts: 0, exits: 0, admissionWaits: 0, admissionWaitMs: 0, waiting: false,
    completed: 0, childCpuUs: 0, childRss: 0 };
  private networks = new Map<MarketSymbol, HistoryNetworkStats>();
  constructor(key: string, log: Log,
    load: () => HistoryLoad = () => ({ loopP99Ms: null, throttledRatio: null }),
    testOrigin?: string,
    wait = async (ms: number, signal: AbortSignal) => { await delay(ms, undefined, { signal }); },
    childCpu: (us: number) => void = () => {}) {
    this.key = key; this.log = log; this.load = load; this.testOrigin = testOrigin;
    this.wait = wait; this.childCpu = childCpu;
  }

  source(symbol: MarketSymbol) {
    let stats = this.networks.get(symbol);
    if (!stats) {
      stats = { requests: 0, fetchedBookRows: 0, fetchedTradeRows: 0, errors: 0, retries: 0,
        exhaustedRequests: 0, waits: 0, waitUntilUs: null, lastError: null };
      this.networks.set(symbol, stats);
    }
    return { symbol, stats, get: (kind: Kind, start: number, end: number, signal: AbortSignal) => {
      signal = AbortSignal.any([signal, this.abort.signal]);
      const work = this.tail.catch(() => {}).then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          signal.throwIfAborted();
          if (this.stopped) throw Error("history_process_stopped");
          await this.admit(signal);
          try { return await this.take(symbol, kind, start, end, signal, stats!); }
          catch (error) {
            if (!(error instanceof WindowUnavailableError) || error.reason !== "history_child_exit" || attempt === 2) throw error;
            this.stats.restarts++;
          }
        }
        throw new WindowUnavailableError("history_child_exit");
      });
      this.tail = work.then(() => {}, () => {});
      // Abort a queued consumer without waiting for another symbol's request.
      return new Promise<HistoryResponse>((resolve, reject) => {
        const abort = () => reject(signal.reason instanceof Error ? signal.reason : Error("history_aborted"));
        signal.addEventListener("abort", abort, { once: true });
        void work.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
          error => { signal.removeEventListener("abort", abort); reject(error); });
        if (signal.aborted) abort();
      });
    } };
  }
  private async admit(signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      if (this.stopped) throw Error("history_process_stopped");
      const state = this.load();
      if (!(state.loopP99Ms !== null && state.loopP99Ms > 100)
        && !(state.throttledRatio !== null && state.throttledRatio > .2)) return;
      this.stats.admissionWaits++; this.stats.waiting = true;
      const at = performance.now();
      this.log("history_admission_wait", { ...state, waitMs: 10000 });
      try { await this.wait(10000, signal); }
      finally { this.stats.admissionWaitMs += performance.now() - at; this.stats.waiting = false; }
    }
  }
  private retire(child: ChildProcess) {
    if (this.child === child) { this.child = null; this.stats.childPid = null; }
    this.retiring = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("exit", () => resolve()); child.kill("SIGTERM");
    });
  }
  private async ensureChild() {
    await this.retiring;
    if (this.stopped) throw Error("history_process_stopped");
    if (this.child) return this.child;
    const child = fork(new URL("./child.ts", import.meta.url), [], {
      execArgv: ["--max-old-space-size=256"], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH ?? "", TZ: "UTC" },
    });
    child.once("error", () => {});
    try {
      if (!Number.isSafeInteger(child.pid)) throw Error("history_child_spawn_failed");
      setPriority(child.pid!, 19);
    }
    catch { child.kill("SIGTERM"); throw new WindowUnavailableError("history_priority_unavailable"); }
    this.child = child;
    this.childCpu(0);
    let reportedCpuUs = 0;
    child.on("message", (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const message = value as { cpu?: NodeJS.CpuUsage; rss?: number };
      if (message.cpu) {
        const total = message.cpu.user + message.cpu.system;
        const us = Math.max(0, total - reportedCpuUs);
        reportedCpuUs = total; this.stats.childCpuUs += us; this.childCpu(us);
      }
      if (message.rss) this.stats.childRss = message.rss;
    });
    this.stats.childPid = child.pid!; this.stats.priority = getPriority(child.pid!);
    this.log("history_child_started", { pid: child.pid, priority: this.stats.priority, heapLimitMiB: 256 });
    child.on("error", () => {
      this.retire(child);
      if (this.active?.child === child) this.active.reject(new WindowUnavailableError("history_child_exit"));
    });
    child.on("exit", (code, signal) => {
      this.stats.exits++;
      this.log("history_child_exit", { pid: child.pid, code, signal });
      if (this.child === child) { this.child = null; this.stats.childPid = null; }
      if (this.active?.child === child) this.active.reject(new WindowUnavailableError("history_child_exit"));
    });
    return child;
  }
  private async take(symbol: MarketSymbol, kind: Kind, start: number, end: number, signal: AbortSignal,
    stats: HistoryNetworkStats): Promise<HistoryResponse> {
    const child = await this.ensureChild(), id = ++this.serial;
    return new Promise((resolve, reject) => {
      let previous: Partial<HistoryNetworkStats> = {};
      const update = (next: HistoryNetworkStats) => {
        for (const field of ["requests", "fetchedBookRows", "fetchedTradeRows", "errors", "retries",
          "exhaustedRequests", "waits"] as const) stats[field] += next[field] - (previous[field] ?? 0);
        stats.waitUntilUs = next.waitUntilUs; stats.lastError = next.lastError; previous = { ...next };
      };
      const finish = (error?: Error, response?: HistoryResponse) => {
        child.off("message", receive); signal.removeEventListener("abort", abort);
        if (this.active?.id === id) this.active = null;
        stats.waitUntilUs = null;
        if (error) reject(error); else resolve(response!);
      };
      const abort = () => {
        this.retire(child);
        finish(signal.reason instanceof Error ? signal.reason : Error("history_aborted"));
      };
      const receive = (value: unknown) => {
        const m = value as { id: number; type: string; event: string; details: object;
          stats: HistoryNetworkStats; cpu?: NodeJS.CpuUsage; rss?: number; reason?: string;
          fatal?: boolean; response?: HistoryResponse };
        if (m.id !== id) return;
        if (m.stats) update(m.stats);
        if (m.type === "progress") { this.log(m.event, { ...m.details, symbol }); return; }
        if (m.type === "resource") return;
        if (m.type === "failed") return finish(m.reason === "split" ? new WindowSplitRequired()
          : m.fatal ? Error("history_child_request_failed") : new WindowUnavailableError(m.reason ?? "history_child_request_failed"));
        if (m.type === "done") { this.stats.completed++; finish(undefined, m.response); }
      };
      this.active = { id, child, reject: error => finish(error) };
      child.on("message", receive);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      child.send({ id, key: this.key, symbol, kind, start, end, testOrigin: this.testOrigin }, error => {
        if (error && this.active?.id === id) {
          this.retire(child); finish(new WindowUnavailableError("history_child_exit"));
        }
      });
    });
  }
  snapshot() { return { ...this.stats, childRss: this.stats.childPid === null ? null : this.stats.childRss }; }
  /** Share the existing nice-19 worker and serial queue, but grant only request-owned disk snapshots.
   * A labels job has no API key or REST capability in its message.
   */
  async labelsExport(job: LabelExport, input: LabelInputProvider, signal: AbortSignal): Promise<{ zip: string; summary: unknown }> {
    if (this.labelsBusy) throw Error("labels_export_busy");
    this.labelsBusy = true;
    const work = this.tail.catch(() => {}).then(async () => {
      signal.throwIfAborted(); await this.admit(signal);
      const child = await this.ensureChild(), id = ++this.serial;
      return new Promise<{ zip: string; summary: unknown }>((resolve, reject) => {
        const pending = new Set<Promise<void>>(), leases = new Map<number, string>();
        const openHour = Math.floor(Date.now() / 3_600_000) * 3600;
        let openInput: import("../labels/input.ts").LabelHourInput | null = null;
        let ended = false;
        const finish = async (error?: Error, response?: { zip: string; summary: unknown }) => {
          if (ended) return; ended = true;
          child.off("message", receive); signal.removeEventListener("abort", abort);
          if (this.active?.id === id) this.active = null;
          await Promise.allSettled(pending);
          if (error) reject(error); else resolve(response!);
        };
        const abort = () => { this.retire(child); void finish(Error("labels_export_aborted")); };
        const send = (message: object) => {
          if (!ended && child.connected) child.send({ id, ...message }, () => {});
        };
        const receive = (value: unknown) => {
          const m = value as { id: number; type: string; hour?: number; response?: { zip: string; summary: unknown }; reason?: string };
          if (m.id !== id || ended) return;
          if (m.type === "labels_done") { void finish(undefined, m.response); return; }
          if (m.type === "labels_failed") { void finish(Error(m.reason ?? "labels_export_failed")); return; }
          if (m.type !== "labels_input" && m.type !== "labels_release") return;
          const hour = m.hour!;
          if (!Number.isSafeInteger(hour) || hour < 0 || hour % 3600 !== 0 || hour > 0xffffffff) {
            void finish(Error("invalid_labels_hour")); return;
          }
          const task = Promise.resolve().then(async () => {
            try {
              signal.throwIfAborted();
              if (m.type === "labels_release") {
                const dir = leases.get(hour);
                if (dir && hour !== openHour) { leases.delete(hour); await fs.rm(dir, { recursive: true, force: true }); }
                send({ type: "labels_released", hour }); return;
              }
              if (hour === openHour && openInput) { send({ type: "labels_input_ready", hour, input: openInput }); return; }
              if (leases.has(hour)) throw Error("duplicate_labels_lease");
              const directory = path.join(job.directory, `hour-${hour}-${randomUUID()}`);
              leases.set(hour, directory);
              const result = await input(hour, directory);
              if (hour === openHour) openInput = result;
              send({ type: "labels_input_ready", hour, input: result });
            } catch { send({ type: "labels_input_failed", hour }); }
          });
          pending.add(task); void task.finally(() => pending.delete(task));
        };
        this.active = { id, child, reject: error => { void finish(error); } };
        child.on("message", receive); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        child.send({ id, type: "labels_export", job }, error => {
          if (error) { this.retire(child); void finish(Error("labels_export_child_send_failed")); }
        });
      });
    });
    this.tail = work.then(() => {}, () => {});
    try { return await work; } finally { this.labelsBusy = false; }
  }
  async stop() {
    this.stopped = true;
    this.abort.abort(Error("history_process_stopped"));
    const child = this.child;
    this.active?.reject(Error("history_process_stopped"));
    if (child) {
      const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGTERM"); await exit;
    }
    await this.retiring;
    await this.tail.catch(() => {});
    this.child = null; this.stats.childPid = null;
  }
}
