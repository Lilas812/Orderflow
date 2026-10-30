/** ダミー：fixed-work storage CPU comparison, no network or runtime startup.
 * --before=/tmp/.../local.ts points to an untouched, import-rewritten baseline. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { LocalStore } from "../../src/store/local.ts";
import type { Range } from "../../src/store/local.ts";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { encodeColumns } from "../../src/store/binary.ts";

const arg = (key: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const before = arg("before");
if (!before) throw Error("baseline_required");
const Previous: typeof LocalStore = (await import(pathToFileURL(path.resolve(before)).href)).LocalStore;
const out = path.resolve(arg("out") ?? "data/cpu-maintenance");
await fs.mkdir(out, { recursive: true });
const now = Date.UTC(2026, 9, 30, 12), sec = now / 1000;
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const results: Record<string, unknown>[] = [];

for (let round = 1; round <= 3; round++) {
  for (const variant of round === 2 ? ["after", "before"] : ["before", "after"]) {
    for (const workload of ["coverage", "idle", "writes"]) {
      const StoreClass = variant === "before" ? Previous : LocalStore;
      const roots: string[] = [];
      const stores: LocalStore[] = [];
      let lists = 0, fullStats = 0, indexWrites = 0;
      try {
        for (const symbol of ["NQ", "GC"] as const) {
          const root = await fs.mkdtemp(path.join(os.tmpdir(), `dummy-cpu-${symbol}-`)); roots.push(root);
          const coverage: Range[] = Array.from({ length: 12000 }, (_, i) => [sec - 86400 + i * 3, sec - 86400 + i * 3 + 1]);
          await fs.writeFile(path.join(root, "coverage.json"), JSON.stringify({ book: coverage, tick: coverage }));
          if (workload !== "coverage") {
            for (let h = sec - 48 * 3600; h < sec; h += 3600) {
              const d = new Date(h * 1000).toISOString();
              for (const kind of ["book", "tick"]) {
                const rel = kind === "book" ? `columns/${symbol}/1s/${d.slice(0, 10)}/${d.slice(11, 13)}.bin.gz`
                  : `trades/${symbol}/${d.slice(0, 10)}/${d.slice(11, 13)}.jsonl.gz`;
                const f = path.join(root, rel); await fs.mkdir(path.dirname(f), { recursive: true });
                const bytes = kind === "book" ? encodeColumns([{ tsSec: h, source: "history",
                  bids: [{ price: 400, size: 17 }], asks: [{ price: 401, size: 23 }] }])
                  : JSON.stringify({ tsUs: h * 1e6, recvUs: h * 1e6, seq: 1, price: 401, size: 3, side: "buy" }) + "\n";
                await fs.writeFile(f, gzipSync(bytes));
              }
            }
          }
          const store = new StoreClass(root, () => now, fs.rename, symbol);
          await store.initialize(); await store.maintenance();
          const hooks = store as unknown as { allFiles(): Promise<string[]>; atomic(file: string, bytes: Buffer | string): Promise<void> };
          const oldList = hooks.allFiles.bind(store), oldAtomic = hooks.atomic.bind(store), oldStats = store.refreshStats.bind(store);
          hooks.allFiles = async () => { lists++; return oldList(); };
          hooks.atomic = async (file, bytes) => { if (file.endsWith("coverage.json")) indexWrites++; return oldAtomic(file, bytes); };
          store.refreshStats = async () => { fullStats++; return oldStats(); };
          stores.push(store);
        }
        const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
        await new Promise(r => setTimeout(r, 20));
        const cpu = process.cpuUsage(), started = performance.now(), rssBefore = process.memoryUsage().rss;
        if (workload === "coverage") {
          for (const store of stores) for (let i = 0; i < 6000; i++) {
            // Same 100 trade seconds, including repeats and timestamp rollback.
            const t = sec - 100 + (i % 100);
            store.markCovered("tick", t, t + 1);
          }
        } else {
          for (let i = 0; i < 60; i++) for (const store of stores) {
            if (workload === "writes") {
              const t = sec + i;
              await store.addColumns([{ tsSec: t, source: "live", bids: [{ price: 400, size: 17 }], asks: [{ price: 401, size: 23 }] }]);
              await store.addTrades(Array.from({ length: 100 }, (_, seq) => ({
                tsUs: t * 1e6, recvUs: t * 1e6, seq: i * 100 + seq, price: 401, size: 3, side: "buy" as const,
              })));
            }
            await store.maintenance();
          }
        }
        const wallMs = performance.now() - started, used = process.cpuUsage(cpu);
        await new Promise(r => setTimeout(r, 20)); delay.disable();
        const memory = process.memoryUsage();
        const checks = [];
        for (const store of stores) {
          if (workload === "coverage") await store.maintenance();
          checks.push({ symbol: store.symbol, coverageHash: hash(await store.recordedTickCoverage()),
            ...workload !== "coverage" ? { stats: { files: store.stats.files, bytes: store.stats.bytes } } : {} });
        }
        const record = { dummy: true, round, variant, workload, symbols: ["NQ", "GC"],
          intervalsPerKindPerMarket: 12000, inputCalls: workload === "coverage" ? 12000 : 120,
          simulatedSeconds: workload === "writes" ? 60 : null, realtime: false,
          wallMs, cpuMs: (used.user + used.system) / 1000, rssBefore, rssAfter: memory.rss, heapAfter: memory.heapUsed,
          loopMaxMs: delay.max / 1e6, lists, fullStats, indexWrites, checks };
        results.push(record); await fs.writeFile(path.join(out, "results.json"), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(record));
      } finally { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); }
    }
  }
}
for (const workload of ["coverage", "idle", "writes"]) {
  const rows = results.filter(r => r.workload === workload);
  if (new Set(rows.map(r => hash(r.checks))).size !== 1) throw Error(`before_after_mismatch:${workload}`);
}
