import express from "express";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { marketSymbol, type MarketSymbol } from "../../../lib/market/instruments.ts";
import type { LocalStore } from "../store/local.ts";
import type { HistoryProcess } from "../history/process.ts";
import { LabelError, type LabelsStore } from "./store.ts";

export interface LabelsService { labels: LabelsStore; history: HistoryProcess; store(symbol: MarketSymbol): LocalStore; }
export function labelsRouter(service: LabelsService) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/export", async (req, res) => {
    const symbol = marketSymbol(req.query.symbol);
    const valid = (v: unknown) => typeof v === "string" && /^\d+$/.test(v) && Number.isSafeInteger(+v);
    const from = Number(req.query.fromSec), to = Number(req.query.toSec);
    if (!symbol || !valid(req.query.fromSec) || !valid(req.query.toSec) || from < 0 || to <= from || to > 0xffffffff) {
      res.status(400).json({ error: "invalid_export_range" }); return;
    }
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    let directory: string | undefined;
    try {
      const doc = await service.labels.get(symbol), store = service.store(symbol);
      directory = await fs.mkdtemp(path.join(tmpdir(), "turning-export-"));
      const result = await service.history.labelsExport({ symbol, fromSec: from, toSec: to, labels: doc.labels,
        tickRanges: await store.recordedTickCoverage(), directory },
      (hour, dir) => store.labelHourInput(hour, dir), abort.signal);
      if (abort.signal.aborted) return;
      res.type("application/zip");
      await new Promise<void>((resolve, reject) => res.download(result.zip, `turning-points-${symbol}-${from}-${to}.zip`,
        error => error ? reject(error) : resolve()));
    } catch (e) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const busy = e instanceof Error && e.message === "labels_export_busy";
      res.status(busy ? 409 : 503).json({ error: busy ? "labels_export_busy" : "labels_export_failed" });
    } finally { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
  });
  router.get("/", async (req, res) => {
    const symbol = marketSymbol(req.query.symbol);
    if (!symbol) { res.status(400).json({ error: "invalid_symbol" }); return; }
    try {
      const doc = await service.labels.get(symbol);
      res.set("ETag", `"${doc.generation}"`).json(doc);
    } catch { res.status(503).json({ error: "labels_read_failed" }); }
  });
  router.use(express.json({ limit: "16kb" }));
  for (const method of ["post", "put", "delete"] as const) router[method]("/", async (req, res) => {
    // Keep Invite-only at the deployment edge. Never add an unprotected alias.
    if (req.get("Sec-Fetch-Site") === "cross-site") { res.status(403).json({ error: "cross_site_write" }); return; }
    const { label, symbol: raw, generation, id, updatedUs } = req.body ?? {};
    const symbol = marketSymbol(method === "delete" ? raw : label?.symbol);
    if (!symbol || method === "delete" && (typeof id !== "string" || !Number.isSafeInteger(updatedUs))) {
      res.status(400).json({ error: "invalid_label" }); return;
    }
    try {
      const doc = await service.labels.mutate(symbol, generation, method.toUpperCase() as "POST" | "PUT" | "DELETE",
        label, id, method === "delete" ? updatedUs : label?.updatedUs);
      res.set("ETag", `"${doc.generation}"`).json(doc);
    } catch (e) {
      const error = e instanceof LabelError ? e : new LabelError(503, "labels_io_failed_result_unknown");
      res.status(error.status).json({ error: error.message });
    }
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: "invalid_labels_json" });
  });
  return router;
}
