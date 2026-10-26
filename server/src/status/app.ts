import express from "express";
import type { Receiver } from "../ingest/receiver.ts";
import type { Upstream } from "../upstream/connection.ts";
import { makeSanitizer } from "../logger.ts";

export function statusSnapshot(upstream: Upstream, receiver: Receiver, apiKey: string, extra?: () => unknown) {
  return makeSanitizer(apiKey)({
    upstream: upstream.status,
    byType: receiver.metrics.byType,
    counts: receiver.metrics.counts,
    examples: receiver.metrics.examples,
    lagIntervals: receiver.metrics.lagIntervals,
    book: receiver.book.summary(),
    tradeCount: receiver.trades.size,
    recentTrades: receiver.trades.latest(5),
    units: { time: "Unix microseconds (integer)", price: "NQ ticks (0.25)" },
    ...(extra ? { phase2a: extra() } : {}),
  });
}

export function createStatusApp(upstream: Upstream, receiver: Receiver, apiKey: string, extra?: () => unknown) {
  const app = express();
  app.disable("x-powered-by");
  // The public proxy already routes /api; /status remains the canonical handler.
  app.get(["/status", "/api/status"], (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(statusSnapshot(upstream, receiver, apiKey, extra));
  });
  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  return app;
}
