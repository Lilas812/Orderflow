import { monitorEventLoopDelay } from "node:perf_hooks";

/** Bounded native histogram. A snapshot does not consume another observer's window. */
export class EventLoopMonitor {
  private readonly histogram = monitorEventLoopDelay();
  private running = false;
  private since = performance.now();
  private times = new Float64Array(4096);
  private elapsed = new Float64Array(4096);
  private cursor = 0;
  private count = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.running) return;
    this.running = true;
    this.since = performance.now();
    this.histogram.reset();
    this.histogram.enable();
    let previous = performance.now();
    this.timer = setInterval(() => {
      const at = performance.now();
      this.times[this.cursor] = at; this.elapsed[this.cursor] = at - previous;
      previous = at; this.cursor = (this.cursor + 1) % this.times.length;
      this.count = Math.min(this.times.length, this.count + 1);
    }, 10);
    this.timer.unref();
  }

  window(ms: 10000 | 30000) {
    const at = performance.now(), values: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.times[i] > at - ms) values.push(this.elapsed[i]);
    values.sort((a, b) => a - b);
    return { samples: values.length, p99Ms: values.length ? values[Math.ceil(values.length * .99) - 1] : null,
      maxMs: values.at(-1) ?? null, windowMs: ms,
      method: "10ms_timer_interval_elapsed; includes_sampling_interval" };
  }

  snapshot() {
    const count = this.histogram.count;
    const ms = (value: number) => count ? value / 1e6 : null;
    return { enabled: this.running, unit: "ms", windowMs: Math.max(0, performance.now() - this.since),
      samples: count, meanMs: ms(this.histogram.mean), p95Ms: ms(this.histogram.percentile(95)),
      maxMs: ms(this.histogram.max) };
  }

  reset() {
    this.histogram.reset();
    this.since = performance.now();
  }

  stop() {
    this.histogram.disable();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }
}
