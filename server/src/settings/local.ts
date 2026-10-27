import * as fs from "node:fs/promises";
import path from "node:path";
import type { Log } from "../logger.ts";
import { defaults, readDocument, validateSettings } from "./schema.ts";
import type { SettingsDocument, SettingsValues } from "./schema.ts";

export interface SettingsDiagnostics {
  source: "saved" | "defaults"; updatedAt: number | null;
  readError: string | null; saveError: string | null; preservedFiles: string[];
}
export interface SettingsPersistence {
  get(): Promise<SettingsDocument>;
  put(values: SettingsValues): Promise<SettingsDocument>;
  snapshot(): SettingsDiagnostics;
}

/** Only settings owns these files. Market-data retention never traverses them. */
export class LocalSettings implements SettingsPersistence {
  private tail: Promise<void> = Promise.resolve();
  private lastStamp = 0;
  private diag: SettingsDiagnostics = { source: "defaults", updatedAt: null,
    readError: null, saveError: null, preservedFiles: [] };
  private file: string;
  private log: Log;
  private rename: typeof fs.rename;
  private now: () => number;

  constructor(file: string, log: Log, rename = fs.rename, now = Date.now) {
    this.file = file; this.log = log; this.rename = rename; this.now = now;
  }
  snapshot(): SettingsDiagnostics { return { ...this.diag, preservedFiles: [...this.diag.preservedFiles] }; }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.then(() => {}, () => {});
    return next;
  }
  private stamp(): number { return this.lastStamp = Math.max(this.now() * 1000, this.lastStamp + 1); }
  private defaultDoc(): SettingsDocument { return { version: 2, values: { ...defaults }, updatedAt: null }; }
  private async read() {
    try {
      const names = await fs.readdir(path.dirname(this.file));
      this.diag.preservedFiles = names.filter(n => /^settings\.corrupt-\d+\.json$/.test(n)).sort()
        .map(n => `data/${n}`);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    let bytes: Buffer;
    try { bytes = await fs.readFile(this.file); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.diag.source = "defaults"; this.diag.updatedAt = null; this.diag.readError = null;
      return { document: this.defaultDoc(), corrupt: null };
    }
    try {
      const doc = readDocument(JSON.parse(bytes.toString("utf8")));
      if (!doc) throw Error("invalid_file");
      this.diag.source = "saved"; this.diag.updatedAt = doc.updatedAt; this.diag.readError = null;
      return { document: doc, corrupt: null };
    } catch {
      if (this.diag.readError !== "invalid_settings_file") this.log("settings_read_error", { reason: "invalid_settings_file" });
      this.diag.source = "defaults"; this.diag.updatedAt = null; this.diag.readError = "invalid_settings_file";
      return { document: this.defaultDoc(), corrupt: bytes };
    }
  }
  get(): Promise<SettingsDocument> {
    return this.serial(async () => {
      try { return (await this.read()).document; }
      catch {
        this.diag.source = "defaults"; this.diag.updatedAt = null; this.diag.readError = "settings_read_failed";
        this.log("settings_read_error", { reason: "settings_read_failed" });
        return this.defaultDoc();
      }
    });
  }
  put(values: SettingsValues): Promise<SettingsDocument> {
    // Clone now: a caller cannot mutate its object while queued.
    const input = { ...values };
    return this.serial(async () => {
      if (Object.keys(validateSettings(input)).length) throw Error("invalid_settings");
      let temporary: string | null = null;
      try {
        const { corrupt } = await this.read();
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        if (corrupt) {
          let backup: string, handle: Awaited<ReturnType<typeof fs.open>>;
          for (;;) {
            backup = path.join(path.dirname(this.file), `settings.corrupt-${this.stamp()}.json`);
            try { handle = await fs.open(backup, "wx", 0o600); break; }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
          }
          try { await handle.writeFile(corrupt); await handle.sync(); } finally { await handle.close(); }
          if (!(await fs.readFile(backup)).equals(corrupt)) throw Error("backup_verification_failed");
          const name = `data/${path.basename(backup)}`;
          this.diag.preservedFiles.push(name);
          this.log("settings_corrupt_preserved", { file: name, bytes: corrupt.length });
        }
        const doc: SettingsDocument = { version: 2, values: input, updatedAt: this.stamp() };
        temporary = this.file + `.${doc.updatedAt}.tmp`;
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(doc) + "\n"); await handle.sync(); } finally { await handle.close(); }
        await this.rename(temporary, this.file);
        temporary = null;
        this.diag.source = "saved"; this.diag.updatedAt = doc.updatedAt;
        this.diag.readError = this.diag.saveError = null;
        this.log("settings_saved", { updatedAt: doc.updatedAt });
        return structuredClone(doc);
      } catch {
        this.diag.saveError = "settings_save_failed";
        this.log("settings_save_error", { reason: "settings_save_failed" });
        throw Error("settings_save_failed");
      } finally {
        // Remove only our unfinished write, never the original or preserved files.
        if (temporary) await fs.rm(temporary, { force: true }).catch(() => {
          this.log("settings_temp_cleanup_error", { reason: "temporary_remove_failed" });
        });
      }
    });
  }
}
