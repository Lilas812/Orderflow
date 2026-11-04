/** Synthetic, isolated CPU/heap comparison. No server, SDK, network or real data.
 * Usage: node server/tools/bench-board-stages.mjs [before|after]
 * No argument runs five alternating fresh-process pairs. */
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const mode = process.argv[2], workspace = fileURLToPath(new URL("../../", import.meta.url));
const baseline = "6def822acb1bdce430d00c18093737a4afc77596";
if (!mode) {
  const results = [];
  for (let pair = 0; pair < 5; pair++) for (const item of pair % 2 ? ["after", "before"] : ["before", "after"]) {
    results.push(JSON.parse(execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), item],
      { encoding: "utf8" })));
  }
  console.log(JSON.stringify({ baseline, synthetic: true, results }, null, 2));
  process.exit(0);
}
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "board-stage-bench-"));
try {
  let receiverUrl = new URL("../src/ingest/receiver.ts", import.meta.url).href;
  if (mode === "before") {
    for (const name of ["normalize", "receiver"]) {
      const original = `server/src/ingest/${name}.ts`;
      const source = execFileSync("git", ["show", baseline + ":" + original], { cwd: workspace, encoding: "utf8" })
        .replace(/from "(\.[^"]+)"/g, (_, rel) => `from "${name === "receiver" && rel === "./normalize.ts"
          ? pathToFileURL(path.join(dir, "normalize.ts")).href
          : pathToFileURL(path.resolve(workspace, "server/src/ingest", rel)).href}"`);
      await fs.writeFile(path.join(dir, name + ".ts"), source);
    }
    receiverUrl = pathToFileURL(path.join(dir, "receiver.ts")).href;
  }
  const { Receiver } = await import(receiverUrl);
  const { Pipeline } = await import(new URL("../src/pipeline.ts", import.meta.url));
  const { LocalStore } = await import(new URL("../src/store/local.ts", import.meta.url));
  const { BoardStageLogger } = await import(new URL("../src/diagnostics/board-stages.ts", import.meta.url));
  const { Upstream } = await import(new URL("../src/upstream/connection.ts", import.meta.url));
  const nq = new Receiver(() => {}), gc = new Receiver(() => {}, {}, "GC");
  let now = 0, logBytes = 0, logLines = 0;
  const upstream = new Upstream({ apiKey: "dummy", receiver: nq, log: () => {},
    createSocket: () => { throw Error("dummy_network_forbidden"); } });
  const loggers = [nq, gc].map(receiver => new BoardStageLogger(receiver,
    new Pipeline("dummy", () => 1, () => {}, () => {}, new LocalStore(dir)),
    () => upstream, (_event, data) => { logLines++; logBytes += Buffer.byteLength(JSON.stringify(data)); }, () => now));
  const messages = ["NQ", "GC"].map(symbol => JSON.stringify({ type: "book", symbol, ts: 1793750400,
    bids: Array.from({ length: 400 }, (_, i) => [2000 - i * (symbol === "NQ" ? .25 : .1), 5]),
    asks: Array.from({ length: 400 }, (_, i) => [2001 + i * (symbol === "NQ" ? .25 : .1), 7]) }));
  for (let i = 0; i < 1000; i++) [nq, gc][i % 2].receive(messages[i % 2], 1793750400000000, () => {});
  global.gc?.();
  const initial = process.memoryUsage(), cpu = process.cpuUsage(), started = performance.now();
  for (let i = 0; i < 12000; i++) {
    [nq, gc][i % 2].receive(messages[i % 2], 1793750400000000, () => {});
    if (mode === "after" && i % 480 === 479) { now += 60000; for (const logger of loggers) logger.emit(); }
  }
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu), memory = process.memoryUsage();
  console.log(JSON.stringify({ mode, books: 12000, levelsPerBook: 800, cpuMs: (used.user + used.system) / 1000,
    elapsedMs, rss: memory.rss, heapDelta: memory.heapUsed - initial.heapUsed, logLines, logBytes }));
} finally { await fs.rm(dir, { recursive: true, force: true }); }
