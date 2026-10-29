/** 隔離計測：既存のローカル時間gzipを読み、模擬Objectsだけへコピーする。本番接続・書込なし。 */
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createHook } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { AppStore } from "../src/store/app.ts";
import { LocalStore } from "../src/store/local.ts";
import type { Objects } from "../src/store/objects.ts";
import { readTradeRange } from "../src/vp/trade-history.ts";
import { Metrics } from "../src/ingest/metrics.ts";

const source = path.resolve(process.argv.slice(2).find(x => !x.startsWith("--"))
  ?? "data/trades/NQ/2026-10-26/14.jsonl.gz");
const match = source.match(/(\d{4}-\d\d-\d\d)\/(\d\d)\.jsonl\.gz$/);
if (!match) throw Error("expected_local_hourly_nq_trade_gzip");
const h = Date.parse(`${match[1]}T${match[2]}:00:00Z`) / 1000;
const n = `dev/trades/NQ/${match[1]}/${match[2]}.jsonl.gz`;
const bytes = (await fs.stat(source)).size;
let tracking = false, zlib = 0;
createHook({ init: (_, type) => { if (tracking && type === "ZLIB") zlib++; } }).enable();
const log = () => {};

class DiskObjects implements Objects {
  downloads = 0; downloadBytes = 0;
  private coverage = Buffer.from(JSON.stringify({ book: [], tick: [[h, h + 3600]] }));
  async exists(name: string) { return name === "dev/coverage.json" || name === n; }
  async list() { return [n, "dev/coverage.json"]; }
  async upload() { throw Error("benchmark_is_read_only"); }
  async download(name: string, destination: string) {
    if (name === "dev/coverage.json") {
      await fs.writeFile(destination, this.coverage); this.downloadBytes += this.coverage.length;
    } else if (name === n) {
      // The source is local and unchanged; these bytes simulate, but do not claim,
      // actual network transfer. No App Storage client is constructed.
      await fs.copyFile(source, destination); this.downloadBytes += bytes;
    } else throw Error("benchmark_missing");
    this.downloads++;
  }
}
class LegacyAppStore extends AppStore {
  override tradeReadSession(signal: AbortSignal) { return LocalStore.prototype.tradeReadSession.call(this, signal); }
}
type Reading = Awaited<ReturnType<typeof one>>;
async function one(mode: "before" | "after", cached: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dummy-trade-bench-"));
  try {
    const objects = new DiskObjects(), file = path.join(root, `trades/NQ/${match![1]}/${match![2]}.jsonl.gz`);
    if (cached) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.copyFile(source, file); }
    const store = mode === "before"
      ? new LegacyAppStore(root, objects, "dev/", log, () => (h + 80 * 3600) * 1000)
      : new AppStore(root, objects, "dev/", log, () => (h + 80 * 3600) * 1000);
    await store.initialize();
    const init = { requests: objects.downloads, bytes: objects.downloadBytes };
    objects.downloads = 0; objects.downloadBytes = 0;
    global.gc?.();
    const startMem = process.memoryUsage();
    let rssPeak = startMem.rss, heapPeak = startMem.heapUsed;
    const sample = () => {
      const m = process.memoryUsage();
      rssPeak = Math.max(rssPeak, m.rss); heapPeak = Math.max(heapPeak, m.heapUsed);
    };
    const timer = setInterval(sample, 5);
    const start = performance.now(), cpu = process.cpuUsage(), beforeZlib = zlib;
    const hash = createHash("sha256");
    let rows = 0, volume = 0;
    tracking = true;
    let result;
    try {
      result = await readTradeRange({
        store, start: h, end: h + 3600, signal: new AbortController().signal, metrics: new Metrics(log),
        nextSeq: () => 1, source: { get: async () => { throw Error("benchmark_unexpected_REST"); } },
        visit: t => { rows++; volume += t.size; hash.update(JSON.stringify(t) + "\n"); },
      });
      await store.tradeReadsSettled();
    } finally { tracking = false; clearInterval(timer); sample(); }
    const elapsedMs = performance.now() - start, usage = process.cpuUsage(cpu);
    const temp = await fs.readdir(path.join(root, ".trade-read-temporary")).catch(() => []);
    if (temp.length) throw Error("benchmark_temp_leak");
    return { mode, cached, init, rows, volume, digest: hash.digest("hex"),
      fileWindows: result!.fileWindows, read: { requests: objects.downloads, bytes: objects.downloadBytes,
        zlibGunzipInstances: zlib - beforeZlib, wallMs: +elapsedMs.toFixed(2),
        cpuMs: +((usage.user + usage.system) / 1000).toFixed(2),
        rssStart: startMem.rss, rssPeak, rssDelta: rssPeak - startMem.rss,
        heapStart: startMem.heapUsed, heapPeak, heapDelta: heapPeak - startMem.heapUsed },
      pool: store.tradeReadStats };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const results: Reading[] = [];
const requestedMode = process.argv.find(x => x.startsWith("--mode="))?.slice(7);
const selected = requestedMode === "before" || requestedMode === "after" ? requestedMode : undefined;
const selectedCache = process.argv.find(x => x.startsWith("--cached="))?.slice(9);
if (requestedMode && !selected) throw Error("invalid_mode");
if (selectedCache && selectedCache !== "0" && selectedCache !== "1") throw Error("invalid_cache");
for (const cached of [false, true].filter(x => selectedCache === undefined || x === (selectedCache === "1")))
  for (let i = 0; i < (selected ? 1 : 3); i++) {
    if (selected) results.push(await one(selected, cached));
    else {
      const a = await one("before", cached), b = await one("after", cached);
      if (a.digest !== b.digest || a.rows !== b.rows || a.volume !== b.volume
        || a.fileWindows !== b.fileWindows) throw Error("benchmark_results_mismatch");
      results.push(a, b);
    }
  }
console.log(JSON.stringify({ source, gzipBytes: bytes, results }, null, 2));
