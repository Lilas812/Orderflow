import { Session } from "node:inspector";
import { setImmediate as yieldNow } from "node:timers/promises";
import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { Log } from "../logger.ts";
import type { Objects } from "../store/objects.ts";

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface ProfileOptions { log: Log; objects?: Objects | null; prefix: string;
  secrets: readonly string[]; directory: string; now?: () => number; durationMs?: number }
export interface CpuProfile { nodes: Node[]; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number }
/** No environment variables or application argument values are requested from inspector. */
export async function profileSummary(profile: CpuProfile) {
  const self = new Map<number, number>(), total = new Map<number, number>(), parent = new Map<number, number>();
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const id = profile.samples![i], us = profile.timeDeltas?.[i] ?? 5000;
    self.set(id, (self.get(id) ?? 0) + us);
    if (i % 512 === 0) await yieldNow();
  }
  for (let i = 0; i < profile.nodes.length; i++) {
    const n = profile.nodes[i]; for (const child of n.children ?? []) parent.set(child, n.id);
    if (i % 128 === 0) await yieldNow();
  }
  // Iterative postorder, independent of inspector node array order.
  const stack: [number, boolean][] = profile.nodes.filter(n => !parent.has(n.id)).map(n => [n.id, false]);
  let step = 0;
  while (stack.length) {
    const [id, visited] = stack.pop()!, n = nodes.get(id)!;
    if (!visited) {
      stack.push([id, true]); for (const child of n.children ?? []) stack.push([child, false]);
    } else total.set(id, (self.get(id) ?? 0) + (n.children ?? []).reduce((s, c) => s + (total.get(c) ?? 0), 0));
    if (++step % 128 === 0) await yieldNow();
  }
  const row = (n: Node) => ({ function: n.callFrame.functionName || "(anonymous)", file: n.callFrame.url,
    line: n.callFrame.lineNumber + 1, selfMs: (self.get(n.id) ?? 0) / 1000, totalMs: (total.get(n.id) ?? 0) / 1000 });
  return { selfTop30: profile.nodes.map(row).sort((a, b) => b.selfMs - a.selfMs).slice(0, 30),
    totalTop20: profile.nodes.map(row).sort((a, b) => b.totalMs - a.totalMs).slice(0, 20) };
}
/** Chunked JSON, checked before ANY cloud upload. Includes keys and all stack URLs. */
export async function* profileJson(profile: CpuProfile, secrets: readonly string[]) {
  const check = (s: string) => {
    for (const secret of secrets) if (secret && (s.includes(secret) || s.includes(JSON.stringify(secret).slice(1, -1))))
      throw Error("profile_secret_detected");
    return s;
  };
  yield '{"nodes":[';
  for (let i = 0; i < profile.nodes.length; i++) {
    yield check((i ? "," : "") + JSON.stringify(profile.nodes[i]));
    if (i % 64 === 0) await yieldNow();
  }
  yield `],"startTime":${profile.startTime},"endTime":${profile.endTime}`;
  for (const key of ["samples", "timeDeltas"] as const) {
    yield `,"${key}":[`;
    const values = profile[key] ?? [];
    for (let i = 0; i < values.length; i += 512) { yield check((i ? "," : "") + JSON.stringify(values.slice(i, i + 512)).slice(1, -1)); await yieldNow(); }
    yield "]";
  }
  yield "}";
}
export class AutoCpuProfile {
  private events: number[] = [];
  private lastStarted = -Infinity;
  private session: Session | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private active = false;
  private stopped = false;
  private summaries: unknown[] = [];
  private failure: string | null = null;
  private starting: Promise<void> | null = null;
  private options: ProfileOptions;
  constructor(options: ProfileOptions) { this.options = options; }
  observe(delayMs: number) {
    if (this.stopped || delayMs < 5000) return;
    const now = this.options.now?.() ?? Date.now();
    this.events = [...this.events.filter(t => t >= now - 600000), now].slice(-2);
    if (this.events.length >= 2 && now - this.lastStarted >= 3600000 && !this.active)
      this.starting = this.start(now).finally(() => { this.starting = null; });
  }
  private post<T>(method: string, params = {}): Promise<T> {
    return new Promise((resolve, reject) => this.session!.post(method, params,
      (e, r) => e ? reject(e) : resolve(r as T)));
  }
  private async start(now: number) {
    this.active = true; this.lastStarted = now; this.failure = null;
    try {
      this.session = new Session(); this.session.connect();
      await this.post("Profiler.enable"); await this.post("Profiler.setSamplingInterval", { interval: 5000 });
      await this.post("Profiler.start");
      if (this.stopped) { await this.finish(false); return; }
      this.timer = setTimeout(() => { void this.finish(true); }, this.options.durationMs ?? 180000);
      this.timer.unref(); this.options.log("cpu_profile_started", { atUs: now * 1000, intervalUs: 5000 });
    } catch { this.failure = "profile_start_failed"; this.session?.disconnect(); this.session = null; this.active = false; }
  }
  private finish(save: boolean): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.finishWork(save).finally(() => { this.stopping = null; });
    return this.stopping;
  }
  private async finishWork(save: boolean) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let file: string | null = null;
    try {
      const { profile } = await this.post<{ profile: CpuProfile }>("Profiler.stop");
      if (!save) return;
      await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      file = path.join(this.options.directory, `${this.lastStarted}-${process.pid}.cpuprofile.json.gz`);
      await pipeline(profileJson(profile, this.options.secrets), createGzip(), createWriteStream(file, { mode: 0o600, flags: "wx" }));
      const summary = await profileSummary(profile);
      // Summary fields originate from already scanned profile strings.
      const name = `${this.options.prefix}diagnostics/cpuprofile/${path.basename(file)}`;
      if (this.options.objects) {
        await this.options.objects.upload(name, file);
        const names = (await this.options.objects.list(`${this.options.prefix}diagnostics/cpuprofile/`))
          .filter(n => /\/\d+-\d+\.cpuprofile\.json\.gz$/.test(n)).sort();
        for (const old of names.slice(0, -5)) {
          if (!this.options.objects.delete) throw Error("profile_retention_unavailable");
          await this.options.objects.delete(old);
        }
      } else {
        const names = (await fs.readdir(this.options.directory)).filter(n => /^\d+-\d+\.cpuprofile\.json\.gz$/.test(n)).sort();
        for (const old of names.slice(0, -5)) await fs.unlink(path.join(this.options.directory, old));
      }
      this.summaries.push({ atUs: this.lastStarted * 1000, name, storage: this.options.objects ? "app-storage" : "local_dev_only", ...summary });
      this.summaries = this.summaries.slice(-3);
      this.options.log("cpu_profile_saved", { name });
    } catch (e) {
      this.failure = e instanceof Error && e.message === "profile_secret_detected" ? e.message : "profile_save_failed";
      this.options.log("cpu_profile_failed", { reason: this.failure });
    } finally {
      if (file && (this.failure || this.options.objects)) await fs.rm(file, { force: true }).catch(() => {});
      this.session?.disconnect(); this.session = null; this.active = false;
    }
  }
  snapshot() { return { active: this.active, lastStartedUs: Number.isFinite(this.lastStarted) ? this.lastStarted * 1000 : null,
    minIntervalMs: 3600000, durationMs: this.options.durationMs ?? 180000, summaries: this.summaries, failure: this.failure }; }
  async stop() {
    this.stopped = true;
    await this.starting;
    if (this.stopping) await this.stopping;
    else if (this.active && this.timer) await this.finish(false);
  }
}
