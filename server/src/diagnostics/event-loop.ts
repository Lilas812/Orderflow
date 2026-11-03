import { monitorEventLoopDelay } from "node:perf_hooks";

/** Bounded native histogram. A snapshot does not consume another observer's window. */
export class EventLoopMonitor {
  private readonly histogram = monitorEventLoopDelay();
  private running = false;
  private since = performance.now();

  start() {
    if (this.running) return;
    this.running = true;
    this.since = performance.now();
    this.histogram.reset();
    this.histogram.enable();
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
    this.running = false;
  }
}
