import * as fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve("data/perf-memory");
const results: unknown[] = [];
for (const phase of ["before", "after"]) {
  const base = path.join(root, phase);
  const directories = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  for (const entry of directories) {
    if (!entry.isDirectory() || !/^(live|live30|backfill|replay|ranges|dual)-\d+$/.test(entry.name)) continue;
    const directory = path.join(base, entry.name);
    let result: any;
    try { result = JSON.parse(await fs.readFile(path.join(directory, "result.json"), "utf8")); }
    catch { continue; }
    const rows = (await fs.readFile(path.join(directory, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const measured = rows.filter(row => row.resource && !row.resource.exited && row.resource.rssKiB);
    const peak = measured.reduce((best, row) => row.resource.rssKiB > (best?.resource.rssKiB ?? 0) ? row : best, null);
    const recovery = result.events.find((event: any) => event.event === "recovery_begin")?.atUs;
    const active = measured.filter(row => row.atUs <= recovery);
    const before = result.details.initialStatus?.memory;
    const expectedClients = ["dual", "ranges"].includes(result.scenario) ? 2 : result.scenario === "backfill" ? 0 : 1;
    const maxConnected = Math.max(0, ...rows.map(row => row.status?.phase2b?.connected ?? 0));
    const sample = (row: any) => row ? {
      atUs: row.atUs, rssMiB: row.resource.rssKiB / 1024,
      heapMiB: (row.status?.memory?.heapUsed ?? 0) / 1048576,
      cpuPercent: row.resource.cpuPercent, connected: row.status?.phase2b?.connected ?? null,
    } : null;
    results.push({
      phase, scenario: result.scenario, directory,
      startUs: result.startedAtUs, readyUs: result.details.readyAtUs ?? null, endUs: result.endedAtUs,
      failure: result.details.failure ?? null, guard: result.guard, interrupted: result.interrupted,
      validClientIsolation: !result.details.failure && !result.isolationFailure && maxConnected <= expectedClients,
      before: before ? { rssMiB: before.rss / 1048576, heapMiB: before.heapUsed / 1048576 } : null,
      peak: sample(peak), activeEnd: sample(active.at(-1)), recoveryEnd: sample(measured.at(-1)),
      firstObserved: sample(measured[0]),
      heapPeakMiB: Math.max(0, ...rows.map(row => (row.status?.memory?.heapUsed ?? 0) / 1048576)),
      maxConnected,
      samples: rows.length,
      lastStatus: result.details.finalStatus?.phase2b,
      backfill: result.details.finalStatus?.phase2a?.backfill,
      replayHeadUs: result.details.endDebug?.replayHeadUs ?? null,
      ranges: result.details.ranges ?? null,
      browsing: result.details.pastEndDebug ? {
        follow: result.details.pastEndDebug.follow, rangeRequests: result.details.pastEndDebug.rangeRequestCount,
        viewport: result.details.pastEndDebug.viewport,
      } : null,
    });
  }
}
const rendering: unknown[] = [];
for (const phase of ["before", "after"]) {
  const file = path.join(root, phase, "render/frames.json");
  let cases: any[];
  try { cases = JSON.parse(await fs.readFile(file, "utf8")); } catch { continue; }
  for (const operation of cases) {
    const frames = operation.frames;
    const metrics: Record<string, unknown> = {};
    for (const key of ["totalMs", "heatmapMs", "tradesMs", "bookMs", "bigMs", "priceAxisMs", "timeAxisMs",
      "aggregationMs", "scaleMs", "rasterMs", "colorMs", "uploadMs", "tileSyncMs", "otherMs"]) {
      metrics[key] = { mean: frames.length ? frames.reduce((n: number, f: any) => n + f[key], 0) / frames.length : null,
        max: frames.length ? Math.max(...frames.map((f: any) => f[key])) : null };
    }
    const worst = frames.reduce((best: any, frame: any) => frame.totalMs > (best?.totalMs ?? -1) ? frame : best, null);
    rendering.push({ phase, operation: operation.name, count: frames.length, before: operation.before,
      after: operation.after, p99: operation.p99, metrics, worst });
  }
}
const summary = { generatedAtUs: Date.now() * 1000, memory: results, rendering };
await fs.writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
