// CPU benchmark only; immutable previous production-copy coverage input.
import * as fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compactTickGaps, coveredHours, durableHours } from "../../src/store/coverage.ts";
import { coverageSegments } from "../../src/vp/trade-history.ts";
import { dayBounds, tradingGaps } from "../../src/long-vp/day.ts";
const output = path.resolve("data/dev/coverage-publish-compare");
await fs.mkdir(output, { recursive: true });
const result = [];
for (const symbol of ["NQ", "GC"]) {
  const source = `data/dev/main-thread-snapshot/dev/${symbol === "GC" ? "instruments/GC/" : ""}coverage.json`;
  const bytes = await fs.readFile(source), original = JSON.parse(bytes);
  const indexStarted = performance.now(), indexCpu = process.cpuUsage();
  const cache = await durableHours(original);
  const indexBuildMs = performance.now() - indexStarted, indexUsage = process.cpuUsage(indexCpu);
  const compactStarted = performance.now();
  const cloud = await compactTickGaps(original, cache.tick);
  const local = await compactTickGaps(original);
  const compactionMs = performance.now() - compactStarted;
  const count = v => ({ book: v.book.length, tick: v.tick.length });
  const runs = [], plans = [];
  for (const mode of (process.argv.includes("--setup-only") ? [] : ["before", "after"])) for (let repeat = 0; repeat < 3; repeat++) {
    // SAME original fragmented working/cloud input in both algorithms.
    const cpu = process.cpuUsage(), at = performance.now(), missing = [];
    let visits = 0;
    for (const kind of ["book", "tick"]) {
      if (mode === "before") {
        for (const [a, b] of original[kind]) for (let h = Math.floor(a / 3600) * 3600; h < b; h += 3600) {
          visits++;
          const durable = original[kind].filter(([x, y]) => x < h + 3600 && y > h)
            .map(([x, y]) => [Math.max(x, h), Math.min(y, h + 3600)]);
          if (!durable.length) missing.push(`${kind}:${h}`);
        }
      } else for (const h of coveredHours(original[kind])) {
        visits++; if (!cache[kind].has(h)) missing.push(`${kind}:${h}`);
      }
    }
    const elapsedMs = performance.now() - at, usage = process.cpuUsage(cpu);
    const plan = [...new Set(missing)].sort(); plans.push(plan);
    runs.push({ mode, repeat, elapsedMs, cpuMs: (usage.user + usage.system) / 1000, visits });
  }
  for (const plan of plans) assert.deepEqual(plan, plans[0]);
  const days = [];
  for (const date of ["2026-10-30", "2026-11-02", "2026-11-03"]) {
    const b = dayBounds(date), gaps = v => tradingGaps(date, coverageSegments(v.tick, b.startUs / 1e6, b.endUs / 1e6)
      .filter(s => !s.covered).map(s => [s.start, s.end]));
    const before = gaps(original), after = gaps(cloud);
    const remaining = after.filter(([a, b]) => b - a > 30).map(([a, b]) => ({
      startSec: a, endSec: b, seconds: b - a, startUtc: new Date(a * 1000).toISOString(), endUtc: new Date(b * 1000).toISOString(),
    }));
    days.push({ date, before: before.length, after: after.length,
      missingSecondsBefore: before.reduce((s, [a, b]) => s + b - a, 0),
      missingSecondsAfter: after.reduce((s, [a, b]) => s + b - a, 0), remainingOver30: remaining,
      ...(process.argv.includes("--setup-only") ? { remainingAll: after.map(([a, b]) => ({
        startSec: a, endSec: b, seconds: b - a,
        startUtc: new Date(a * 1000).toISOString(), endUtc: new Date(b * 1000).toISOString(),
      })) } : {}) });
  }
  result.push({ symbol, source, sha256: createHash("sha256").update(bytes).digest("hex"),
    indexBuildMs, indexCpuMs: (indexUsage.user + indexUsage.system) / 1000, compactionMs,
    before: { localRecreated: count(original), cloud: count(original) },
    after: { localRecreated: count(local), cloud: count(cloud) }, runs, days,
    originalBytesUnchanged: bytes.equals(await fs.readFile(source)) });
}
await fs.writeFile(path.join(output, process.argv.includes("--setup-only") ? "setup.json" : "result.json"),
  JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.map(r => ({ symbol: r.symbol, before: r.before, after: r.after, runs: r.runs,
  days: r.days.map(({ remainingOver30, ...d }) => ({ ...d, over30: remainingOver30.length })) })), null, 2));
