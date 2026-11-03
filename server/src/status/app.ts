import express from "express";
import { namedWork } from "../diagnostics/main-thread.ts";
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
import type { SettingsTrace } from "../settings/trace.ts";
import { INSTRUMENTS, marketSymbol, type MarketSymbol } from "../../../lib/market/instruments.ts";
import { labelsRouter, type LabelsService } from "../labels/routes.ts";
export interface MarketStatus {
  receiver: Receiver; extra(): unknown; delivery(): unknown; longVp: AppLongVp | null;
}

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
    units: { time: "Unix microseconds (integer)", price: `${receiver.symbol} ticks (${INSTRUMENTS[receiver.symbol].tickSize})` },
    ...(extra ? { phase2a: extra() } : {}),
    ...(delivery ? { phase2b: delivery() } : {}),
  });
}

export function createStatusApp(upstream: Upstream, receiver: Receiver, apiKey: string, extra?: () => unknown, delivery?: () => unknown,
  memory?: () => unknown, isolation?: () => unknown, settings?: SettingsPersistence, staticDirectory?: string,
  longVp?: AppLongVp | null, longVpSettings?: LongVpSettings, settingsTrace?: SettingsTrace,
  markets?: (symbol: MarketSymbol) => MarketStatus | null, labels?: LabelsService) {
  const app = express();
  app.use((_req, _res, next) => namedWork("http-request", next));
  app.disable("x-powered-by");
  // The public proxy already routes /api; /status remains the canonical handler.
  app.get(["/status", "/api/status"], (req, res) => {
    const symbol = marketSymbol(req.query.symbol ?? "NQ");
    if (!symbol) { res.status(400).json({ error: "invalid_symbol" }); return; }
    const selected = markets?.(symbol);
    if (symbol === "GC" && !selected) { res.status(503).json({ error: "gc_disabled" }); return; }
    res.set("Cache-Control", "no-store");
    res.json({ ...(statusSnapshot(upstream, selected?.receiver ?? receiver, apiKey, selected?.extra ?? extra,
      selected?.delivery ?? delivery) as Record<string, unknown>), symbol,
      upstreamDiagnostics: upstream.receiveDiagnostics(),
      ...(memory ? { memory: memory() } : {}), ...(isolation ? { measurementIsolation: isolation() } : {}),
      ...(settings ? { settings: settings.snapshot() } : {}),
      ...(longVpSettings ? { longVpSettings: longVpSettings.snapshot() } : {}),
      longVp: (selected ? selected.longVp : longVp)?.snapshot() ?? { enabled: false, reason: "production_only" } });
  });
  if (longVpSettings) app.use("/api/settings/longvp", longVpSettingsRouter(longVpSettings, settingsTrace));
  if (settings) app.use("/api/settings", settingsRouter(settings, settingsTrace));
  if (labels) app.use("/api/labels", labelsRouter(labels));
  app.use("/api/longvp", longVpRouter(longVp ?? null, markets
    ? symbol => symbol === "NQ" ? longVp ?? null : markets(symbol)?.longVp ?? null : undefined));
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
