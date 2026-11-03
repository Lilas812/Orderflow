// Isolated synthetic microbenchmark: no HTTP/cloud/upstream socket is opened.
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { EventLoopMonitor } from "../src/diagnostics/event-loop.ts";

if (process.argv[2] === "--run") {
  const { Upstream } = await import(process.argv[3]);
  const enabled = process.argv[4] === "after";
  const listeners = new Map();
  const socket = { readyState: 1, addEventListener: (k, v) => listeners.set(k, v), send() {}, close() {} };
  let adopted = 0;
  const monitor = new EventLoopMonitor();
  if (enabled) monitor.start();
  const upstream = new Upstream({ apiKey: "synthetic-no-credential", symbols: ["NQ", "GC"],
    receiver: { metrics: { count() {} }, receive() { adopted++; } }, log() {},
    createSocket: () => socket, eventLoopSnapshot: () => monitor.snapshot() });
  upstream.start(); listeners.get("open")(new Event("open"));
  const message = Object.assign(new Event("message"), { data: "SYNTHETIC" });
  for (let i = 0; i < 2000; i++) listeners.get("message")(message);
  const startCpu = process.cpuUsage(), start = performance.now();
  const iterations = 200000;
  for (let i = 0; i < iterations; i++) {
    listeners.get("message")(message);
    if (i % 500 === 499) await new Promise(setImmediate);
  }
  const elapsedMs = performance.now() - start, cpu = process.cpuUsage(startCpu);
  const rss = process.memoryUsage().rss;
  // Allow the event-loop histogram to observe a separate explicit 80ms stall.
  await new Promise(r => setTimeout(r, 30));
  const end = performance.now() + 80;
  while (performance.now() < end) {}
  await new Promise(r => setTimeout(r, 30));
  const eventLoop = monitor.snapshot();
  const diagnostics = upstream.receiveDiagnostics?.() ?? null;
  const stopped = upstream.stop();
  listeners.get("close")(Object.assign(new Event("close"), { code: 1000, wasClean: true }));
  await stopped; monitor.stop();
  console.log(JSON.stringify({ input: "SYNTHETIC counter-only receiver", iterations, adopted,
    elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, rss,
    eventLoop, diagnostics, stopped: upstream.status.state }));
} else {
  const sha = process.argv[2];
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw Error("Pass full baseline commit SHA");
  const source = new URL("../src/upstream/connection.ts", import.meta.url);
  const baseline = execFileSync("git", ["show", `${sha}:server/src/upstream/connection.ts`], { encoding: "utf8" });
  const dir = await mkdtemp(join(tmpdir(), "heatmap-upstream-baseline-"));
  try {
    const file = join(dir, "connection.ts");
    await writeFile(file, baseline.replace(/from "(\.[^"]+)"/g, (_, relative) => `from "${new URL(relative, source).href}"`));
    const results = [];
    for (let repeat = 0; repeat < 3; repeat++) for (const mode of ["before", "after"]) {
      const module = mode === "before" ? pathToFileURL(file).href : source.href;
      const result = JSON.parse(execFileSync(process.execPath, [new URL(import.meta.url).pathname,
        "--run", module, mode], { encoding: "utf8", timeout: 30000 }));
      results.push({ mode, repeat, ...result });
    }
    const body = { baselineCommit: sha,
      baselineSourceSha256: createHash("sha256").update(baseline).digest("hex"),
      candidateSourceSha256: createHash("sha256").update(await readFile(source)).digest("hex"),
      note: "Synthetic microbenchmark, not actual normalization/feed/Canvas or production validation. RSS includes native event-loop histogram. Explicit stall is after timed workload.",
      results };
    await writeFile("server/UPSTREAM_DIAGNOSTICS_MEASUREMENTS.json", JSON.stringify(body, null, 2) + "\n");
    console.log(JSON.stringify(body, null, 2));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
