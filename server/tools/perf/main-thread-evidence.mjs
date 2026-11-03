import * as fs from "node:fs/promises";
import path from "node:path";
import { Session } from "node:inspector";
import { coverageSegments } from "../../src/vp/trade-history.ts";
import { MainThreadMonitor } from "../../src/diagnostics/main-thread.ts";
import { profileSummary } from "../../src/diagnostics/cpu-profile.ts";
import { dayBounds } from "../../src/long-vp/day.ts";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";

// Exact pre-change algorithm; same boundary semantics, intentionally quadratic.
function reference(ranges, start, end) {
  const result = [];
  for (let a = start; a < end;) {
    const covered = ranges.some(([x, y]) => x <= a && a < y);
    const b = Math.min(end, ...ranges.flat().filter(x => x > a && x < end));
    result.push({ start: a, end: b, covered }); a = b;
  }
  return result;
}
const root = "data/dev/main-thread-evidence";
await fs.mkdir(root, { recursive: true });
const manifest = JSON.parse(await fs.readFile("data/dev/main-thread-snapshot/manifest.json", "utf8"));
const cases = [{ label: "dummy_3730_intervals", ranges: Array.from({ length: 3730 }, (_, i) => [i * 20, i * 20 + 10]), start: 0, end: 74600 }];
for (const f of manifest.files.filter(f => f.source.endsWith("/coverage.json"))) {
  const ranges = JSON.parse(await fs.readFile(f.file, "utf8")).tick;
  for (const date of ["2026-10-30", "2026-11-02"]) {
    const b = dayBounds(date);
    cases.push({ label: `${f.source}:${date}`, ranges, start: b.startUs / 1e6, end: b.endUs / 1e6 });
  }
}
const results = [];
for (const c of cases) {
  const s = new Session(); s.connect();
  const post = (m, p = {}) => new Promise((ok, no) => s.post(m, p, (e, r) => e ? no(e) : ok(r)));
  await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 5000 }); await post("Profiler.start");
  let expected;
  for (const [mode, fn] of [["before", reference], ["after", coverageSegments]]) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await turn(); const cpu = process.cpuUsage(), start = performance.now();
      const result = fn(c.ranges, c.start, c.end);
      const ms = performance.now() - start, used = process.cpuUsage(cpu);
      if (expected) assert.deepEqual(result, expected); else expected = result;
      runs.push({ ms, cpuMs: (used.user + used.system) / 1000, segments: result.length, rss: process.memoryUsage().rss });
    }
    results.push({ label: c.label, intervals: c.ranges.length, mode, runs });
  }
  const { profile } = await post("Profiler.stop"); s.disconnect();
  await fs.writeFile(path.join(root, `${results.length}-summary.json`), JSON.stringify(await profileSummary(profile), null, 2));
}
const overhead = [];
for (const enabled of [false, true]) {
  const m = new MainThreadMonitor(() => {});
  if (enabled) m.start();
  await turn(); const cpu = process.cpuUsage(), start = performance.now();
  for (let i = 0; i < 20000; i++) await Promise.resolve(i);
  const used = process.cpuUsage(cpu);
  overhead.push({ label: "dummy_20000_promise_callbacks", enabled, elapsedMs: performance.now() - start,
    cpuMs: (used.user + used.system) / 1000, resources: m.snapshot().trackedResources });
  m.stop();
}
await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ label: "short_isolated_function_measurement_not_60min_server", results, overhead }, null, 2));
console.log(JSON.stringify({ cases: cases.length, results, overhead }));
