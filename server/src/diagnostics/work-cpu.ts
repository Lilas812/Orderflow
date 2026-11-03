type Category = "live" | "history" | "storage" | "delivery" | "longVp";
/** Attribute only synchronous sections, never an overlapping async await span.
 * Native async gzip/TLS/compression and uninstrumented work remain explicit "other".
 */
export class WorkCpu {
  private samples: { start: number; at: number; category: Category; us: number }[] = [];
  private current = new Map<Category, number>();
  private active: { nested: number }[] = [];
  private baseCpu = process.cpuUsage();
  private baseAt = performance.now();
  private lastSampleAt = this.baseAt;
  private childAt = this.baseAt;
  private totals: { at: number; cpu: number }[] = [{ at: this.baseAt, cpu: 0 }];
  measure<T>(category: Category, work: () => T): T {
    const before = process.threadCpuUsage(), frame = { nested: 0 };
    this.active.push(frame);
    try { return work(); }
    finally {
      this.active.pop();
      const used = process.threadCpuUsage(before), total = used.user + used.system;
      const parent = this.active.at(-1);
      if (parent) parent.nested += total;
      this.current.set(category, (this.current.get(category) ?? 0) + Math.max(0, total - frame.nested));
    }
  }
  child(us: number) {
    const at = performance.now();
    if (us) this.samples.push({ start: this.childAt, at, category: "history", us });
    this.childAt = at;
    this.prune(at);
  }
  sample() {
    const at = performance.now(), cpu = process.cpuUsage(this.baseCpu);
    this.totals.push({ at, cpu: cpu.user + cpu.system });
    for (const [category, us] of this.current) this.samples.push({ start: this.lastSampleAt, at, category, us });
    this.lastSampleAt = at; this.current.clear(); this.prune(at);
    while (this.totals.length > 2 && this.totals[1].at < at - 60000) this.totals.shift();
  }
  private prune(at: number) { this.samples = this.samples.filter(s => s.at >= at - 60000); }
  snapshot() {
    const at = performance.now(); this.prune(at);
    const start = Math.max(this.baseAt, at - 60000), span = (at - start) / 1000;
    const now = process.cpuUsage(this.baseCpu);
    const points = [...this.totals, { at, cpu: now.user + now.system }];
    const index = Math.max(0, points.findIndex(point => point.at >= start));
    const after = points[index], before = points[Math.max(0, index - 1)];
    const fraction = after.at > before.at ? Math.max(0, Math.min(1, (start - before.at) / (after.at - before.at))) : 0;
    const initialCpu = before.cpu + fraction * (after.cpu - before.cpu);
    const parentUs = Math.max(0, now.user + now.system - initialCpu);
    const us: Record<Category, number> = { live: 0, history: 0, storage: 0, delivery: 0, longVp: 0 };
    const overlap = (a: number, b: number) => b > a ? Math.max(0, Math.min(1, (b - Math.max(a, start)) / (b - a))) : 0;
    for (const sample of this.samples) us[sample.category] += sample.us * overlap(sample.start, sample.at);
    for (const [category, pending] of this.current) us[category] += pending * overlap(this.lastSampleAt, at);
    const cores = (value: number) => span > 0 ? value / (span * 1e6) : null;
    const parentKnown = us.live + us.storage + us.delivery + us.longVp;
    return { unit: "cores", observedSeconds: span, windowTargetSeconds: 60,
      parentTotal: cores(parentUs), live: cores(us.live), historyChild: cores(us.history),
      storageSync: cores(us.storage), deliverySync: cores(us.delivery), longVpSync: cores(us.longVp),
      otherParent: cores(Math.max(0, parentUs - parentKnown)),
      boundaryMethod: "cpu_counter_and_interval_overlap_interpolation",
      attribution: "main_thread_synchronous_only; async_native_cpu_in_other; child_cpu_sampled_at_most_5s" };
  }
}
export const workCpu = new WorkCpu();
