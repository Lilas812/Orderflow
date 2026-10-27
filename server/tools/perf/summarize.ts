import * as fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve("data/perf-memory");
const results: unknown[] = [];
for (const phase of process.argv.length > 2 ? process.argv.slice(2) : ["isolated-before", "isolated-after"]) {
  const base = path.join(root, phase);
  const directories = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  for (const entry of directories) {
    if (!entry.isDirectory() || !/^(live|live30|backfill|replay|ranges|dual)-\d+$/.test(entry.name)) continue;
    const directory = path.join(base, entry.name);
    let result: any;
    try { result = JSON.parse(await fs.readFile(path.join(directory, "result.json"), "utf8")); }
    catch { continue; }
    const rows = (await fs.readFile(path.join(directory, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const fullRun = rows.filter(row => row.resource?.pid === result.pid && !row.resource.exited && row.resource.rssKiB);
    const releaseAtUs = result.events.find((event: any) => event.event === "measurement_isolation_release_begin")?.atUs ?? Infinity;
    // Public admission/screenshot checks happen AFTER the timed run and its
    // recovery; do not mislabel their extra clients as single-screen load.
    const measured = fullRun.filter(row => row.atUs <= releaseAtUs);
    const peak = measured.reduce((best, row) => row.resource.rssKiB > (best?.resource.rssKiB ?? 0) ? row : best, null);
    const recovery = result.events.find((event: any) => event.event === "recovery_begin")?.atUs;
    const activeEndUs = result.events.find((event: any) => event.event === "active_measurement_complete")?.atUs ?? recovery;
    const active = measured.filter(row => row.atUs <= activeEndUs);
    const before = result.details.initialStatus?.memory;
    const expectedClients = ["dual", "ranges"].includes(result.scenario) ? 2 : result.scenario === "backfill" ? 0 : 1;
    const controlled = rows.filter(row => row.atUs <= activeEndUs && row.status);
    const maxConnected = Math.max(0, ...controlled.map(row => row.status.phase2b?.connected ?? 0));
    const knownSourcesOnly = controlled.every(row => (row.status.phase2b?.connections ?? [])
      .every((peer: any) => /NQPerf(?:Range)?\/\d+$/.test(peer.userAgent ?? "")));
    const sample = (row: any) => row ? {
      atUs: row.atUs, rssMiB: row.resource.rssKiB / 1024,
       heapMiB: row.status?.memory ? row.status.memory.heapUsed / 1048576 : null,
      cpuPercent: row.resource.cpuPercent, connected: row.status?.phase2b?.connected ?? null,
    } : null;
    results.push({
      phase, scenario: result.scenario, directory,
      startUs: result.startedAtUs, readyUs: result.details.readyAtUs ?? null, endUs: result.endedAtUs,
      failure: result.details.failure ?? null, guard: result.guard, interrupted: result.interrupted,
      validClientIsolation: !result.isolationFailure && maxConnected === expectedClients && knownSourcesOnly,
      completed: !result.details.failure && !result.guard && !result.interrupted && !result.isolationFailure,
      formalCandidate: (!result.details.failure || result.guard) && !result.isolationFailure
        && maxConnected === expectedClients && knownSourcesOnly,
      before: before ? { rssMiB: before.rss / 1048576, heapMiB: before.heapUsed / 1048576 } : null,
      peak: sample(peak), activeEnd: sample(active.at(-1)), recoveryEnd: sample(measured.at(-1)),
      firstObserved: sample(measured[0]),
      heapPeakMiB: Math.max(0, ...measured.map(row => (row.status?.memory?.heapUsed ?? 0) / 1048576)),
      fullRunPeakRssMiB: Math.max(0, ...fullRun.map(row => row.resource.rssKiB / 1024)),
      peakHighWaterMiB: Math.max(0, ...measured.map(row => (row.resource.rssHighWaterKiB ?? row.resource.rssKiB) / 1024)),
      meanCpuPercent: measured.filter(row => row.resource.cpuPercent !== null)
        .reduce((sum, row, _, all) => sum + row.resource.cpuPercent / all.length, 0),
      peakCpuPercent: Math.max(0, ...measured.map(row => row.resource.cpuPercent ?? 0)),
      browserClosed: result.details.browserClosed ?? null,
      staticProxyClosed: result.details.staticProxyClosed ?? null,
      serverExitConfirmed: result.details.serverExitConfirmed ?? null,
      activeCompletedAtUs: activeEndUs,
      isolationReleased: result.details.isolationReleased ?? null,
      releaseCheckAccepted: result.details.publicPreviewWsAccepted ?? null,
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
for (const phase of ["isolated-before", "isolated-after", "isolated-final"]) {
  const file = path.join(root, phase, "render-static/frames.json");
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
