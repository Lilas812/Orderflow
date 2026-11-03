import * as inspector from "node:inspector";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Log } from "../logger.ts";
import { CpuMonitor } from "./cpu.ts";
import { EventLoopMonitor } from "./event-loop.ts";
import { CpuPressure } from "./cpu-pressure.ts";
import { workCpu } from "./work-cpu.ts";
import { MainThreadMonitor, namedWork } from "./main-thread.ts";
import { AutoCpuProfile } from "./cpu-profile.ts";
import type { Objects } from "../store/objects.ts";

/** Numeric diagnostics only: allocation profiles contain stacks/sizes, not object
 * contents. Never write an unrestricted heap snapshot containing credentials.
 */
export class MemoryMonitor {
  private readonly log: Log;
  private readonly state: () => unknown;
  private readonly session = new inspector.Session();
  private timer: ReturnType<typeof setInterval> | null = null;
  private profiling = false;
  private writing = false;
  private stopped = false;
  private samples = 0;
  private cpu = new CpuMonitor();
  readonly eventLoop = new EventLoopMonitor();
  readonly pressure = new CpuPressure();
  readonly mainThread: MainThreadMonitor;
  readonly automaticProfile: AutoCpuProfile;
  private readonly directory = fileURLToPath(new URL("../../../data/perf-memory/profiles/", import.meta.url));

  constructor(log: Log, state: () => unknown = () => ({}),
    profileOptions?: { objects?: Objects | null; prefix: string; secrets: readonly string[]; directory: string }) {
    this.log = log; this.state = state;
    this.automaticProfile = new AutoCpuProfile({ log, ...profileOptions,
      prefix: profileOptions?.prefix ?? "dev/", secrets: profileOptions?.secrets ?? [],
      directory: profileOptions?.directory ?? fileURLToPath(new URL("../../../data/dev/diagnostics/cpuprofile/", import.meta.url)) });
    this.mainThread = new MainThreadMonitor(log, ms => this.automaticProfile.observe(ms));
  }

  snapshot() {
    return { sampledAtUs: Date.now() * 1000, pid: process.pid, ...process.memoryUsage(),
      rssMaxBytes: process.resourceUsage().maxRSS * 1024, cpu: this.cpu.snapshot(),
      eventLoop: { ...this.eventLoop.snapshot(), last10s: this.eventLoop.window(10000),
        last30s: this.eventLoop.window(30000) }, cpuPressure: this.pressure.snapshot(),
      cpuBreakdown: workCpu.snapshot(), mainThread: this.mainThread.snapshot(),
      automaticCpuProfile: this.automaticProfile.snapshot() };
  }

  start(): void {
    this.eventLoop.start();
    this.mainThread.start();
    this.session.connect();
    this.session.post("HeapProfiler.startSampling", { samplingInterval: 524288 }, error => {
      if (error) this.log("memory_profile_error", { operation: "start_sampling" });
      else this.profiling = true;
    });
    this.sample();
    this.timer = namedWork("diagnostics", () => setInterval(() => this.sample(), 5000));
    this.timer.unref();
  }

  private sample(): void {
    if (this.stopped) return;
    this.cpu.sample();
    workCpu.sample();
    void this.pressure.sample();
    this.log("process_memory", { ...this.snapshot(), activity: this.state() });
    this.mainThread.sample();
    this.eventLoop.reset();
    this.samples++;
    if (this.samples % 6 === 0) void this.saveProfile();
  }

  private async saveProfile(): Promise<void> {
    if (!this.profiling || this.writing) return;
    this.writing = true;
    try {
      const profile = await new Promise<unknown>((resolve, reject) => {
        this.session.post("HeapProfiler.getSamplingProfile", (error, result) => {
          if (error) reject(error); else resolve(result.profile);
        });
      });
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const body = JSON.stringify({ sampledAtUs: Date.now() * 1000, pid: process.pid, profile });
      const file = path.join(this.directory, `${process.pid}-latest.heapprofile.json`);
      await fs.writeFile(file, body, { mode: 0o600 });
      // Keep one early and one latest sample per process, not an unbounded history.
      await fs.writeFile(path.join(this.directory, `${process.pid}-first.heapprofile.json`), body, { flag: "wx", mode: 0o600 })
        .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    } catch {
      this.log("memory_profile_error", { operation: "save_sampling_profile" });
    } finally { this.writing = false; }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.mainThread.stop();
    await this.automaticProfile.stop();
    this.sample(); this.stopped = true;
    await this.saveProfile();
    if (this.profiling) {
      await new Promise<void>(resolve => this.session.post("HeapProfiler.stopSampling", () => resolve()));
    }
    this.session.disconnect();
    this.eventLoop.stop();
  }
}
