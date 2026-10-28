import express from "express";
import type { Receiver } from "../ingest/receiver.ts";
import type { Upstream } from "../upstream/connection.ts";
import { makeSanitizer } from "../logger.ts";
import type { SettingsPersistence } from "../settings/local.ts";
import { settingsRouter } from "../settings/routes.ts";
import path from "node:path";
import type { AppLongVp } from "../long-vp/app-service.ts";
import { longVpRouter } from "../long-vp/routes.ts";
import { longVpSettingsRouter } from "../settings/longvp.ts";
import type { LongVpSettings } from "../settings/longvp.ts";

export function statusSnapshot(upstream: Upstream, receiver: Receiver, apiKey: string, extra?: () => unknown, delivery?: () => unknown) {
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
    ...(delivery ? { phase2b: delivery() } : {}),
  });
}

export function createStatusApp(upstream: Upstream, receiver: Receiver, apiKey: string, extra?: () => unknown, delivery?: () => unknown,
  memory?: () => unknown, isolation?: () => unknown, settings?: SettingsPersistence, staticDirectory?: string,
  longVp?: AppLongVp | null, longVpSettings?: LongVpSettings) {
  const app = express();
  app.disable("x-powered-by");
  // The public proxy already routes /api; /status remains the canonical handler.
  app.get(["/status", "/api/status"], (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ...(statusSnapshot(upstream, receiver, apiKey, extra, delivery) as Record<string, unknown>),
      ...(memory ? { memory: memory() } : {}), ...(isolation ? { measurementIsolation: isolation() } : {}),
      ...(settings ? { settings: settings.snapshot() } : {}),
      ...(longVpSettings ? { longVpSettings: longVpSettings.snapshot() } : {}),
      longVp: longVp?.snapshot() ?? { enabled: false, reason: "production_only" } });
  });
  if (longVpSettings) app.use("/api/settings/longvp", longVpSettingsRouter(longVpSettings));
  if (settings) app.use("/api/settings", settingsRouter(settings));
  app.use("/api/longvp", longVpRouter(longVp ?? null));
  app.get("/api/healthz", (_req, res) => { res.json({ status: "ok" }); });
  if (staticDirectory) {
    app.use(express.static(staticDirectory));
    app.get("/{*path}", (req, res, next) => {
      if (req.path.startsWith("/api/")) { next(); return; }
      res.sendFile(path.join(staticDirectory, "index.html"));
    });
  }
  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  return app;
}
