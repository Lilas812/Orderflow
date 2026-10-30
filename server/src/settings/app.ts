import * as fs from "node:fs/promises";
import { LocalSettings } from "./local.ts";
import type { SettingsPersistence, SettingsDiagnostics } from "./local.ts";
import type { SettingsValues } from "./schema.ts";
import { readDocument } from "./schema.ts";
import type { Log } from "../logger.ts";
import { uploadVerified } from "../store/objects.ts";
import type { Objects } from "../store/objects.ts";
import { settingsQueue, settingsStage } from "./trace.ts";
import { fetchSettingsFile } from "./fetch-file.ts";

/** Cloud is authoritative; local settings is only a staging file, never a fallback. */
export class AppSettings implements SettingsPersistence {
  private local: LocalSettings;
  private tail: Promise<unknown> = Promise.resolve();
  private error: string | null = null;
  private backups: string[] = [];
  private file: string;
  private objects: Objects;
  private prefix: string;
  private log: Log;
  constructor(file: string, objects: Objects, prefix: string, log: Log) {
    this.file = file; this.objects = objects; this.prefix = prefix; this.log = log;
    this.local = new LocalSettings(file, log);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const dequeued = settingsQueue("app");
    const next = this.tail.then(() => { dequeued(); return work(); });
    this.tail = next.catch(() => {}); return next;
  }
  private async fetch() {
    this.backups = (await fetchSettingsFile(this.objects, this.prefix, "settings", this.file))
      .filter(n => /^settings\.corrupt-\d+\.json$/.test(n.slice(this.prefix.length)));
  }
  get() {
    return this.serial(async () => {
      try {
        await settingsStage("cloud_fetch", () => this.fetch());
        this.error = null; return await this.local.get();
      }
      catch { this.error = "settings_read_failed"; this.log("settings_read_error", { reason: this.error }); throw Error(this.error); }
    });
  }
  put(values: SettingsValues) {
    return this.serial(async () => {
      try {
        await settingsStage("cloud_fetch", () => this.fetch());
        let corrupt = false;
        try {
          const bytes = await fs.readFile(this.file);
          try { corrupt = !readDocument(JSON.parse(bytes.toString("utf8"))); } catch { corrupt = true; }
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (corrupt) {
          const name = this.prefix + `settings.corrupt-${Date.now() * 1000}.json`;
          await uploadVerified(this.objects, name, this.file, undefined,
            (phase, work) => settingsStage(`backup_${phase}`, work));
          this.backups.push(name); this.log("settings_corrupt_preserved", { object: name, sha256Verified: true });
        }
        const doc = await this.local.put(values);
        await uploadVerified(this.objects, this.prefix + "settings.json", this.file, undefined, settingsStage);
        this.error = null;
        return doc;
      } catch {
        this.error = "settings_save_failed"; this.log("settings_save_error", { reason: this.error }); throw Error(this.error);
      }
    });
  }
  snapshot(): SettingsDiagnostics {
    const local = this.local.snapshot();
    return { ...local, readError: this.error === "settings_read_failed" ? this.error : local.readError,
      saveError: this.error === "settings_save_failed" ? this.error : local.saveError, preservedFiles: this.backups.slice() };
  }
}
