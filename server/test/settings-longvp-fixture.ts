/** ダミー隔離専用。上流・実App Storage・既存受信を起動しない。 */
import express from "express";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { AppSettings } from "../src/settings/app.ts";
import { LongVpSettings, longVpSettingsRouter } from "../src/settings/longvp.ts";
import { settingsRouter } from "../src/settings/routes.ts";
import { SettingsTrace } from "../src/settings/trace.ts";
import { AppLongVp, type LongDependencies } from "../src/long-vp/app-service.ts";
import { longVpRouter } from "../src/long-vp/routes.ts";
import { dayAt, dayBounds } from "../src/long-vp/day.ts";
import type { Objects } from "../src/store/objects.ts";
import type { MarketSymbol } from "../../lib/market/instruments.ts";
import type { Trade } from "../src/types.ts";

const arg = (k: string) => process.argv.find(s => s.startsWith(`--${k}=`))?.slice(k.length + 3);
const port = Number(arg("port") ?? 18782);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "settings-longvp-dummy-"));
const front = path.resolve(arg("front") ?? "artifacts/heatmap/dist/public");
const events: { event: string; detail?: unknown }[] = [];
const log = (event: string, detail?: unknown) => { events.push({ event, detail }); };
const cloud = new Map<string, Buffer>();
let delayMs = 0, fail = false, todayFail = false, auth = "", malformed = false;
const calls: Record<string, number> = {};
const wait = async (kind: string) => {
  calls[kind] = (calls[kind] ?? 0) + 1;
  if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  if (fail) throw Error("dummy_network_failure");
};
const objects: Objects = {
  exists: async n => { await wait("exists"); return cloud.has(n); },
  list: async prefix => { await wait("list"); return [...cloud.keys()].filter(n => n.startsWith(prefix)); },
  download: async (n, file) => { await wait("download"); await fs.writeFile(file, cloud.get(n)!); },
  upload: async (n, file) => { await wait("upload"); cloud.set(n, await fs.readFile(file)); },
};
const settings = new AppSettings(path.join(root, "settings.json"), objects, "dummy/", log);
const lvSettings = new LongVpSettings(path.join(root, "settings-longvp.json"), log, { objects, prefix: "dummy/" });
const trace = new SettingsTrace(log, () => ({ backfill: "complete", vpHistory: "complete",
  requests: 0, errors: 0, retries: 0, waiting: false }));
trace.start();
const start = performance.now(), initialCpu = process.cpuUsage(), loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let now = Date.now() * 1000, seq = 1;
const date = dayAt(now)!;
const services = new Map<MarketSymbol, AppLongVp>();
const tape: Record<MarketSymbol, Trade[]> = { NQ: [], GC: [] };
for (const symbol of ["NQ", "GC"] as const) {
  const contract = `${symbol}Z26`, sinceUs = dayBounds(date).startUs;
  const service = new AppLongVp({
    repository: { symbol, records: new Map(), snapshot: () => ({}) },
    metadata: { currentContract: contract },
    nextSeq: () => 1, log, now: () => now,
  } as unknown as LongDependencies);
  // Initialize only the in-memory test seam; actual trade()/today()/routes run.
  Object.assign(service, { timeline: [{ contract, sinceUs }], todayDate: date,
    todayReady: true, restoreCutoffSeq: 1 });
  services.set(symbol, service);
}
function add(symbol: MarketSymbol, size: number, priceOffset = 0) {
  const t: Trade = { tsUs: now, recvUs: now, seq: seq++,
    price: (symbol === "NQ" ? 84000 : 27000) + priceOffset, size, side: "buy", contract: `${symbol}Z26` };
  tape[symbol].push(t); services.get(symbol)!.trade(t);
}
add("NQ", 10); add("GC", 30);
const app = express();
const requests: object[] = [];
app.use((req, res, next) => {
  const at = performance.now();
  res.on("finish", () => requests.push({ path: req.path, method: req.method, symbol: req.query.symbol ?? "NQ",
    atUs: Date.now() * 1000, ms: performance.now() - at, status: res.statusCode }));
  next();
});
app.get("/__dummy/control", (req, res) => {
  if (req.query.delay !== undefined) delayMs = Number(req.query.delay);
  if (req.query.fail !== undefined) fail = req.query.fail === "1";
  if (req.query.todayFail !== undefined) todayFail = req.query.todayFail === "1";
  if (req.query.auth !== undefined) auth = String(req.query.auth);
  if (req.query.malformed !== undefined) malformed = req.query.malformed === "1";
  if (req.query.resetLoop === "1") loop.reset();
  if (req.query.advance !== undefined) now += Number(req.query.advance) * 1e6;
  if (req.query.size !== undefined) add(req.query.symbol === "GC" ? "GC" : "NQ", Number(req.query.size), Number(req.query.offset ?? 0));
  res.json({ dummy: true });
});
app.get("/__dummy/status", (_req, res) => {
  const cpu = process.cpuUsage(initialCpu), elapsedMs = performance.now() - start;
  res.json({ dummy: true, pid: process.pid, now, date, calls, events, requests, tape,
    cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs, rss: process.memoryUsage().rss,
    loop: { maxMs: loop.max / 1e6, p99Ms: loop.percentile(99) / 1e6 },
    totals: Object.fromEntries([...services].map(([s, v]) => [s, v.today()])), cloudWrites: calls.upload ?? 0 });
});
app.get("/__dummy/away", (_req, res) => res.type("html").send("<h1>ダミー隔離・別画面</h1>"));
app.use("/api/settings", (req, res, next) => {
  if (auth === "redirect") { res.redirect("/__dummy/login"); return; }
  if (auth === "403") { res.status(403).json({ error: "forbidden" }); return; }
  if (malformed) { res.json({ version: 99, values: {}, updatedAt: null }); return; }
  next();
});
app.get("/__dummy/login", (_req, res) => res.type("html").send("<h1>ダミー認証画面</h1>"));
app.use("/api/settings/longvp", longVpSettingsRouter(lvSettings, trace));
app.use("/api/settings", settingsRouter(settings, trace));
app.use("/api/longvp", (req, res, next) => {
  if (todayFail && req.path === "/today") { res.status(500).json({ error: "dummy_temporary_failure" }); return; }
  next();
}, longVpRouter(null, s => services.get(s)!));
app.get("/", async (_req, res) => res.type("html").send((await fs.readFile(path.join(front, "index.html"), "utf8"))
  .replace("<body>", '<body><strong style="position:fixed;right:5px;bottom:5px;z-index:99999;color:#ff0">ダミー隔離</strong>')));
app.use(express.static(front));
const server = app.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ dummy: true, port, pid: process.pid, root })));
process.on("SIGTERM", () => {
  trace.stop(); loop.disable();
  server.close(() => { console.log(JSON.stringify({ dummy: true, stopped: true })); });
  server.closeAllConnections();
});
