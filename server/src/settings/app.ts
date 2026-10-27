import * as fs from "node:fs/promises";
import path from "node:path";
import { LocalSettings } from "./local.ts";
import type { SettingsPersistence, SettingsDiagnostics } from "./local.ts";
import type { SettingsValues } from "./schema.ts";
import { readDocument } from "./schema.ts";
import type { Log } from "../logger.ts";
import { uploadVerified } from "../store/objects.ts";
import type { Objects } from "../store/objects.ts";

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
    const next = this.tail.then(work); this.tail = next.catch(() => {}); return next;
  }
  private async fetch() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    if (await this.objects.exists(this.prefix + "settings.json")) {
      await this.objects.download(this.prefix + "settings.json", this.file + ".cloud");
      await fs.rename(this.file + ".cloud", this.file);
    } else await fs.rm(this.file, { force: true });
    this.backups = (await this.objects.list(this.prefix + "settings.corrupt-"))
      .filter(n => /^settings\.corrupt-\d+\.json$/.test(n.slice(this.prefix.length)));
  }
  get() {
    return this.serial(async () => {
      try { await this.fetch(); this.error = null; return await this.local.get(); }
      catch { this.error = "settings_read_failed"; this.log("settings_read_error", { reason: this.error }); throw Error(this.error); }
    });
  }
  put(values: SettingsValues) {
    return this.serial(async () => {
      try {
        await this.fetch();
        let corrupt = false;
        try {
          const bytes = await fs.readFile(this.file);
          try { corrupt = !readDocument(JSON.parse(bytes.toString("utf8"))); } catch { corrupt = true; }
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (corrupt) {
          const name = this.prefix + `settings.corrupt-${Date.now() * 1000}.json`;
          await uploadVerified(this.objects, name, this.file);
          this.backups.push(name); this.log("settings_corrupt_preserved", { object: name, sha256Verified: true });
        }
        const doc = await this.local.put(values);
        await uploadVerified(this.objects, this.prefix + "settings.json", this.file);
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
