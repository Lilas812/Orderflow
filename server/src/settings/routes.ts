import express from "express";
import type { ErrorRequestHandler } from "express";
import type { SettingsPersistence } from "./local.ts";
import { validateBody } from "./schema.ts";
import { settingsOperation } from "./trace.ts";
import type { SettingsTrace } from "./trace.ts";

export function settingsRouter(store: SettingsPersistence, trace?: SettingsTrace) {
  const router = express.Router();
  if (trace) router.use(trace.middleware);
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", async (_req, res) => { res.json(await settingsOperation(() => store.get(), () => !!store.snapshot().readError)); });
  router.put("/", express.json({ limit: "8kb" }), async (req, res) => {
    const fields = validateBody(req.body);
    if (Object.keys(fields).length) { res.status(400).json({ error: "invalid_settings", fields }); return; }
    try { res.json(await settingsOperation(() => store.put(req.body.values), () => false)); }
    catch { res.status(500).json({ error: "settings_save_failed" }); }
  });
  router.use(((error, _req, res, _next) => {
    // Do not send Express's raw parse error/body back to the client.
    res.status(400).json({ error: "invalid_settings", fields: { _body:
      (error as { type?: string }).type === "entity.too.large" ? "本文が大きすぎます" : "正しいJSONを送ってください" } });
  }) as ErrorRequestHandler);
  return router;
}
