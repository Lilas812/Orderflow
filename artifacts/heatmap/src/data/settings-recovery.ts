import type { SettingsDocument } from "./settings.ts";

/** Retry an initial failed read when a real server connection becomes available.
 * No periodic polling and no clearing the warning before a successful read. */
export class SettingsRecovery {
  failed = false;
  private pending: Promise<void> | null = null;
  private load: () => Promise<SettingsDocument>;
  private apply: (doc: SettingsDocument) => void;
  private fail: (error: unknown) => void;
  constructor(load: () => Promise<SettingsDocument>, apply: (doc: SettingsDocument) => void,
    fail: (error: unknown) => void) {
    this.load = load; this.apply = apply; this.fail = fail;
  }
  read(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.load().then(doc => { this.failed = false; this.apply(doc); },
      error => { this.failed = true; this.fail(error); }).finally(() => { this.pending = null; });
    return this.pending;
  }
  connected(): Promise<void> { return this.failed ? this.read() : Promise.resolve(); }
}
