import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { DEFAULT_DISPLAY_SETTINGS, MAX_SETTINGS_BYTES, cloneSettings, validateDisplaySettings,
  type DisplaySettings, type SettingsSnapshot } from "../../../packages/core/src/settingsSchema";

export class SettingsStoreError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
/** Not a browser-supplied path. Outside every workspace static-root. */
export function settingsDirectory(workspace: string): string {
  const key = createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 24);
  return path.join(homedir(), ".local", "share", "orderflow-lab", key);
}
type FileIo = Pick<typeof fs, "mkdir" | "open" | "rename" | "unlink" | "lstat" | "readFile">;
/**
 * Single writer within the existing Vite process, optimistic revision CAS.
 * Injection is for fault tests, never exposed as an HTTP path/file interface.
 */
export class SettingsFileStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(private readonly directory: string, private readonly io: FileIo = fs) {
    this.file = path.join(directory, "display.v1.json");
  }
  private async read(): Promise<SettingsSnapshot> {
    try {
      const stat = await this.io.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new SettingsStoreError(500, "UNSAFE_SETTINGS_FILE");
      if (stat.size > MAX_SETTINGS_BYTES) throw new SettingsStoreError(500, "SETTINGS_FILE_TOO_LARGE");
      const text = await this.io.readFile(this.file, "utf8");
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new SettingsStoreError(500, "INVALID_SETTINGS_JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsStoreError(500, "INVALID_SETTINGS_FILE");
      const v = value as Record<string, unknown>;
      if (Object.keys(v).length !== 2 || !Object.hasOwn(v, "revision") || !Object.hasOwn(v, "settings")
        || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1) throw new SettingsStoreError(500, "INVALID_SETTINGS_FILE");
      try { validateDisplaySettings(v.settings); } catch { throw new SettingsStoreError(500, "INVALID_OR_UNSUPPORTED_SETTINGS_SCHEMA"); }
      return { revision: v.revision as number, persisted: true, settings: v.settings as DisplaySettings };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, persisted: false, settings: cloneSettings(DEFAULT_DISPLAY_SETTINGS) };
      if (e instanceof SettingsStoreError) throw e;
      throw new SettingsStoreError(500, "SETTINGS_READ_FAILED");
    }
  }
  load(): Promise<SettingsSnapshot> {
    return this.tail.then(() => this.read());
  }
  save(settings: DisplaySettings, expectedRevision: number): Promise<SettingsSnapshot> {
    // Clone/validate before queueing: callers cannot modify an in-flight save.
    let next: DisplaySettings;
    try {
      next = cloneSettings(validateDisplaySettings(settings));
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("revision");
    } catch { return Promise.reject(new SettingsStoreError(400, "INVALID_SETTINGS")); }
    const operation = this.tail.then(async () => {
      const previous = await this.read();
      if (previous.revision !== expectedRevision) throw new SettingsStoreError(409, "SETTINGS_CONFLICT");
      if (expectedRevision === Number.MAX_SAFE_INTEGER) throw new SettingsStoreError(409, "SETTINGS_REVISION_EXHAUSTED");
      const revision = expectedRevision + 1;
      const json = JSON.stringify({ revision, settings: next }, null, 2) + "\n";
      if (Buffer.byteLength(json) > MAX_SETTINGS_BYTES) throw new SettingsStoreError(413, "SETTINGS_TOO_LARGE");
      const temporary = path.join(this.directory, `.display-${randomUUID()}.tmp`);
      try {
        await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const dir = await this.io.lstat(this.directory);
        if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("Unsafe directory");
        const handle = await this.io.open(temporary, "wx", 0o600);
        try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
        await this.io.rename(temporary, this.file); // Commit point; old file untouched before success.
      } catch {
        await this.io.unlink(temporary).catch(() => {});
        throw new SettingsStoreError(500, "SETTINGS_WRITE_FAILED");
      }
      return { revision, persisted: true, settings: next };
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}
