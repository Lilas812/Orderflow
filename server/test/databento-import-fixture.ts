/** ISOLATED purchased REAL trades. Settings I/O is dummy. NO upstream/cloud/write endpoints. */
import express from "express";
import * as fs from "node:fs/promises";
import path from "node:path";
import { LocalStore } from "../src/store/local.ts";
import { Pipeline } from "../src/pipeline.ts";
import { Hub, attachHub, type Source } from "../src/hub/hub.ts";
import { VolumeProfile } from "../src/vp/state.ts";
import { defaults } from "../src/settings/schema.ts";
import { defaults as longVpDefaults } from "../../artifacts/heatmap/src/long-vp/settings-schema.ts";
import { longVpRouter } from "../src/long-vp/routes.ts";
import type { AppLongVp } from "../src/long-vp/app-service.ts";
import type { DayData } from "../src/long-vp/day.ts";
const arg = (n: string) => process.argv.find(s => s.startsWith(`--${n}=`))?.slice(n.length + 3);
const manifest = JSON.parse(await fs.readFile(path.join(arg("out") ?? "data/databento-import", "active.json"), "utf8"));
const contract = arg("contract") ?? "NQZ26", root = path.join(manifest.generation, contract);
const symbol = contract.startsWith("GC") ? "GC" : "NQ";
const at = Date.parse(arg("at") ?? "2026-10-01T14:35:00Z");
const port = Number(arg("port") ?? 18801);
class IsolatedStore extends LocalStore { protected override async retention() {} }
const store = new IsolatedStore(root, () => at, undefined, symbol);
await store.initialize();
// Use real product methods; do not construct Pipeline or its network/backfill services.
const pipeline = Object.create(Pipeline.prototype) as Pipeline;
Object.assign(pipeline, { store, tradeBatch: [], seam: manifest.toUs / 1e6,
  backfill: { status: { gaps: [], noData: [] } } });
const vp = new VolumeProfile(at / 1000);
let profileCount = 0;
await store.visitTrades(vp.start, at / 1000, t => {
  if (t.contract === contract) { vp.add(t); profileCount++; }
});
const source: Source = {
  savedRange: () => ({ fromSec: manifest.fromUs / 1e6, toSec: manifest.toUs / 1e6 }),
  read: async (from, to) => {
    const view = await pipeline.readRange(from, Math.min(to, at / 1000));
    // Purchased schema is trades only; legacy depth has not been contract-matched.
    return { columns: [], trades: view.trades.filter(t => t.contract === contract) };
  },
  readTrades: (from, to, visit, signal) => pipeline.readFootprintRange(from, Math.min(to, at / 1000),
    t => { if (t.contract === contract) visit(t); }, signal),
  ownsLiveTrade: () => false,
  status: () => ({ isolated: true, purchased: true }),
  vp: () => vp,
  replayVp: (from, alive) => pipeline.replayVp(from, alive),
};
const events: { event: string; detail?: unknown }[] = [];
const hub = new Hub(source, (event, detail) => { events.push({ event, detail }); },
  { now: () => at, later: (fn, ms) => setTimeout(fn, ms), cancel: t => clearTimeout(t as ReturnType<typeof setTimeout>) }, symbol);
const days = new Map<string, DayData>();
for (const file of await fs.readdir(path.join(root, "longvp"))) {
  const day = JSON.parse(await fs.readFile(path.join(root, "longvp", file), "utf8")) as DayData;
  days.set(day.tradingDate, day);
}
const longService = { repository: { symbol, records: days, day: async (date: string) => days.get(date)! },
  rolls: () => [], today: () => null, frontContract: () => contract } as unknown as AppLongVp;
const app = express(), front = path.resolve("artifacts/heatmap/dist/public");
app.get("/api/settings", (_req, res) => res.json({ version: 4, updatedAt: null, values: defaults }));
app.get("/api/settings/longvp", (_req, res) => res.json({ version: 1, updatedAt: null, values: longVpDefaults }));
app.use("/api/longvp", longVpRouter(longService, requested => requested === symbol ? longService : null));
app.get("/__import/status", (_req, res) => res.json({ isolated: true, purchased: true, pid: process.pid,
  contract, atUs: at * 1000, profileCount, profile: vp.summary(), daily: vp.dailyMessage(),
  root, hub: hub.snapshot(), connections: hub.connections(), days: [...days.keys()], events }));
app.get("/", async (_req, res) => res.type("html").send((await fs.readFile(path.join(front, "index.html"), "utf8"))
  .replace("</body>", `<div style="position:fixed;bottom:0;right:0;z-index:99999;background:#111;color:#ff0;font:11px monospace">隔離・Databento購入実データ ${contract} ${new Date(at).toISOString()} / 板未補修・設定はダミー</div></body>`)));
app.use(express.static(front));
const http = app.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ isolated: true, purchased: true, port, pid: process.pid,
  contract, profileCount, profile: vp.summary() })));
attachHub(http, new Map([[symbol, hub]]));
process.once("SIGTERM", () => {
  hub.stop(); http.closeAllConnections(); http.close(() => { console.log(JSON.stringify({ isolated: true, stopped: true, connected: hub.snapshot().connected })); });
});
