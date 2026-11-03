/** ISOLATED TEST I/O ONLY. Never connects to App Storage or any upstream. */
import * as fs from "node:fs/promises";
import { ObjectGenerationConflict, type Objects } from "../src/store/objects.ts";
export class LabelsCloudFixture implements Objects {
  data = new Map<string, { bytes: Buffer; generation: string }>();
  failRead = false; failWrite = false; writes = 0;
  async exists(name: string) { return this.data.has(name); }
  async list(prefix: string) { return [...this.data.keys()].filter(k => k.startsWith(prefix)); }
  async upload() { throw Error("test_requires_cas"); }
  async download(name: string, file: string) {
    const doc = this.data.get(name); if (!doc || this.failRead) throw Error("test_read_failed");
    await fs.writeFile(file, doc.bytes);
  }
  async downloadVersion(name: string, file: string, generation?: string) {
    if (this.failRead) throw Error("test_read_failed");
    const doc = this.data.get(name);
    if (generation && doc?.generation !== generation) throw new ObjectGenerationConflict();
    if (!doc) return null;
    await fs.writeFile(file, doc.bytes); return doc.generation;
  }
  async uploadConditional(name: string, file: string, generation: string) {
    if (this.failWrite) throw Error("test_write_failed");
    const bytes = await fs.readFile(file), old = this.data.get(name);
    if ((old?.generation ?? "0") !== generation) throw new ObjectGenerationConflict();
    const next = String(+(old?.generation ?? "0") + 1);
    this.data.set(name, { bytes, generation: next }); this.writes++; return next;
  }
}
