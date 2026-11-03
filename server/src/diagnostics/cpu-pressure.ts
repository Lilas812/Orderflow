import { readFile } from "node:fs/promises";

export function cgroupV2(max: string, stat: string) {
  const [quota, period] = max.trim().split(/\s+/);
  const values = Object.fromEntries(stat.trim().split("\n").map(line => line.trim().split(/\s+/)));
  const number = (key: string) => {
    const v = Number(values[key]);
    if (!Number.isSafeInteger(v) || v < 0) throw Error("invalid_cpu_counter");
    return v;
  };
  const periodUs = Number(period), quotaUs = quota === "max" ? null : Number(quota);
  if (!(periodUs > 0) || (quotaUs !== null && !(quotaUs > 0))) throw Error("invalid_cpu_max");
  return { version: 2, quotaUs, periodUs, limitCores: quotaUs === null ? null : quotaUs / periodUs,
    usageUs: number("usage_usec"), periods: number("nr_periods"),
    throttledPeriods: number("nr_throttled"), throttledUs: number("throttled_usec") };
}
export function procSteal(text: string) {
  const row = text.split("\n").find(line => /^cpu\s/.test(line));
  if (!row) throw Error("proc_cpu_missing");
  const values = row.trim().split(/\s+/).slice(1, 9).map(Number);
  if (values.length !== 8 || values.some(v => !Number.isSafeInteger(v) || v < 0)) throw Error("invalid_proc_cpu");
  return { total: values.reduce((a, b) => a + b, 0), steal: values[7] };
}
type Cgroup = ReturnType<typeof cgroupV2>;
interface Sample { at: number; cgroup: Cgroup | null; steal: ReturnType<typeof procSteal> | null; }
/** Read-only OS counters. Host-wide steal is NOT a per-container CPU metric. */
export class CpuPressure {
  private samples: Sample[] = [];
  private pending = false;
  private read: (path: string) => Promise<string>;
  private now: () => number;
  constructor(read: (path: string) => Promise<string> = path => readFile(path, "utf8"),
    now = () => performance.now()) { this.read = read; this.now = now; }
  async sample() {
    if (this.pending) return;
    this.pending = true;
    try {
      let cgroup: Cgroup | null = null, steal: Sample["steal"] = null;
      try {
        cgroup = cgroupV2(...await Promise.all([
          this.read("/sys/fs/cgroup/cpu.max"), this.read("/sys/fs/cgroup/cpu.stat"),
        ]) as [string, string]);
      } catch {
        for (const mount of ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct", "/sys/fs/cgroup/cpuacct,cpu"]) {
        try {
          const account = mount === "/sys/fs/cgroup/cpu" ? "/sys/fs/cgroup/cpuacct" : mount;
          const [quota, period, stat, usage] = await Promise.all([
            this.read(`${mount}/cpu.cfs_quota_us`), this.read(`${mount}/cpu.cfs_period_us`),
            this.read(`${mount}/cpu.stat`), this.read(`${account}/cpuacct.usage`),
          ]);
          const counters = Object.fromEntries(stat.trim().split("\n").map(line => line.trim().split(/\s+/)));
          cgroup = { ...cgroupV2(`${Number(quota) < 0 ? "max" : quota.trim()} ${period.trim()}`,
            `usage_usec ${Math.floor(Number(usage) / 1000)}\nnr_periods ${counters.nr_periods}\nnr_throttled ${counters.nr_throttled}\nthrottled_usec ${Math.floor(Number(counters.throttled_time) / 1000)}`),
          version: 1 };
          break;
        } catch { /* Explicit unavailable state below; not a synthetic zero. */ }
        }
      }
      try { steal = procSteal(await this.read("/proc/stat")); } catch { /* unavailable */ }
      const at = this.now();
      this.samples.push({ at, cgroup, steal });
      // Keep one sample before the boundary for at-most-5-second interpolation.
      while (this.samples.length > 2 && this.samples[1].at < at - 60000) this.samples.shift();
      if (this.samples.length > 64) this.samples.shift();
    } finally { this.pending = false; }
  }
  snapshot() {
    const last = this.samples.at(-1), now = this.now();
    if (!last) return { cgroup: { available: false as const }, steal: { available: false as const },
      observedSeconds: 0, throttledRatio: null as number | null };
    const oldest = this.samples[0], second = this.samples[1] ?? oldest;
    const startAt = Math.max(oldest.at, last.at - 60000);
    const alpha = second.at > oldest.at ? Math.min(1, (startAt - oldest.at) / (second.at - oldest.at)) : 0;
    const seconds = (last.at - startAt) / 1000;
    const cg = last.cgroup, oldCg = oldest.cgroup;
    const valid = cg && oldCg && seconds > 0 && cg.version === oldCg.version && cg.throttledUs >= oldCg.throttledUs;
    const boundaryThrottle = oldCg && second.cgroup && second.cgroup.version === oldCg.version
      ? oldCg.throttledUs + alpha * (second.cgroup.throttledUs - oldCg.throttledUs) : null;
    const throttledRatio = valid && boundaryThrottle !== null && cg.throttledUs >= boundaryThrottle
      ? (cg.throttledUs - boundaryThrottle) / (seconds * 1e6) : null;
    const boundarySteal = oldest.steal && second.steal ? {
      total: oldest.steal.total + alpha * (second.steal.total - oldest.steal.total),
      steal: oldest.steal.steal + alpha * (second.steal.steal - oldest.steal.steal),
    } : null;
    const total = last.steal && boundarySteal ? last.steal.total - boundarySteal.total : 0;
    const stealRatio = total > 0 && last.steal && boundarySteal && last.steal.steal >= boundarySteal.steal
      ? (last.steal.steal - boundarySteal.steal) / total : null;
    return { sampledAgeMs: Math.max(0, now - last.at), observedSeconds: seconds,
      windowTargetSeconds: 60, completeWindow: seconds >= 60, throttledRatio,
      boundaryMethod: "linear_interpolation_between_os_counter_samples",
      cgroup: cg ? { available: true as const, ...cg,
        cpuMax: `${cg.quotaUs ?? "max"} ${cg.periodUs}`,
        cpuStat: { usage_usec: cg.usageUs, nr_periods: cg.periods,
          nr_throttled: cg.throttledPeriods, throttled_usec: cg.throttledUs } } : { available: false as const },
      steal: { available: last.steal !== null, scope: "host_all_cpus", ratio: stealRatio } };
  }
}
