/** Isolated dummy downstream, no upstream, cloud client or persistence.
 * node server/test/footprint-fixture.ts --port=18777 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { Hub, attachHub, type Source } from "../src/hub/hub.ts";
import { Pipeline } from "../src/pipeline.ts";
import { defaults } from "../src/settings/schema.ts";
import { INSTRUMENTS, type MarketSymbol } from "../../lib/market/instruments.ts";
import type { Trade } from "../src/types.ts";
import { dayStartSec, dayEndSec, latestTradingDate } from "../../artifacts/heatmap/src/long-vp/time.ts";
import { defaults as longDefaults } from "../../artifacts/heatmap/src/long-vp/settings-schema.ts";

const port = Number(process.argv.find(a => a.startsWith("--port="))?.slice(7) ?? 18777);
const arg = (key: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const manual = process.argv.includes("--manual");
const baselineRoot = arg("baseline");
const legacyHub = arg("legacy-hub");
const measurement = process.argv.includes("--measurement");
const currentFront = arg("current-front");
const pipelineReader = process.argv.includes("--pipeline-reader");
const pipelineProof = { reads: 0, closes: 0 };
const HubRuntime: typeof Hub = legacyHub ? (await import(pathToFileURL(legacyHub).href)).Hub : Hub;
const root = fileURLToPath(new URL("../..", import.meta.url));
const started = measurement ? Math.floor(Date.now() / 60000) * 60 : Math.floor(Date.now() / 1000);
let late = false, forceGap = !manual, completion = 1, generation = 0, delayMs = 0;
const receipts: unknown[] = [];
const sockets: import("node:net").Socket[] = [];
const tcp = () => ({ tx: sockets.reduce((n, s) => n + s.bytesWritten, 0), rx: sockets.reduce((n, s) => n + s.bytesRead, 0) });
const depth = (symbol: MarketSymbol) => ({
  bids: Array.from({ length: 400 }, (_, i) => ({ price: base(symbol) - 1 - i, size: 10 + i % 9 })),
  asks: Array.from({ length: 400 }, (_, i) => ({ price: base(symbol) + 1 + i, size: 12 + i % 7 })),
});
const wire = { fpRanges: 0, bookRanges: 0, liveTrades: 0 };
const tails = new Map<MarketSymbol, Trade[]>([["NQ", []], ["GC", []]]);
const base = (symbol: MarketSymbol) => symbol === "NQ" ? 84000 : 27000;
function rows(symbol: MarketSymbol, from: number, to: number): Trade[] {
  const out: Trade[] = [];
  for (let s = Math.max(from, started - (measurement ? 120 : 7200)); s < Math.min(to, started); s++) {
    if (forceGap && s >= started - 25 && s < started - 20) continue;
    const i = s - (started - 7200);
    out.push({ tsUs: s * 1e6, recvUs: s * 1e6 + 20, seq: i * 2 + 1,
      price: base(symbol) + i % 7 - 3, size: 1 + i % 5, side: i % 2 ? "buy" : "sell",
      ...(symbol === "GC" && s % 19 === 0 ? {} : { contract: `${symbol}Z26` }) });
  }
  if (late && from <= started - 30 && to > started - 30) out.push({
    tsUs: (started - 30) * 1e6, recvUs: started * 1e6 + 500, seq: 20000,
    price: base(symbol), size: 17, side: "buy", contract: `${symbol}Z26`,
  });
  out.push(...tails.get(symbol)!.filter(t => t.tsUs >= from * 1e6 && t.tsUs < to * 1e6));
  return out;
}
function source(symbol: MarketSymbol): Source {
  return {
    savedRange: () => ({ fromSec: started - 7200, toSec: Math.floor(Date.now() / 1000) }),
    read: async (a, b) => {
      wire.bookRanges++;
      const trades = rows(symbol, a, b);
      const lo = measurement ? Math.max(a, started - 120) : a;
      const hi = measurement ? Math.min(b, started) : b;
      return { trades, columns: Array.from({ length: Math.max(0, Math.min(300, hi - lo)) }, (_, i) => ({
        tsSec: lo + i, source: "history" as const,
        ...depth(symbol),
      })) };
    },
    readTrades: async (a, b, visit, signal) => {
      wire.fpRanges++;
      const snapshot = rows(symbol, a, b), wait = delayMs;
      receipts.push({ symbol, from: a, to: b, wait, count: snapshot.length });
      if (pipelineReader) {
        pipelineProof.reads++;
        // Real modified methods; durable I/O only is replaced. No constructor
        // may start a production receiver or upstream work in this fixture.
        const state = {
          tradeBatch: tails.get(symbol)!, seam: started - 7200,
          ownsFootprintLive: Pipeline.prototype.ownsFootprintLive,
          backfill: { status: { gaps: forceGap ? [{ kind: "tick", startSec: started - 25, endSec: started - 20, reason: "fixture_gap" }] : [], noData: [] } },
          store: {
            recordedTickCoverage: async () => [[a, b]],
            tradeReadSession: () => ({
              visit: async (_a: number, _b: number, visitor: (t: Trade) => void) => {
                if (wait) await new Promise(resolve => setTimeout(resolve, wait));
                for (const trade of snapshot) { signal.throwIfAborted(); visitor(trade); }
              },
              close: async () => { pipelineProof.closes++; },
            }),
          },
        };
        return Pipeline.prototype.readFootprintRange.call(state as unknown as Pipeline, a, b, visit, signal);
      }
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      for (const t of snapshot) { signal.throwIfAborted(); visit(t); }
      const gaps = forceGap && a < started - 20 && b > started - 25
        ? [{ startSec: Math.max(a, started - 25), endSec: Math.min(b, started - 20), reason: "dummy_missing" }] : [];
      return { coverage: [[a, b]], gaps, noData: [], quality: "recorded_not_guaranteed" };
    },
    status: () => ({ dummy: true, phase2a: { backfill: { state: "complete", startedAtUs: started * 1e6,
      finishedAtUs: started * 1e6 + completion, startSec: started - 7200, endSec: started + 60 } } }),
  };
}
const log = (event: string, detail?: unknown) => console.info(JSON.stringify({ dummy: true, event, detail }));
let hubs: Map<MarketSymbol, Hub>;
function makeHubs() {
  generation++;
  return new Map<MarketSymbol, Hub>(["NQ", "GC"].map(s => [s as MarketSymbol,
    new HubRuntime(source(s as MarketSymbol), log, measurement ? {
      now: () => started * 1000,
      later: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id as NodeJS.Timeout),
    } : undefined, s as MarketSymbol)]));
}
hubs = makeHubs();
const app = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://dummy");
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (u.pathname === "/__fixture/status") return json({ dummy: true, started, late, forceGap, generation, ...wire,
    pid: process.pid, rss: process.memoryUsage().rss, cpu: process.cpuUsage(),
    connections: [...hubs.values()].map(h => h.snapshot()), receipts, manual, legacy: !!legacyHub, tcp: tcp(), pipelineReader, pipelineProof });
  if (u.pathname === "/__fixture/delay") { delayMs = Number(u.searchParams.get("ms") ?? 0); return json({ dummy: true, delayMs }); }
  if (u.pathname === "/__fixture/reset") {
    late = false; forceGap = false; delayMs = 0; completion++; receipts.length = 0;
    if (measurement) { wire.liveTrades = 0; wire.fpRanges = 0; wire.bookRanges = 0; seq = 30000; }
    for (const list of tails.values()) list.length = 0;
    for (const h of hubs.values()) h.stop();
    const fresh = makeHubs(); hubs.clear(); for (const [s, h] of fresh) hubs.set(s, h);
    return json({ dummy: true, started, generation });
  }
  if (u.pathname === "/__fixture/step") { step(); return json({ dummy: true, ...wire }); }
  if (u.pathname === "/__fixture/late") { late = true; forceGap = false; completion++; return json({ dummy: true, late }); }
  if (u.pathname === "/__fixture/data") return json({ dummy: true,
    rows: rows(u.searchParams.get("symbol") === "GC" ? "GC" : "NQ",
      Number(u.searchParams.get("from") ?? started - 120), Number(u.searchParams.get("to") ?? started)) });
  if (u.pathname === "/__fixture/reconnect") {
    for (const h of hubs.values()) h.stop();
    const fresh = makeHubs(); hubs.clear(); for (const [s, h] of fresh) hubs.set(s, h);
    return json({ dummy: true, generation });
  }
  if (u.pathname === "/api/settings") return json({ version: 4, updatedAt: null, values: defaults });
  if (u.pathname === "/api/settings/longvp") return json({ version: 1, updatedAt: null,
    values: longDefaults });
  if (u.pathname.startsWith("/api/longvp/")) {
    const symbol: MarketSymbol = u.searchParams.get("symbol") === "GC" ? "GC" : "NQ";
    res.setHeader("X-LongVP-Front-Contract", `${symbol}Z26`);
    if (u.pathname.endsWith("/rolls")) return json([]);
    const date = latestTradingDate(Date.now() / 1000), startSec = dayStartSec(date);
    const day = { version: 1, tradingDate: date, startSec, endSec: dayEndSec(date),
      contracts: [{ contract: `${symbol}Z26`, fromSec: startSec, toSec: dayEndSec(date) }],
      bars1m: [[startSec, base(symbol), base(symbol) + 3, base(symbol) - 3, base(symbol) + 1, 25, 20, 0]],
      vp30m: [[startSec, base(symbol), 25, 20, 0]], gaps: [], complete: false, builtAtUs: Date.now() * 1000 };
    return json(u.pathname.endsWith("/today") ? day : [day]);
  }
  try {
    const publicRoot = currentFront ? path.resolve(currentFront, "artifacts/heatmap/dist/public") : path.resolve(root, "artifacts/heatmap/dist/public");
    const file = path.resolve(publicRoot, u.pathname.slice(1) || "index.html");
    if (!file.startsWith(publicRoot + "/")) return json({ error: "not_found" }, 404);
    let body: Buffer;
    try {
      body = u.pathname === "/" && u.searchParams.get("fixtureFront") === "before" && baselineRoot
        ? await readFile(path.join(baselineRoot, "artifacts/heatmap/dist/public/index.html")) : await readFile(file);
    } catch (error) {
      if (!baselineRoot) throw error;
      body = await readFile(path.join(baselineRoot, "artifacts/heatmap/dist/public", u.pathname.slice(1)));
    }
    if (file.endsWith(".html")) body = Buffer.from(body.toString().replace("<body>",
      '<body><div style="position:fixed;top:0;left:0;z-index:99999;background:#7b3100;color:white;font:10px monospace;padding:2px 5px;pointer-events:none">ダミー隔離入力 / NO UPSTREAM</div>'));
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
      "Cache-Control": "no-store" }); res.end(body);
  } catch { json({ error: "not_found" }, 404); }
});
const ws = attachHub(app, hubs);
app.prependListener("upgrade", req => { sockets.push(req.socket); });
let seq = 30000;
function step() {
  const s = Math.floor(Date.now() / 1000);
  for (const [symbol, hub] of hubs) {
    const trade: Trade = { tsUs: (manual ? started - 30 : s) * 1e6, recvUs: Date.now() * 1000, seq: seq++, price: base(symbol),
      size: 2, side: "buy", contract: `${symbol}Z26` };
    tails.get(symbol)!.push(trade);
    hub.trade(trade);
    const book = { ...depth(symbol), tsUs: s * 1e6, recvUs: Date.now() * 1000, source: "live" as const };
    const updated = depth(symbol); updated.bids[0]!.size += wire.liveTrades % 7;
    hub.book(book); hub.column({ ...updated, tsSec: measurement ? started - 30 : s, source: "live" });
    wire.liveTrades++;
  }
}
const timer = manual ? null : setInterval(step, 1000);
app.listen(port, "127.0.0.1", () => log("footprint_fixture_listening", { port, pid: process.pid, tickSizes: INSTRUMENTS }));
process.on("SIGTERM", () => {
  if (timer) clearInterval(timer); for (const h of hubs.values()) h.stop();
  for (const client of ws.clients) client.terminate();
  ws.close(); app.close(() => log("footprint_fixture_stopped", { connected: ws.clients.size }));
});
