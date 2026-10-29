/** Isolated HTTP / real staging I/O / ダミー Objects. No upstream or cloud access.
 * Measures the same createLogger sanitizer+serialization with a local buffered
 * file sink. Results do not measure a production log collector.
 */
import express from "express";
import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { settingsRouter } from "../src/settings/routes.ts";
import { AppSettings } from "../src/settings/app.ts";
import { defaults } from "../src/settings/schema.ts";
import { SettingsTrace } from "../src/settings/trace.ts";
import { createLogger } from "../src/logger.ts";
import type { Objects } from "../src/store/objects.ts";

const out = path.resolve(`data/settings-trace-overhead-${Date.now()}`);
await fs.mkdir(out, { recursive: true });
const results: object[] = [];
for (const [index, enabled] of [false, true, true, false].entries()) {
  const dir = path.join(out, String(index)); await fs.mkdir(dir);
  let bytes = Buffer.from(JSON.stringify({ version: 4, values: defaults, updatedAt: 1 }));
  const objects: Objects = {
    exists: async () => true, list: async () => [],
    download: async (_name, file) => { await fs.writeFile(file, bytes); },
    upload: async (_name, file) => { bytes = await fs.readFile(file); },
  };
  const sink = createWriteStream(path.join(dir, "trace.jsonl"));
  let lines = 0, logBytes = 0;
  const log = createLogger("ダミー-secret", line => {
    lines++; logBytes += Buffer.byteLength(line) + 1; sink.write(line + "\n");
  });
  const trace = new SettingsTrace(log, () => ({
    backfill: "idle", vpHistory: "complete", requests: 0, errors: 0, retries: 0, waiting: false,
  }), "development", "app-storage");
  const store = new AppSettings(path.join(dir, "settings.json"), objects, "dummy/", () => {});
  const app = express(); app.use("/api/settings", settingsRouter(store, trace));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/settings`;
  const request = async (i: number) => {
    const start = performance.now();
    const res = await fetch(url, i % 2 ? { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { ...defaults, bubbleMin: 20 } }) } : undefined);
    assert.equal(res.status, 200); assert.equal((await res.json()).version, 4);
    return performance.now() - start;
  };
  try {
    // Warm up HTTP, fs and JIT with observation off in every group.
    for (let i = 0; i < 20; i++) await request(i);
    if (enabled) trace.start();
    const cpu = process.cpuUsage(), started = performance.now(), samples: number[] = [];
    for (let i = 0; i < 100; i++) samples.push(await request(i));
    const used = process.cpuUsage(cpu), elapsedMs = performance.now() - started;
    trace.stop();
    samples.sort((a, b) => a - b);
    results.push({ enabled, requests: 100, wallMs: elapsedMs,
      cpuMs: (used.user + used.system) / 1000, meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
      p95Ms: samples[94], logLines: lines, logBytes, serverPort: port });
  } finally {
    trace.stop(); server.closeIdleConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(server.listening, false);
    sink.end(); await once(sink, "finish");
  }
}
await fs.writeFile(path.join(out, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ out, results, isolatedServersClosed: true, browserStarted: false }));
