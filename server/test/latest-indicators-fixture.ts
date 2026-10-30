/** ダミー隔離: real Receiver -> VolumeProfile -> Hub -> browser, no upstream/storage. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { Hub, attachHub, type Source } from "../src/hub/hub.ts";
import { Receiver } from "../src/ingest/receiver.ts";
import { VolumeProfile, sessionStartSec } from "../src/vp/state.ts";
import { defaults } from "../src/settings/schema.ts";
import { INSTRUMENTS, type MarketSymbol } from "../../lib/market/instruments.ts";
import type { Trade } from "../src/types.ts";

const arg = (key: string) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const port = Number(arg("port") ?? 18786), before = arg("before");
const HubClass: typeof Hub = before
  ? (await import(pathToFileURL(path.join(before, "server/src/hub/hub.ts")).href)).Hub : Hub;
const legacyProfile = arg("legacy-profile");
const ProfileClass: typeof VolumeProfile = legacyProfile
  ? (await import(pathToFileURL(path.join(legacyProfile, "server/src/vp/state.ts")).href)).VolumeProfile : VolumeProfile;
const front = arg("front") ?? (before ? path.join(before, "artifacts/heatmap/dist/public") : path.resolve("artifacts/heatmap/dist/public"));
const now = Math.floor(Date.now() / 1000), start = sessionStartSec(now);
let delayMs = 0;
const log = (event: string, detail?: unknown) => { if (event === "hub_closed") console.log(JSON.stringify({ dummy: true, event, detail })); };
const rows = new Map<MarketSymbol, Trade[]>(), profiles = new Map<MarketSymbol, VolumeProfile>();
const receivers = new Map<MarketSymbol, Receiver>(), hubs = new Map<MarketSymbol, Hub>();
let normalizeStarted = 0;
const wsSockets = new Set<Socket>();
let closedWsSent = 0;
const stages: { symbol: string; seq: number; recvUs: number; normalizedAtUs: number; normalizationMs: number }[] = [];
for (const symbol of ["NQ", "GC"] as const) {
  const base = symbol === "NQ" ? 84000 : 27000, profile = new ProfileClass(now);
  const data: Trade[] = [
    { tsUs: (start + 60) * 1e6, recvUs: (start + 60) * 1e6, seq: 100000, price: base, size: 40, side: "buy", contract: `${symbol}Z26` },
    { tsUs: (now - 60) * 1e6, recvUs: (now - 60) * 1e6, seq: 100001, price: base + 4, size: 10, side: "sell", contract: `${symbol}Z26` },
  ];
  data.forEach(t => profile.add(t)); profile.complete(start);
  rows.set(symbol, data); profiles.set(symbol, profile);
  const source: Source = {
    savedRange: () => ({ fromSec: start, toSec: Math.floor(Date.now() / 1000) + 1 }),
    read: async (from, to) => {
      const snapshot = data.filter(t => t.tsUs >= from * 1e6 && t.tsUs < to * 1e6);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      return { columns: from <= now - 2 && to > now - 2 ? [{
        tsSec: now - 2, source: "history", gap: false,
        bids: [{ price: base - 1, size: 40 }], asks: [{ price: base + 1, size: 40 }],
      }] : [], trades: snapshot };
    },
    status: () => ({ dummy: true }),
    vp: () => profile,
    replayVp: async from => {
      const replay = new VolumeProfile(from);
      for (const t of data) if (t.tsUs < from * 1e6) replay.add(t);
      replay.complete(replay.start); return replay;
    },
  };
  const hub = new HubClass(source, log, undefined, symbol); hubs.set(symbol, hub);
  receivers.set(symbol, new Receiver(log, { trade: t => {
    stages.push({ symbol, seq: t.seq, recvUs: t.recvUs, normalizedAtUs: Date.now() * 1000,
      normalizationMs: performance.now() - normalizeStarted });
    data.push(t); profile.advance(t.tsUs / 1e6); profile.add(t); hub.trade(t);
  } }, symbol));
}
const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://dummy");
  const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  if (u.pathname === "/__dummy/delay") { delayMs = Number(u.searchParams.get("ms") ?? 0); return json({ dummy: true, delayMs }); }
  if (u.pathname === "/__dummy/tick") {
    const symbol = u.searchParams.get("symbol") === "GC" ? "GC" : "NQ";
    const price = Number(u.searchParams.get("price") ?? (symbol === "NQ" ? 21000 : 2700));
    const recvUs = Date.now() * 1000;
    normalizeStarted = performance.now();
    receivers.get(symbol)!.receive(JSON.stringify({ type: "tick", symbol,
      ts: Number(u.searchParams.get("ts") ?? Math.floor(Date.now() / 1000)),
      price, size: Number(u.searchParams.get("size") ?? 1), side: u.searchParams.get("side") ?? "buy",
      ...(u.searchParams.has("unknown") ? {} : { contract: `${symbol}Z26` }) }), recvUs, () => {});
    return json({ dummy: true, recvUs, stage: stages.at(-1), total: profiles.get(symbol)!.summary() });
  }
  if (u.pathname === "/__dummy/late") {
    const symbol = u.searchParams.get("symbol") === "GC" ? "GC" : "NQ";
    const t: Trade = { tsUs: (start + 120) * 1e6, recvUs: Date.now() * 1000, seq: 100002,
      price: symbol === "NQ" ? 84000 : 27000, size: 7, side: "sell" };
    rows.get(symbol)!.push(t); profiles.get(symbol)!.add(t); return json({ dummy: true });
  }
  if (u.pathname === "/__dummy/status") return json({ dummy: true, pid: process.pid, now, start, stages,
    cpu: process.cpuUsage(), rss: process.memoryUsage().rss,
    wsWireSent: closedWsSent + [...wsSockets].reduce((sum, socket) => sum + socket.bytesWritten, 0),
    hubs: [...hubs.values()].map(h => h.snapshot()), profiles: [...profiles].map(([s, p]) => [s, p.summary()]) });
  if (u.pathname === "/__dummy/away") { res.end("<title>ダミー隔離</title>ダミー隔離"); return; }
  if (u.pathname === "/api/settings") return json({ version: 4, updatedAt: null, values: defaults });
  try {
    const file = path.join(front, u.pathname === "/" ? "index.html" : u.pathname);
    if (!file.startsWith(front + "/")) return json({ error: "invalid_path" }, 400);
    let bytes = await readFile(file);
    if (u.pathname === "/") bytes = Buffer.from(bytes.toString().replace("</body>", '<div style="position:fixed;bottom:0;right:0;color:#ffff00;z-index:9999">ダミー隔離</div></body>'));
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", "Cache-Control": "no-store" }); res.end(bytes);
  } catch { json({ error: "dummy_not_found" }, 404); }
});
attachHub(server, hubs);
server.on("upgrade", (_req, duplex) => {
  const socket = duplex as Socket; wsSockets.add(socket);
  socket.once("close", () => { closedWsSent += socket.bytesWritten; wsSockets.delete(socket); });
});
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ dummy: true, port, pid: process.pid, before: !!before })));
process.once("SIGTERM", () => { for (const h of hubs.values()) h.stop(); server.closeAllConnections(); server.close(() => process.exit(0)); });
