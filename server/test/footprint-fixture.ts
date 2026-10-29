/** Isolated dummy downstream, no upstream, cloud client or persistence.
 * node server/test/footprint-fixture.ts --port=18777 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hub, attachHub, type Source } from "../src/hub/hub.ts";
import { defaults } from "../src/settings/schema.ts";
import { INSTRUMENTS, type MarketSymbol } from "../../lib/market/instruments.ts";
import type { Trade } from "../src/types.ts";
import { dayStartSec, dayEndSec, latestTradingDate } from "../../artifacts/heatmap/src/long-vp/time.ts";
import { defaults as longDefaults } from "../../artifacts/heatmap/src/long-vp/settings-schema.ts";

const port = Number(process.argv.find(a => a.startsWith("--port="))?.slice(7) ?? 18777);
const root = fileURLToPath(new URL("../..", import.meta.url));
const started = Math.floor(Date.now() / 1000);
let late = false, forceGap = true, completion = 1, generation = 0;
const wire = { fpRanges: 0, bookRanges: 0, liveTrades: 0 };
const tails = new Map<MarketSymbol, Trade[]>([["NQ", []], ["GC", []]]);
const base = (symbol: MarketSymbol) => symbol === "NQ" ? 84000 : 27000;
function rows(symbol: MarketSymbol, from: number, to: number): Trade[] {
  const out: Trade[] = [];
  for (let s = Math.max(from, started - 7200); s < Math.min(to, started); s++) {
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
      return { trades, columns: Array.from({ length: Math.min(300, b - a) }, (_, i) => ({
        tsSec: a + i, source: "history" as const,
        bids: [{ price: base(symbol) - 1, size: 10 }], asks: [{ price: base(symbol) + 1, size: 12 }],
      })) };
    },
    readTrades: async (a, b, visit, signal) => {
      wire.fpRanges++;
      for (const t of rows(symbol, a, b)) { signal.throwIfAborted(); visit(t); }
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
    new Hub(source(s as MarketSymbol), log, undefined, s as MarketSymbol)]));
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
    connections: [...hubs.values()].map(h => h.snapshot()) });
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
    const file = path.resolve(root, "artifacts/heatmap/dist/public", u.pathname.slice(1) || "index.html");
    const publicRoot = path.resolve(root, "artifacts/heatmap/dist/public");
    if (!file.startsWith(publicRoot + "/")) return json({ error: "not_found" }, 404);
    let body = await readFile(file);
    if (file.endsWith(".html")) body = Buffer.from(body.toString().replace("<body>",
      '<body><div style="position:fixed;top:0;left:0;z-index:99999;background:#7b3100;color:white;font:10px monospace;padding:2px 5px;pointer-events:none">ダミー隔離入力 / NO UPSTREAM</div>'));
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
      "Cache-Control": "no-store" }); res.end(body);
  } catch { json({ error: "not_found" }, 404); }
});
const ws = attachHub(app, hubs);
let seq = 30000;
const timer = setInterval(() => {
  const s = Math.floor(Date.now() / 1000);
  for (const [symbol, hub] of hubs) {
    const trade: Trade = { tsUs: s * 1e6, recvUs: Date.now() * 1000, seq: seq++, price: base(symbol),
      size: 2, side: "buy", contract: `${symbol}Z26` };
    tails.get(symbol)!.push(trade);
    hub.trade(trade);
    wire.liveTrades++;
  }
}, 1000);
app.listen(port, "127.0.0.1", () => log("footprint_fixture_listening", { port, pid: process.pid, tickSizes: INSTRUMENTS }));
process.on("SIGTERM", () => {
  clearInterval(timer); for (const h of hubs.values()) h.stop();
  for (const client of ws.clients) client.terminate();
  ws.close(); app.close(() => log("footprint_fixture_stopped", { connected: ws.clients.size }));
});
