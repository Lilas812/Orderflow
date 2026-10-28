import { Router } from "express";
import type { AppLongVp } from "./app-service.ts";
import { datesBetween } from "./day.ts";

export function longVpRouter(service: AppLongVp | null) {
  const router = Router();
  // Serialize range responses to bound simultaneous decoded-day and output-buffer memory.
  let busy = false;
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!service) { res.status(503).json({ error: "longvp_disabled" }); return; }
    next();
  });
  router.get("/today", (_req, res) => {
    const today = service!.today();
    if (!today) { res.status(503).json({ error: "longvp_today_not_ready" }); return; }
    res.json(today);
  });
  router.get("/rolls", (_req, res) => { res.json(service!.rolls()); });
  router.get("/days", async (req, res) => {
    let dates: string[];
    try {
      dates = datesBetween(typeof req.query.from === "string" ? req.query.from : "",
        typeof req.query.to === "string" ? req.query.to : "");
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "invalid_date_range" }); return;
    }
    if (busy) { res.set("Retry-After", "1"); res.status(429).json({ error: "longvp_range_busy" }); return; }
    busy = true;
    try {
      const available = dates.filter(d => service!.repository.records.has(d));
      let first = true;
      res.type("json"); res.write("[");
      for (const date of available) {
        if (res.destroyed) return;
        const day = await service!.repository.day(date);
        if (res.destroyed) return;
        if (!res.write((first ? "" : ",") + JSON.stringify(day))) {
          await new Promise<void>(resolve => {
            const finish = () => { res.off("drain", finish); res.off("close", finish); resolve(); };
            res.once("drain", finish); res.once("close", finish);
            if (res.destroyed) finish();
          });
        }
        first = false;
      }
      if (!res.destroyed) res.end("]");
    } catch {
      // Never finish a truncated array as an apparently successful empty response.
      res.destroy();
    } finally { busy = false; }
  });
  return router;
}
