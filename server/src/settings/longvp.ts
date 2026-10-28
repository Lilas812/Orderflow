import * as fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { ErrorRequestHandler } from "express";
import type { Log } from "../logger.ts";
import type { Objects } from "../store/objects.ts";
import { uploadVerified } from "../store/objects.ts";
import { defaults, readDocument, validateSettings } from "../../../artifacts/heatmap/src/long-vp/settings-schema.ts";
import type { SettingsDocument, SettingsValues } from "../../../artifacts/heatmap/src/long-vp/settings-schema.ts";
import type { SettingsDiagnostics } from "./local.ts";

/** Independent namespace: never reads or writes the heatmap settings file. */
export class LongVpSettings {
  private tail: Promise<unknown> = Promise.resolve();
  private lastStamp = 0;
  private diag: SettingsDiagnostics = { source: "defaults", updatedAt: null, readError: null,
    saveError: null, preservedFiles: [] };
  private file: string;
  private log: Log;
  private cloud?: { objects: Objects; prefix: string };
  constructor(file: string, log: Log, cloud?: { objects: Objects; prefix: string }) {
    this.file = file; this.log = log; this.cloud = cloud;
  }
  snapshot(): SettingsDiagnostics { return structuredClone(this.diag); }
  private stamp() { return this.lastStamp = Math.max(Date.now() * 1000, this.lastStamp + 1); }
  private serial<T>(work: () => Promise<T>) {
    const next = this.tail.then(work); this.tail = next.catch(() => {}); return next;
  }
  private async read(): Promise<{ document: SettingsDocument; corrupt: Buffer | null }> {
    const initial: SettingsDocument = { version: 1, values: { ...defaults }, updatedAt: null };
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (this.cloud) {
      const { objects, prefix } = this.cloud;
      const key = prefix + "settings-longvp.json";
      if (await objects.exists(key)) {
        await objects.download(key, this.file + ".cloud");
        await fs.rename(this.file + ".cloud", this.file);
      } else await fs.rm(this.file, { force: true });
      this.diag.preservedFiles = (await objects.list(prefix + "settings-longvp.corrupt-"))
        .filter(n => /^settings-longvp\.corrupt-\d+\.json$/.test(n.slice(prefix.length)));
    } else {
      this.diag.preservedFiles = (await fs.readdir(path.dirname(this.file)))
        .filter(n => /^settings-longvp\.corrupt-\d+\.json$/.test(n))
        .map(n => path.join(path.dirname(this.file), n));
    }
    let bytes: Buffer;
    try { bytes = await fs.readFile(this.file); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.diag.source = "defaults"; this.diag.updatedAt = null; this.diag.readError = null;
      return { document: initial, corrupt: null };
    }
    let document: SettingsDocument | null = null;
    try { document = readDocument(JSON.parse(bytes.toString("utf8"))); } catch { /* Preserve invalid bytes below. */ }
    if (document) {
      this.diag.source = "saved"; this.diag.updatedAt = document.updatedAt; this.diag.readError = null;
      return { document, corrupt: null };
    }
    this.diag.source = "defaults"; this.diag.updatedAt = null; this.diag.readError = "invalid_settings_file";
    this.log("longvp_settings_read_error", { reason: this.diag.readError });
    return { document: initial, corrupt: bytes };
  }
  get(): Promise<SettingsDocument> {
    return this.serial(async () => {
      try { return (await this.read()).document; }
      catch {
        this.diag.readError = "settings_read_failed";
        this.log("longvp_settings_read_error", { reason: this.diag.readError });
        throw Error("settings_read_failed");
      }
    });
  }
  put(values: SettingsValues): Promise<SettingsDocument> {
    const input = structuredClone(values);
    return this.serial(async () => {
      if (Object.keys(validateSettings(input)).length) throw Error("invalid_settings");
      let temporary: string | null = null;
      try {
        const { corrupt } = await this.read();
        if (corrupt) {
          let backup: string;
          for (;;) {
            backup = path.join(path.dirname(this.file), `settings-longvp.corrupt-${this.stamp()}.json`);
            try {
              const handle = await fs.open(backup, "wx", 0o600);
              try { await handle.writeFile(corrupt); await handle.sync(); } finally { await handle.close(); }
              break;
            }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
          }
          if (!(await fs.readFile(backup)).equals(corrupt)) throw Error("backup_verification_failed");
          const name = this.cloud ? this.cloud.prefix + path.basename(backup) : backup;
          if (this.cloud) await uploadVerified(this.cloud.objects, name, backup);
          this.diag.preservedFiles.push(name);
          this.log("longvp_settings_corrupt_preserved", { file: name, bytes: corrupt.length });
        }
        const doc: SettingsDocument = { version: 1, values: input, updatedAt: this.stamp() };
        temporary = this.file + `.${doc.updatedAt}.tmp`;
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(doc) + "\n"); await handle.sync(); }
        finally { await handle.close(); }
        // Never acknowledge a cloud save before upload and independent verification.
        if (this.cloud) await uploadVerified(this.cloud.objects, this.cloud.prefix + "settings-longvp.json", temporary);
        await fs.rename(temporary, this.file); temporary = null;
        this.diag.source = "saved"; this.diag.updatedAt = doc.updatedAt;
        this.diag.readError = this.diag.saveError = null;
        this.log("longvp_settings_saved", { updatedAt: doc.updatedAt });
        return structuredClone(doc);
      } catch {
        this.diag.saveError = "settings_save_failed";
        this.log("longvp_settings_save_error", { reason: this.diag.saveError });
        throw Error("settings_save_failed");
      } finally {
        if (temporary) await fs.rm(temporary, { force: true }).catch(() => {
          this.log("longvp_settings_cleanup_error", { reason: "temporary_remove_failed" });
        });
      }
    });
  }
}

export function longVpSettingsRouter(store: LongVpSettings) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", async (_req, res) => {
    try { res.json(await store.get()); }
    catch { res.status(500).json({ error: "settings_read_failed" }); }
  });
  router.put("/", express.json({ limit: "8kb" }), async (req, res) => {
    const body: unknown = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => k !== "values")) {
      res.status(400).json({ error: "invalid_settings", fields: { _body: "valuesだけを送ってください" } }); return;
    }
    const values = (body as { values?: unknown }).values, fields = validateSettings(values);
    if (Object.keys(fields).length) { res.status(400).json({ error: "invalid_settings", fields }); return; }
    try { res.json(await store.put(values as SettingsValues)); }
    catch { res.status(500).json({ error: "settings_save_failed" }); }
  });
  router.use(((error, _req, res, _next) => {
    res.status(400).json({ error: "invalid_settings", fields: { _body:
      (error as { type?: string }).type === "entity.too.large" ? "本文が大きすぎます" : "正しいJSONを送ってください" } });
  }) as ErrorRequestHandler);
  return router;
}
