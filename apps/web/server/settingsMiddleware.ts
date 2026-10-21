import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { MAX_SETTINGS_BYTES } from "../../../packages/core/src/settingsSchema";
import { SettingsFileStore, SettingsStoreError, settingsDirectory } from "./settingsFileStore";

export const SETTINGS_ENDPOINT = "/__orderflow/settings";
export function createSettingsMiddleware(store: SettingsFileStore, base = "/") {
  const endpoint = `${base.replace(/\/$/, "")}${SETTINGS_ENDPOINT}`;
  // Process-scoped token, never in JSON settings/disk/logs. A reload gets a new token after restart.
  const token = randomBytes(32).toString("hex");
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://internal.invalid");
    if (url.pathname !== endpoint) { next(); return; }
    const respond = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(JSON.stringify(data));
    };
    if (url.search) { respond(400, { error: "QUERY_NOT_ALLOWED" }); return; }
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") { respond(403, { error: "CROSS_ORIGIN_DENIED" }); return; }
    const origin = req.headers.origin;
    // Host is the same host used by the browser request, or the single trusted
    // proxy forwarded host. Browser JS cannot forge Origin/Host/Fetch-Metadata.
    const forwarded = req.headers["x-forwarded-host"];
    const hosts = [req.headers.host, typeof forwarded === "string" && !forwarded.includes(",") ? forwarded : undefined].filter(Boolean);
    const forwardedProto = req.headers["x-forwarded-proto"];
    const protocol = typeof forwardedProto === "string" ? forwardedProto.split(",")[0].trim().toLowerCase()
      : (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
    if (origin) {
      let o: URL;
      try { o = new URL(origin); } catch { respond(403, { error: "INVALID_ORIGIN" }); return; }
      if (!["http", "https"].includes(protocol) || o.origin !== origin
        || o.protocol !== `${protocol}:` || !hosts.includes(o.host)) { respond(403, { error: "CROSS_ORIGIN_DENIED" }); return; }
    }
    if (req.method === "GET") {
      try { respond(200, { ...await store.load(), csrfToken: token }); }
      catch (e) { const err = e instanceof SettingsStoreError ? e : new SettingsStoreError(500, "SETTINGS_READ_FAILED"); respond(err.status, { error: err.code }); }
      return;
    }
    if (req.method !== "PUT") { res.setHeader("Allow", "GET, PUT"); respond(405, { error: "METHOD_NOT_ALLOWED" }); return; }
    if (!origin) { respond(403, { error: "ORIGIN_REQUIRED" }); return; }
    const supplied = req.headers["x-settings-csrf"];
    if (typeof supplied !== "string" || !/^[0-9a-f]{64}$/.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { respond(403, { error: "CSRF_DENIED" }); return; }
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") { respond(415, { error: "JSON_REQUIRED" }); return; }
    if (Number(req.headers["content-length"]) > MAX_SETTINGS_BYTES) { req.resume(); respond(413, { error: "SETTINGS_TOO_LARGE" }); return; }
    try {
      const buffers: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += b.length;
        if (size > MAX_SETTINGS_BYTES) { respond(413, { error: "SETTINGS_TOO_LARGE" }); req.resume(); return; }
        buffers.push(b);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(buffers).toString("utf8")); } catch { respond(400, { error: "INVALID_JSON" }); return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { respond(400, { error: "INVALID_REQUEST" }); return; }
      const b = body as Record<string, unknown>;
      if (Object.keys(b).length !== 2 || !Object.hasOwn(b, "settings") || !Object.hasOwn(b, "expectedRevision")) {
        respond(400, { error: "INVALID_REQUEST_KEYS" }); return;
      }
      respond(200, await store.save(b.settings as never, b.expectedRevision as number));
    } catch (e) {
      const err = e instanceof SettingsStoreError ? e : new SettingsStoreError(500, "SETTINGS_WRITE_FAILED");
      respond(err.status, { error: err.code });
    }
  };
}
export function settingsPlugin(workspace: string): Plugin {
  return {
    name: "orderflow-development-settings", apply: "serve",
    configureServer(server) {
      server.middlewares.use(createSettingsMiddleware(new SettingsFileStore(settingsDirectory(workspace)), server.config.base));
    },
  };
}
