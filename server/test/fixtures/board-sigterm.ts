/** ダミー process fixture: filesystem-backed fake cloud; NO real sockets/SDK. */
import * as fs from "node:fs/promises";
import path from "node:path";
import { AppStore } from "../../src/store/app.ts";
import { Pipeline } from "../../src/pipeline.ts";

const root = process.argv[2];
const cloud = path.join(root, "dummy-cloud");
const objects = {
  async exists(name: string) { try { await fs.access(path.join(cloud, name)); return true; } catch { return false; } },
  async download(name: string, file: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.copyFile(path.join(cloud, name), file); },
  async upload(name: string, file: string) { const dest = path.join(cloud, name); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(file, dest); },
  async list() { return []; },
};
const sec = Math.floor(Date.now() / 1000) + 1;
const store = new AppStore(path.join(root, "working"), objects, "dev/", () => {});
const pipeline = new Pipeline("dummy", () => 1, () => {}, () => {}, store, "NQ",
  async () => { throw Error("dummy_network_forbidden"); });
process.once("SIGTERM", async () => {
  const started = performance.now(), budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), 9000);
  const hard = setTimeout(() => process.exit(2), 9500);
  try {
    store.beginShutdown(budget.signal); await pipeline.stop();
    const restored = new AppStore(path.join(root, "fresh-disk"), objects, "dev/", () => {});
    await restored.initialize();
    const view = await restored.readView(sec, sec + 1);
    process.send?.({ stopped: true, columns: view.columns.length, trades: view.trades.length,
      elapsedMs: performance.now() - started, remaining: store.shutdownSummary().remaining.length });
    clearTimeout(timer); clearTimeout(hard); process.exit(0);
  } catch { clearTimeout(timer); clearTimeout(hard); process.exit(1); }
});
await pipeline.initialize();
pipeline.trade({ tsUs: sec * 1e6, recvUs: sec * 1e6, seq: 1, size: 2, side: "buy", price: 100 });
pipeline.book({ tsUs: sec * 1e6, recvUs: sec * 1e6, source: "live",
  bids: [{ price: 100, size: 2 }], asks: [{ price: 101, size: 3 }] });
process.send?.({ ready: true });
