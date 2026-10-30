import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import WebSocket from "ws";
import { Hub, attachHub } from "../src/hub/hub.ts";
import { VolumeProfile } from "../src/vp/state.ts";
import type { Trade } from "../src/types.ts";
import { once } from "node:events";

test("initial history pending中にも250ms live/daily配信・旧peerにはdailyなし・NQ/GC分離", async () => {
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const symbols = ["NQ", "GC"] as const;
  const profiles = new Map(symbols.map(s => [s, new VolumeProfile(Date.now() / 1000)]));
  const hubs = new Map(symbols.map(s => [s, new Hub({
    savedRange: () => null,
    read: async () => { await held; return { columns: [], trades: [] }; },
    status: () => ({}), vp: () => profiles.get(s)!,
  }, () => {}, undefined, s as "NQ" | "GC")]));
  const server = createServer();
  attachHub(server, hubs);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const a = new WebSocket(`ws://127.0.0.1:${port}/api/ws?daily=1`);
  const b = new WebSocket(`ws://127.0.0.1:${port}/api/ws?symbol=GC`);
  const messages: Record<string, unknown>[] = [], gc: Record<string, unknown>[] = [];
  a.on("message", (d, binary) => { if (!binary) messages.push(JSON.parse(d.toString())); });
  b.on("message", (d, binary) => { if (!binary) gc.push(JSON.parse(d.toString())); });
  try {
    await Promise.all([once(a, "open"), once(b, "open")]);
    const now = Date.now() * 1000;
    const trade: Trade = { tsUs: Math.floor(now / 1e6) * 1e6, recvUs: now, seq: 1, price: 84000, size: 3, side: "buy" };
    profiles.get("NQ")!.add(trade); hubs.get("NQ")!.trade(trade);
    await new Promise(r => setTimeout(r, 350));
    assert(messages.some(m => m.type === "trades")); assert(messages.some(m => m.type === "sessionIndicators"));
    assert(!messages.some(m => m.type === "rangeDone"));
    assert(!gc.some(m => m.type === "trades" || m.type === "sessionIndicators"));
    release();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    release(); a.close(); b.close();
    await Promise.all([once(a, "close"), once(b, "close")]);
    for (const hub of hubs.values()) hub.stop();
    await new Promise<void>(r => server.close(() => r()));
  }
});
