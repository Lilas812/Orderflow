import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createServer } from "node:net";

const source = fileURLToPath(new URL("../src", import.meta.url));
const modules = fileURLToPath(new URL("../node_modules", import.meta.url));

async function fixture(corrupt = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "heatmap-startup-process-"));
  await fs.mkdir(path.join(root, "server"));
  await fs.cp(source, path.join(root, "server/src"), { recursive: true });
  // The dedicated long-VP settings schema is shared with the browser.
  const shared = "artifacts/heatmap/src/long-vp/settings-schema.ts";
  await fs.mkdir(path.dirname(path.join(root, shared)), { recursive: true });
  await fs.copyFile(fileURLToPath(new URL("../../" + shared, import.meta.url)), path.join(root, shared));
  await fs.symlink(modules, path.join(root, "server/node_modules"), "dir");
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const sec = Math.floor(Date.now() / 3600000) * 3600 + 1;
  const stamp = new Date(sec * 1000).toISOString();
  const file = path.join(root, "data/trades/NQ", stamp.slice(0, 10), stamp.slice(11, 13) + ".jsonl.gz");
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Large enough to exercise a real gzip reader; never contacts TICK STREAM.
  const line = JSON.stringify({ tsUs: sec * 1e6, recvUs: sec * 1e6, seq: 1, price: 400, size: 1, side: "buy" }) + "\n";
  await fs.writeFile(file, corrupt ? Buffer.from("ダミー：破損gzip") : gzipSync(line.repeat(40000)));
  const index = path.join(root, "data/coverage.json");
  await fs.writeFile(index, JSON.stringify({ book: [], tick: [[sec, sec + 1]] }));
  return { root, file, index };
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return port;
}

for (const mode of ["ready", "cancel", "corrupt"] as const) {
  test(`ダミー：子プロセス起動 ${mode} は準備前に待受せず、SIGTERM/失敗時に正常終了`, { timeout: 20000 }, async () => {
    const f = await fixture(mode === "corrupt");
    const before = [await fs.readFile(f.file), await fs.readFile(f.index)];
    const child = spawn(process.execPath, [path.join(f.root, "server/src/index.ts")], {
      cwd: f.root, env: { ...process.env, PORT: String(await freePort()), TICKSTREAM_API_KEY: "dummy-startup-test",
        REPLIT_DEPLOYMENT: "0", HEATMAP_STORAGE: "local", LONG_VP_DEV_ENABLE: "0", HEATMAP_SERVE_FRONTEND: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    const logs: { event: string; details: any }[] = [];
    const output = createInterface({ input: child.stdout });
    child.stderr.resume();
    output.on("line", line => {
      try {
        const entry = JSON.parse(line); logs.push(entry);
        if (mode === "cancel" && entry.event === "storage_initializing") child.kill("SIGTERM");
        if (mode === "ready" && entry.event === "server_listening") child.kill("SIGTERM");
      } catch { /* Node runtime notices are not JSON application events. */ }
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      const [code, signal] = await exited;
      assert.equal(signal, null);
      assert.equal(code, mode === "corrupt" ? 1 : 0);
      const events = logs.map(l => l.event);
      assert.ok(events.includes("storage_initializing"));
      const stopped = logs.find(l => l.event === "server_stopped")?.details;
      assert.ok(stopped);
      assert.equal(stopped.upstream, "stopped");
      assert.equal(stopped.httpClosed, true);
      assert.equal(stopped.storageInitialized, mode === "ready");
      assert.ok(stopped.elapsedMs < 9500);
      if (mode === "ready") {
        assert.ok(events.indexOf("server_listening") > events.indexOf("storage_initialized"));
        assert.ok(events.includes("upstream_disabled"));
      } else {
        assert.ok(!events.includes("storage_initialized"));
        assert.ok(!events.includes("server_listening"));
        assert.ok(!events.includes("storage_stopped"));
      }
      assert.equal(events.includes("startup_failed"), mode === "corrupt");
      assert.deepEqual(await fs.readFile(f.file), before[0]);
      assert.deepEqual(await fs.readFile(f.index), before[1]);
      assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      output.close();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
}
