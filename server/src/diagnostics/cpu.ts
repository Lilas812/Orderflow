/** cpuUsage is process CPU time, not normalized by available cores. */
export class CpuMonitor {
  private previousCpu = { user: 0, system: 0 };
  private previousAt = process.hrtime.bigint() - BigInt(Math.round(process.uptime() * 1e9));
  private samples: { at: number; seconds: number; cpu: number }[] = [];
  sample() {
    const at = process.hrtime.bigint(), cpu = process.cpuUsage();
    const seconds = Number(at - this.previousAt) / 1e9;
    this.samples.push({ at: Number(at) / 1e9, seconds,
      cpu: (cpu.user + cpu.system - this.previousCpu.user - this.previousCpu.system) / 1e6 });
    this.previousAt = at; this.previousCpu = cpu;
    this.samples = this.samples.filter(s => s.at > Number(at) / 1e9 - 60);
  }
  snapshot() {
    const at = Number(process.hrtime.bigint()) / 1e9;
    const current = process.cpuUsage();
    // Include the interval after the last periodic sample. Otherwise an HTTP
    // request between timer ticks would omit up to five seconds of the window.
    const samples = [...this.samples, { at,
      seconds: at - Number(this.previousAt) / 1e9,
      cpu: (current.user + current.system - this.previousCpu.user - this.previousCpu.system) / 1e6 }];
    const mean = (span: number) => {
      let cpu = 0, wall = 0;
      for (const s of samples) {
        const included = Math.max(0, Math.min(s.seconds, s.at - (at - span)));
        if (s.seconds > 0) { cpu += s.cpu * included / s.seconds; wall += included; }
      }
      return wall ? cpu / wall : null;
    };
    return { unit: "cores", average10s: mean(10), average60s: mean(60),
      sampledSeconds: samples.reduce((n, s) => n + s.seconds, 0) };
  }
}
