import { AsyncLocalStorage, createHook, executionAsyncId } from "node:async_hooks";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import type { Log } from "../logger.ts";

const thread = () => typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : null;
const cpu = (v: NodeJS.CpuUsage | null) => v ? v.user + v.system : null;
export const diagnosticRole = new AsyncLocalStorage<string>();
export function namedWork<T>(name: string, work: () => T): T { return diagnosticRole.run(name, work); }

/** No stacks or argument/object contents are captured. All collections bounded. */
export class MainThreadMonitor {
  private names = new Map<number, string>();
  private frames: { id: number; start: number; atUs: number; cpu: number | null; name: string }[] = [];
  private gc: { at: number; ms: number; kind: number }[] = [];
  private long: { atUs: number; durationMs: number; mainCpuMs: number | null; name: string }[] = [];
  private stalls: { atUs: number; delayMs: number; name: string }[] = [];
  private gcDropped = 0;
  private baseThread = cpu(thread());
  private baseProcess = cpu(process.cpuUsage())!;
  private baseAt = performance.now();
  private baseElu = performance.eventLoopUtilization();
  private previous = this.baseAt;
  private timer: ReturnType<typeof setInterval> | null = null;
  private observer = new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      const detail = (e as unknown as { detail?: { kind?: number } }).detail;
      this.gc.push({ at: e.startTime + e.duration, ms: e.duration, kind: detail?.kind ?? 0 });
    }
    this.prune();
  });
  private hook = createHook({
    init: (id, type, trigger) => {
      if (this.names.size >= 65536) return; // unknown is explicit if the attribution budget is exhausted
      const role = diagnosticRole.getStore();
      const inherited = this.names.get(trigger)?.split("/")[0];
      this.names.set(id, `${role ?? inherited ?? "unattributed"}/${type}`);
    },
    before: id => {
      this.frames.push({ id, start: performance.now(), atUs: Date.now() * 1000,
        cpu: cpu(thread()), name: this.names.get(id) ?? "unknown" });
    },
    after: id => {
      const f = this.frames.pop();
      if (!f || f.id !== id) { this.frames.length = 0; return; }
      const durationMs = performance.now() - f.start, current = cpu(thread());
      if (durationMs >= 200) {
        const row = { atUs: f.atUs, durationMs,
          mainCpuMs: f.cpu === null || current === null ? null : (current - f.cpu) / 1000, name: f.name };
        this.long.push(row); if (this.long.length > 50) this.long.shift();
        this.longCount++; this.longMaxMs = Math.max(this.longMaxMs, durationMs);
        this.log("main_long_callback", row);
      }
    },
    destroy: id => { this.names.delete(id); },
  });
  private longCount = 0;
  private longMaxMs = 0;
  private log: Log;
  private onStall: (delayMs: number) => void;
  private asyncHooksEnabled: boolean;
  constructor(log: Log, onStall: (delayMs: number) => void = () => {},
    asyncHooksEnabled = process.env.HEATMAP_ASYNC_HOOKS === "1") {
    this.log = log; this.onStall = onStall; this.asyncHooksEnabled = asyncHooksEnabled;
  }
  start() {
    if (this.timer) return;
    if (this.asyncHooksEnabled) this.hook.enable();
    this.observer.observe({ entryTypes: ["gc"] });
    this.previous = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now(), delayMs = Math.max(0, now - this.previous - 100);
      this.previous = now;
      if (delayMs >= 200) {
        const startUs = Date.now() * 1000 - delayMs * 1000;
        const known = [...this.long].reverse().find(x => x.atUs + x.durationMs * 1000 >= startUs);
        const row = { atUs: Date.now() * 1000, delayMs, name: known?.name ?? "unknown" };
        this.stalls.push(row); if (this.stalls.length > 50) this.stalls.shift();
        this.log("main_loop_stall", row); this.onStall(delayMs);
      }
    }, 100);
    this.timer.unref();
  }
  private prune() {
    const now = performance.now();
    this.gc = this.gc.filter(e => e.at >= now - 60000);
    if (this.gc.length > 16384) { this.gcDropped += this.gc.length - 16384; this.gc = this.gc.slice(-16384); }
  }
  snapshot() {
    this.prune();
    const now = performance.now(), t = cpu(thread()), p = cpu(process.cpuUsage())!;
    const span = Math.max(.000001, (now - this.baseAt) / 1000);
    const gc: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
    for (const e of this.gc) {
      const v = gc[e.kind] ??= { count: 0, totalMs: 0, maxMs: 0 };
      v.count++; v.totalMs += e.ms; v.maxMs = Math.max(v.maxMs, e.ms);
    }
    const elu = performance.eventLoopUtilization(this.baseElu);
    const main = t === null || this.baseThread === null ? null : (t - this.baseThread) / span / 1e6;
    const all = (p - this.baseProcess) / span / 1e6;
    return { threadCpuAvailable: main !== null, mainCores: main, processCores: all,
      auxiliaryCores: main === null ? null : Math.max(0, all - main), observedSeconds: span,
      cpuWindow: "since_last_5s_sample", eventLoopUtilization: elu,
      gc: { windowMs: 60000, byKind: gc, dropped: this.gcDropped }, heap: getHeapStatistics(),
      longCallbacks: [...this.long], longCallbackCount: this.longCount, longCallbackMaxMs: this.longMaxMs,
      stalls: [...this.stalls], attribution: this.asyncHooksEnabled
        ? "async_callback_inclusive; not_additive; unlabelled_is_unknown"
        : "async_hooks_disabled; callback_duration_unavailable",
      asyncHooksEnabled: this.asyncHooksEnabled, trackedResources: this.names.size, executionAsyncId: executionAsyncId() };
  }
  sample() {
    const result = this.snapshot();
    this.baseThread = cpu(thread()); this.baseProcess = cpu(process.cpuUsage())!;
    this.baseAt = performance.now(); this.baseElu = performance.eventLoopUtilization();
    return result;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.hook.disable(); this.observer.disconnect();
    this.names.clear(); this.frames.length = 0;
  }
}
